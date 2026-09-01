import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  createFileSink,
  createStreamRecorder,
  MAX_PAYLOAD_CHARS,
  MAX_RECORDS_PER_EVENT_TYPE,
  resolveObservationsPath,
  shouldRecordEventType,
  type Observation,
} from "../stream-recorder";

/**
 * The passive recorder is the half of the #165 spike that ships: when a real
 * quota wall arrives, the evidence has to be on disk whether or not anyone was
 * watching, because the one thing that cannot report a rate limit is the agent
 * that just hit one.
 *
 * Tested through an in-memory sink for the decisions and a temp directory for
 * the durable part, which is the seam the module is built around.
 */

function collect() {
  const observations: Observation[] = [];
  return { observations, sink: (o: Observation) => observations.push(o) };
}

const AT = () => new Date("2026-09-01T12:00:00.000Z");

describe("shouldRecordEventType", () => {
  it.each([
    // Recognised and acted on by the parser — noise in a forensic log.
    { type: "assistant", recorded: false },
    { type: "user", recorded: false },
    { type: "result", recorded: false },
    { type: "error", recorded: false },
    // `system` carries init and per-token chatter; it would drown the log.
    { type: "system", recorded: false },
    // Recognised but deliberately kept: this is the quota evidence #167 needs.
    { type: "rate_limit_event", recorded: true },
    // A future CLI version's new event type is exactly what this is for.
    { type: "post_turn_summary", recorded: true },
    { type: "api_metrics", recorded: true },
  ])("$type -> recorded=$recorded", ({ type, recorded }) => {
    expect(shouldRecordEventType(type)).toBe(recorded);
  });

  it("records an event carrying no type at all", () => {
    // A typeless event is the most unrecognised thing there is; the parser
    // silently drops it today.
    expect(shouldRecordEventType(null)).toBe(true);
  });
});

describe("createStreamRecorder", () => {
  it("keeps a rate_limit_event verbatim", () => {
    const { observations, sink } = collect();
    const recorder = createStreamRecorder(sink, AT);
    const event = {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "rejected",
        resetsAt: 1788310954,
        rateLimitType: "five_hour",
      },
    };

    recorder.streamEvent("task-1", event);

    expect(observations).toEqual([
      {
        at: "2026-09-01T12:00:00.000Z",
        kind: "stream-event",
        taskId: "task-1",
        eventType: "rate_limit_event",
        event: JSON.stringify(event),
      },
    ]);
    // Verbatim means round-trippable: the point of the log is that a later
        // reader can parse fields nobody thought to extract today.
    const logged = observations[0] as Extract<Observation, { kind: "stream-event" }>;
    expect(JSON.parse(logged.event)).toEqual(event);
  });

  it("ignores the event types the parser already handles", () => {
    const { observations, sink } = collect();
    const recorder = createStreamRecorder(sink, AT);

    recorder.streamEvent("task-1", { type: "assistant", message: {} });
    recorder.streamEvent("task-1", { type: "result", subtype: "success" });
    recorder.streamEvent("task-1", { type: "system", subtype: "thinking_tokens" });

    expect(observations).toEqual([]);
  });

  it("truncates an outsized payload and says that it did", () => {
    const { observations, sink } = collect();
    const recorder = createStreamRecorder(sink, AT);

    recorder.streamEvent("task-1", {
      type: "something_new",
      blob: "x".repeat(MAX_PAYLOAD_CHARS * 2),
    });

    const logged = observations[0] as Extract<Observation, { kind: "stream-event" }>;
    expect(logged.event).toHaveLength(MAX_PAYLOAD_CHARS);
    expect(logged.truncated).toBe(true);
  });

  it("caps a flooding event type and records that it stopped", () => {
    // The failure this guards against: a CLI upgrade starts emitting a new,
    // *frequent* event type and the forensic log becomes a firehose sharing a
    // volume with the fleet's database.
    const { observations, sink } = collect();
    const recorder = createStreamRecorder(sink, AT);

    for (let i = 0; i < MAX_RECORDS_PER_EVENT_TYPE + 50; i++) {
      recorder.streamEvent("task-1", { type: "chatty", i });
    }

    const events = observations.filter((o) => o.kind === "stream-event");
    const suppressed = observations.filter((o) => o.kind === "suppressed");
    expect(events).toHaveLength(MAX_RECORDS_PER_EVENT_TYPE);
    // Exactly one marker, so a capped type says "I stopped" once rather than
    // going quiet or replacing the flood with a flood of markers.
    expect(suppressed).toEqual([
      {
        at: "2026-09-01T12:00:00.000Z",
        kind: "suppressed",
        taskId: "task-1",
        eventType: "chatty",
        recorded: MAX_RECORDS_PER_EVENT_TYPE,
      },
    ]);
  });

  it("caps each (task, type) pair independently", () => {
    // One task flooding must not spend another task's budget, nor one event
    // type spend a different type's.
    const { observations, sink } = collect();
    const recorder = createStreamRecorder(sink, AT);

    for (let i = 0; i < MAX_RECORDS_PER_EVENT_TYPE + 5; i++) {
      recorder.streamEvent("task-1", { type: "chatty", i });
    }
    recorder.streamEvent("task-2", { type: "chatty", i: 0 });
    recorder.streamEvent("task-1", { type: "other", i: 0 });

    const events = observations.filter(
      (o) => o.kind === "stream-event"
    ) as Extract<Observation, { kind: "stream-event" }>[];
    expect(events.filter((e) => e.taskId === "task-2")).toHaveLength(1);
    expect(events.filter((e) => e.eventType === "other")).toHaveLength(1);
  });

  it("keeps a non-JSON line verbatim", () => {
    const { observations, sink } = collect();
    const recorder = createStreamRecorder(sink, AT);

    recorder.unparseableLine("task-1", "Error: Not logged in");

    expect(observations).toEqual([
      {
        at: "2026-09-01T12:00:00.000Z",
        kind: "unparseable-line",
        taskId: "task-1",
        line: "Error: Not logged in",
      },
    ]);
  });

  it("never lets a broken sink break the turn it is observing", () => {
    // This runs inside the stream-parse path of every turn the fleet runs, so a
    // full disk must cost an observation, not a pass.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const recorder = createStreamRecorder(() => {
      throw new Error("ENOSPC");
    }, AT);

    expect(() => recorder.streamEvent("task-1", { type: "new" })).not.toThrow();
    expect(() => recorder.unparseableLine("task-1", "junk")).not.toThrow();
    expect(() =>
      recorder.passExit("task-1", {
        resultArrived: false,
        terminalResult: null,
        execExitCode: 137,
        durationMs: 1,
      })
    ).not.toThrow();
    expect(spy).toHaveBeenCalledTimes(3);
    spy.mockRestore();
  });

  it("records a pass exit that produced no terminal result", () => {
    // The shape of an OOM, a lost stream, or a container torn down mid-turn —
    // which is exactly what a rate-limit pause (#168) will deliberately create.
    const { observations, sink } = collect();
    const recorder = createStreamRecorder(sink, AT);

    recorder.passExit("task-1", {
      resultArrived: false,
      terminalResult: null,
      execExitCode: 137,
      durationMs: 4200,
    });

    expect(observations).toEqual([
      {
        at: "2026-09-01T12:00:00.000Z",
        kind: "pass-exit",
        taskId: "task-1",
        exit: {
          resultArrived: false,
          terminalResult: null,
          execExitCode: 137,
          durationMs: 4200,
        },
      },
    ]);
  });

  it("distinguishes an unknown exit code from a zero one", () => {
    // 137 (OOM), 0 (clean) and null (the daemon would not say) are three
    // different facts, and a forensic log may not blur them.
    const { observations, sink } = collect();
    const recorder = createStreamRecorder(sink, AT);

    recorder.passExit("task-1", {
      resultArrived: true,
      terminalResult: { type: "result", subtype: "success" },
      execExitCode: null,
      durationMs: 1,
    });

    const logged = observations[0] as Extract<Observation, { kind: "pass-exit" }>;
    expect(logged.exit.execExitCode).toBeNull();
  });

  it("is never suppressed for a pass exit", () => {
    // One per turn by construction, and the record most worth having.
    const { observations, sink } = collect();
    const recorder = createStreamRecorder(sink, AT);

    for (let i = 0; i < MAX_RECORDS_PER_EVENT_TYPE + 10; i++) {
      recorder.passExit("task-1", {
        resultArrived: true,
        terminalResult: null,
        execExitCode: 0,
        durationMs: i,
      });
    }

    expect(observations).toHaveLength(MAX_RECORDS_PER_EVENT_TYPE + 10);
    expect(observations.every((o) => o.kind === "pass-exit")).toBe(true);
  });
});

