import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import * as schema from "@/db/schema";
import { createTestDb } from "@/test/create-test-db";
import { eq } from "drizzle-orm";
import type { Observation } from "../stream-recorder";
import type { QuotaObservation } from "@/lib/quota/rate-limit-event";

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
 * They started life asserting only what the *stream* contains. #167 now reads
 * the event, so the same bytes also pin what the orchestrator makes of it —
 * still without anything *acting* on it, which is #168's and #171's job.
 */

let testDb: ReturnType<typeof createTestDb>["db"];

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));

const { createOutputHandler } = await import("../output-parser");
const { createStreamRecorder } = await import("../stream-recorder");
const { getQuotaObservation } = await import("@/lib/quota/quota-store");

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

/** The lane a replay runs on. Named, not defaulted, because the quota row is
 * keyed by lane since issue #175 — the read below has to ask for the same one. */
const LANE_ID = "claude-subscription";

/**
 * Feed a fixture through the parser line by line, as the exec stream does.
 *
 * The quota sink is left at its default, so a replay writes the lane's quota
 * row exactly as a live turn would and `getQuotaObservation(LANE_ID)` can be
 * read afterwards — the wiring, not a stand-in for it.
 */
function replay(events: Record<string, unknown>[], taskId: string) {
  const observations: Observation[] = [];
  const recorder = createStreamRecorder((o) => observations.push(o));
  const handler = createOutputHandler(taskId, LANE_ID, recorder);
  for (const event of events) {
    handler.write(JSON.stringify(event) + "\n");
  }
  return { result: handler.flush(), observations };
}

/** The task feed as the replay left it — the comparison for "a stream with no
 * rate-limit event parses exactly as it did before". */
function feed(taskId: string) {
  return testDb
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.taskId, taskId))
    .all()
    .map((m) => ({ role: m.role, type: m.type, content: m.content }));
}

/** Every field of the turn result except the one #167 added. */
function withoutQuota(result: { rateLimit: QuotaObservation | null }) {
  const { rateLimit, ...rest } = result;
  void rateLimit;
  return rest;
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

describe("captured stream: the event reaches the turn result (issue #167)", () => {
  it("carries the rejection's fields, intact, off a real captured stream", () => {
    const { result } = replay(REJECTED, "task-rejected");

    expect(result.rateLimit).toMatchObject({
      status: "rejected",
      rateLimitType: "five_hour",
      resetsAt: new Date(1788310954 * 1000),
      isUsingOverage: false,
      // Absent on the wire, and absent here — the distinction #171 needs.
      utilization: null,
    });
    expect(result.rateLimit?.observedAt).toBeInstanceOf(Date);
  });

  it("carries the allowed capture's overage fields, which the schema omits", () => {
    // The two fields #165 found on the wire beyond #167's documented shape. A
    // reader written to the list alone would have dropped the pair #173 needs.
    const { result } = replay(ALLOWED, "task-allowed");

    expect(result.rateLimit).toMatchObject({
      status: "allowed",
      rateLimitType: "overage",
      overageStatus: "allowed",
      isUsingOverage: false,
      overageInUse: true,
    });
  });

  it("persists the observation as the lane's quota state", () => {
    // End to end through the default sink: what the dashboard will read.
    expect(getQuotaObservation(LANE_ID)).toBeNull();
    replay(REJECTED, "task-rejected");

    expect(getQuotaObservation(LANE_ID)).toMatchObject({
      status: "rejected",
      rateLimitType: "five_hour",
    });
  });

  it("keeps the last event of a turn, not the first", () => {
    // The CLI emits one per API attempt, and a turn that retried past a
    // warning into a rejection must not report itself as merely warned.
    const warning = {
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed_warning", rateLimitType: "seven_day", utilization: 91 },
    };
    replay([warning, ...REJECTED], "task-rejected");

    expect(getQuotaObservation(LANE_ID)).toMatchObject({ status: "rejected" });
  });

  it("parses a stream with no rate-limit event exactly as it did before", () => {
    // The regression this ticket could most easily cause: every other fact the
    // turn reports, and every message it wrote, identical with the event
    // removed. Nothing about the rest of the stream runs through the new path.
    // Stripped stream first, so "nothing was persisted" is a fact about this
    // replay and not about the order of the two.
    const withoutEvent = replay(
      ALLOWED.filter((e) => e.type !== "rate_limit_event"),
      "task-rejected"
    );
    expect(withoutEvent.result.rateLimit).toBeNull();
    expect(getQuotaObservation(LANE_ID)).toBeNull();

    const withEvent = replay(ALLOWED, "task-allowed");

    expect(withoutQuota(withoutEvent.result)).toEqual(withoutQuota(withEvent.result));
    expect(feed("task-rejected")).toEqual(feed("task-allowed"));
  });

  it("does not throw on an enum member from a future CLI, and shows it", () => {
    const { result } = replay(
      [
        {
          type: "rate_limit_event",
          rate_limit_info: { status: "throttled_soft", rateLimitType: "thirty_day_haiku" },
        },
      ],
      "task-allowed"
    );

    expect(result.rateLimit).toMatchObject({
      status: "throttled_soft",
      rateLimitType: "thirty_day_haiku",
    });
  });
});
