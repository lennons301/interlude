import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import * as schema from "@/db/schema";
import { createTestDb } from "@/test/create-test-db";
import type { Observation } from "../stream-recorder";

/**
 * Fixture-driven tests over two streams captured from the real Claude Code CLI
 * (2.1.257 — the version `Dockerfile.agent` installs), each carrying a
 * `rate_limit_event` (issue #165).
 *
 * Provenance, which matters because the milestone's later tickets will reason
 * from these bytes:
 *
 *  - `rate-limit-allowed-fixture.ndjson` — **observed against real quota**, on
 *    the subscription OAuth path the fleet actually uses. It answers the
 *    ticket's question directly: `rate_limit_event` *does* reach stdout under
 *    `--output-format stream-json --verbose`, as the second event of the
 *    stream, before any assistant output.
 *  - `rate-limit-rejected-fixture.ndjson` — **stub-derived**, produced by
 *    `scripts/rate-limit-stub.mjs` in its `session-limit-reached` scenario
 *    against the same binary and the same subscription auth. A real rejection
 *    could not be manufactured without burning the owner's five-hour window;
 *    the headers are the ones the CLI parses, so the event is genuine CLI
 *    output, but the fact that Anthropic would send exactly these headers is
 *    provisional.
 *
 * Both are verbatim, including the `system init` noise, deliberately: a fixture
 * somebody tidied is a fixture somebody could have tidied a fact out of.
 *
 * These assert what the *stream* contains, not what the orchestrator does with
 * it. Acting on the event is #167's job, and the assertions here are what it
 * gets to build against.
 */

let testDb: ReturnType<typeof createTestDb>["db"];

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));

const { createOutputHandler } = await import("../output-parser");
const { createStreamRecorder } = await import("../stream-recorder");

/** The parser writes messages as it goes, so every replay needs a task row to
 * hang them off. Same seeding as `output-parser.test.ts`. */
const PROJECT_ID = "test-project";
const TASK_IDS = ["task-allowed", "task-rejected"];