describe("resolveObservationsPath", () => {
  it.each([
    // The VPS: beside the database on the durable volume.
    { databaseUrl: "/data/interlude.db", expected: "/data/stream-observations.jsonl" },
    // Local dev: beside the repo-root database.
    { databaseUrl: "local.db", expected: "stream-observations.jsonl" },
    { databaseUrl: undefined, expected: "stream-observations.jsonl" },
    {
      databaseUrl: "/var/lib/interlude/db.sqlite",
      expected: "/var/lib/interlude/stream-observations.jsonl",
    },
  ])("$databaseUrl -> $expected", ({ databaseUrl, expected }) => {
    expect(resolveObservationsPath(databaseUrl)).toBe(expected);
  });
});

describe("createFileSink", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "interlude-recorder-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const observation = (taskId: string): Observation => ({
    at: "2026-09-01T12:00:00.000Z",
    kind: "unparseable-line",
    taskId,
    line: "x".repeat(200),
  });

  it("appends one JSON object per line, and survives a fresh sink", () => {
    // Durability is the whole claim: a restarted orchestrator must append to
    // the same evidence rather than start a new file.
    const file = path.join(dir, "obs.jsonl");

    createFileSink(file)(observation("task-1"));
    createFileSink(file)(observation("task-2"));

    const lines = fs.readFileSync(file, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => JSON.parse(l).taskId)).toEqual(["task-1", "task-2"]);
  });

  it("creates a missing parent directory", () => {
    // `/data` exists on the VPS, but the db module makes the same guarantee for
    // itself rather than assuming it.
    const file = path.join(dir, "nested", "deeper", "obs.jsonl");

    createFileSink(file)(observation("task-1"));

    expect(fs.existsSync(file)).toBe(true);
  });

  it("rotates to .1 rather than growing without bound", () => {
    // It shares a volume with the fleet's database, so an unbounded log could
    // eventually cost the fleet its database.
    const file = path.join(dir, "obs.jsonl");
    const sink = createFileSink(file, 600);

    sink(observation("first"));
    sink(observation("second"));
    sink(observation("third"));

    // Oldest generation preserved, not discarded: the first unrecognised event
    // of a new CLI version is usually the interesting one.
    expect(fs.existsSync(`${file}.1`)).toBe(true);
    expect(fs.readFileSync(`${file}.1`, "utf-8")).toContain("first");
    expect(fs.readFileSync(file, "utf-8")).toContain("third");
    // Both generations stay bounded by the ceiling.
    expect(fs.statSync(file).size).toBeLessThanOrEqual(600);
  });
});