beforeEach(() => {
  testDb = createTestDb().db;
  testDb
    .insert(schema.projects)
    .values({ id: PROJECT_ID, name: "Test", createdAt: new Date() })
    .run();
  for (const id of TASK_IDS) {
    testDb
      .insert(schema.tasks)
      .values({
        id,
        projectId: PROJECT_ID,
        title: "Test task",
        status: "running",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();
  }
});

function loadFixture(name: string): Record<string, unknown>[] {
  return fs
    .readFileSync(path.join(__dirname, name), "utf-8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

const ALLOWED = loadFixture("rate-limit-allowed-fixture.ndjson");
const REJECTED = loadFixture("rate-limit-rejected-fixture.ndjson");

/** Feed a fixture through the parser line by line, as the exec stream does. */
function replay(events: Record<string, unknown>[], taskId: string) {
  const observations: Observation[] = [];
  const recorder = createStreamRecorder((o) => observations.push(o));
  const handler = createOutputHandler(taskId, recorder);
  for (const event of events) {
    handler.write(JSON.stringify(event) + "\n");
  }
  return { result: handler.flush(), observations };
}

function rateLimitInfo(events: Record<string, unknown>[]) {
  const event = events.find((e) => e.type === "rate_limit_event");
  return event?.rate_limit_info as Record<string, unknown> | undefined;
}

describe("captured stream: rate_limit_event reaches stdout", () => {
  it("the real-quota capture carries one, before any assistant output", () => {
    // The ticket's central question, and the reason no fallback signal is
    // needed: the event is there, second in the stream.
    const types = ALLOWED.map((e) => e.type);
    expect(types).toContain("rate_limit_event");
    expect(types.indexOf("rate_limit_event")).toBeLessThan(
      types.indexOf("assistant")
    );
  });

  it("the real-quota capture's event carries no utilization at all", () => {
    // Load-bearing for #171, whose admission gate is specified in terms of a
    // utilization threshold: on this account, in the allowed state, the field
    // simply is not there. It appears only when a window has a claim scoped to
    // it (see the stub-driven `allowed_warning` finding on #165), so the gate
    // needs a defined answer for "no utilization observed" rather than
    // treating absence as zero.
    const info = rateLimitInfo(ALLOWED)!;
    expect(info.status).toBe("allowed");
    expect(info).not.toHaveProperty("utilization");
  });

  it("the real-quota capture reports fields beyond the documented shape", () => {
    // #167 lists the event's fields from the CLI schema; the wire carries two
    // more. A parser written to the list alone would drop the pair that #173
    // needs to tell "walled" from "already spending real money".
    const info = rateLimitInfo(ALLOWED)!;
    expect(info).toMatchObject({
      status: "allowed",
      rateLimitType: "overage",
      isUsingOverage: false,
      overageInUse: true,
    });
  });

  it("the rejection capture carries the reset time a pause would resume from", () => {
    // #168 takes `resumeAfter` from here, so it has to actually be present on a
    // rejection — it is not present in the allowed capture above.
    const info = rateLimitInfo(REJECTED)!;
    expect(info).toMatchObject({
      status: "rejected",
      rateLimitType: "five_hour",
    });
    expect(typeof info.resetsAt).toBe("number");
  });
});

describe("captured stream: how a quota wall looks to the orchestrator today", () => {
  it("reports itself as a *successful* turn", () => {
    // The finding that most changes the milestone's premise. #164 assumes a
    // wall "fails like any other failure"; it does not. `subtype` is the only
    // field the orchestrator reads, and on a rejection it says "success", so
    // today an implement pass walled by quota looks like a pass that finished
    // having done nothing.
    const { result } = replay(REJECTED, "task-rejected");

    expect(result.subtype).toBe("success");
    expect(result.terminalResult).toMatchObject({
      is_error: true,
      terminal_reason: "api_error",
      api_error_status: 429,
    });
  });

  it("spent nothing, and says so", () => {
    // A rejected attempt costs no money, which is why #168 can say a quota
    // pause consumes neither an attempt nor budget without special-casing spend.
    const { result } = replay(REJECTED, "task-rejected");
    expect(result.costUsd).toBe(0);
  });

  it("carries the wall's explanation as the turn's final message", () => {
    // The coarse fallback signal, if the structured event ever stops arriving:
    // the CLI synthesises an assistant message carrying the limit text, and it
    // lands where the blocked-marker detector already looks.
    const { result } = replay(REJECTED, "task-rejected");
    expect(result.finalMessage).toMatch(/hit your session limit/);
  });

  it("distinguishes itself from a genuine success on every field but subtype", () => {
    // Side by side, so the one field that does not separate them is explicit.
    const walled = replay(REJECTED, "task-rejected").result;
    const clean = replay(ALLOWED, "task-allowed").result;

    expect(walled.subtype).toBe(clean.subtype);
    expect(clean.terminalResult).toMatchObject({
      is_error: false,
      terminal_reason: "completed",
      api_error_status: null,
    });
  });
});

describe("captured stream: the recorder keeps the evidence", () => {
  it("writes the rate_limit_event down verbatim, from a real stream", () => {
    // The shipped half of the spike, exercised end to end against captured
    // bytes: when a real wall arrives, this is what will be on disk.
    const { observations } = replay(REJECTED, "task-rejected");

    const recorded = observations.filter(
      (o): o is Extract<Observation, { kind: "stream-event" }> =>
        o.kind === "stream-event" && o.eventType === "rate_limit_event"
    );
    expect(recorded).toHaveLength(1);
    expect(JSON.parse(recorded[0].event)).toEqual(
      REJECTED.find((e) => e.type === "rate_limit_event")
    );
  });

  it("does not record the ordinary traffic either stream is made of", () => {
    // A forensic log that also captured every assistant message would be a
    // second transcript, on the volume holding the fleet's database.
    const { observations } = replay(ALLOWED, "task-allowed");

    const eventTypes = new Set(
      observations
        .filter(
          (o): o is Extract<Observation, { kind: "stream-event" }> =>
            o.kind === "stream-event"
        )
        .map((o) => o.eventType)
    );
    expect([...eventTypes]).toEqual(["rate_limit_event"]);
  });
});
