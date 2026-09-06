import fs from "fs";
import path from "path";

/**
 * Durable, verbatim capture of what a pass's stream said that we did not
 * understand, and of how the pass ended (issue #165).
 *
 * This is the part of the rate-limit spike that ships. The spike's other two
 * halves — the transcript round-trip and the rate-limit stub — are experiments
 * that answered a question once; this one answers it again every time, for
 * free. The reason it exists is the reason the spike could not simply "run
 * until it hits a wall and write up what happened": the agent doing the pass is
 * an LLM drawing on the same quota, so at the moment the wall arrives it is the
 * least able thing in the system to report it. The orchestrator is an ordinary
 * Node process reading stdout — it is not rate-limited, and it does not need to
 * be conscious at the moment of the wall. So it writes the evidence down
 * instead, and the provisional findings the stub produced can be confirmed
 * against a real wall later without anyone watching.
 *
 * Two things get recorded:
 *
 *  - **Unrecognised stream events**, verbatim. The parser handles a known set
 *    of event types and ignores the rest; a CLI upgrade that starts emitting
 *    something new is invisible today. `rate_limit_event` is recorded too, even
 *    though it is now recognised and read into fleet quota state (#167), for
 *    two reasons that outlive that ticket: the state row is latest-wins with no
 *    history, so this log is the only place a window's *shape over time* can be
 *    reconstructed from, and it is verbatim, so it also holds the fields this
 *    build does not model — which is how the stub-derived findings on #165 get
 *    confirmed against a real wall nobody was watching.
 *  - **Pass exit conditions**: whether a terminal `result` event arrived at
 *    all, what it said about itself, and the exec's exit code. A quota wall
 *    reports `subtype: "success"` with `is_error: true` (see the findings on
 *    #165), so the field the orchestrator reads today is precisely the one that
 *    does not distinguish it — which is why the whole terminal event is kept
 *    rather than a summary of it.
 *
 * Deliberately a file, not a table. It is append-only forensic evidence with no
 * reader in the app, verbatim payloads unsuited to columns, and it must survive
 * a restart — which the `/data` volume the SQLite database already lives on
 * gives for free, with no migration and no schema commitment made before #167
 * knows what shape it wants.
 */

/** One recorded observation, as it lands in the log. */
export type Observation =
  | {
      at: string;
      kind: "stream-event";
      taskId: string;
      /** The event's `type`, or null for an event that carried none. */
      eventType: string | null;
      /** The event verbatim, as JSON text — truncated only if outsized. */
      event: string;
      truncated?: true;
    }
  | {
      at: string;
      kind: "unparseable-line";
      taskId: string;
      /** The line verbatim — truncated only if outsized. */
      line: string;
      truncated?: true;
    }
  | {
      at: string;
      kind: "pass-exit";
      taskId: string;
      exit: RecordedPassExit;
    }
  | {
      at: string;
      kind: "suppressed";
      taskId: string;
      eventType: string | null;
      /** How many of this (task, type) pair were recorded before the cap. */
      recorded: number;
    };

/** How a pass ended, as observed from outside the agent — what the caller
 * hands in. */
export interface PassExit {
  /** Did a terminal `result` event arrive before the stream closed? `false` is
   * the interesting case: an OOM, a lost stream, or a container torn down
   * mid-turn — the shape a rate-limit *pause* will deliberately create. */
  resultArrived: boolean;
  /** The terminal `result` event, or null when none arrived. Kept whole because
   * the fields that distinguish a quota wall from a clean finish (`is_error`,
   * `terminal_reason`, `api_error_status`) are not the field the orchestrator
   * reads (`subtype`), and a summary written today would be written by someone
   * who did not yet know that. */
  terminalResult: Record<string, unknown> | null;
  /** The exec's exit code, or null when the daemon did not answer in time.
   * Null is not zero: 137 (OOM) and null (unknown) are different facts and a
   * forensic log may not blur them. */
  execExitCode: number | null;
  /** Wall time from exec start to the stream settling. */
  durationMs: number;
  /** Set when the orchestrator ended the turn at its wall-clock ceiling (issue
   * #220) — the one exit shape this process creates rather than observes, so
   * a forensic read can tell a hung harness the fleet stopped from one that
   * stopped itself. Absent, not false, on every other exit. */
  exceededWallClock?: true;
}

/** How a pass exit lands in the log. Identical to {@link PassExit} except that
 * the terminal event is serialized JSON text under the same payload cap as
 * every other verbatim capture — the agent's final message rides in that event,
 * and an unbounded line would put the log's ceiling in the hands of whatever
 * the agent last said. */
export interface RecordedPassExit extends Omit<PassExit, "terminalResult"> {
  terminalResult: string | null;
  terminalResultTruncated?: true;
}

/** Event types the first harness's stream parser already understands, whether
 * it acts on them (`assistant`, `user`, `result`, `error`) or deliberately
 * drops them (`system`, which carries init/hook/thinking-token chatter).
 * Anything outside this set is unrecognised and gets written down verbatim.
 * The second adapter's parser (issue #222) applies its own understanding
 * before forwarding — see its module note — so this set stays one harness's.
 *
 * `rate_limit_event` is deliberately *absent* despite being understood: see
 * {@link ALWAYS_RECORDED_EVENT_TYPES}. */
export const KNOWN_STREAM_EVENT_TYPES: ReadonlySet<string> = new Set([
  "assistant",
  "user",
  "result",
  "error",
  "system",
]);

/** Recognised, but recorded anyway, because it is the evidence the quota work
 * needs — verbatim and with history, which the single latest-wins state row
 * #167 keeps is neither — and it arrives at most a handful of times per turn. */
export const ALWAYS_RECORDED_EVENT_TYPES: ReadonlySet<string> = new Set([
  "rate_limit_event",
]);

/** Is this event type one the log wants? */
export function shouldRecordEventType(eventType: string | null): boolean {
  if (eventType === null) return true;
  if (ALWAYS_RECORDED_EVENT_TYPES.has(eventType)) return true;
  return !KNOWN_STREAM_EVENT_TYPES.has(eventType);
}

/** Cap on one recorded payload. Generous enough to keep a whole terminal
 * `result` event, small enough that one pathological event cannot dominate the
 * log. */
export const MAX_PAYLOAD_CHARS = 16_384;

/** Cap on how many observations one (task, event type) pair may write **within
 * one turn**. The guard against a CLI upgrade that starts emitting a *frequent*
 * new event type and turns a forensic log into a firehose: past the cap one
 * `suppressed` record is written and the rest are dropped, so the log still
 * says that it stopped rather than going quiet.
 *
 * Per turn, not per task, and that distinction is load-bearing: an interactive
 * session runs unboundedly many turns and emits a `rate_limit_event` on each,
 * so a per-task cap would quietly stop recording quota state after 25 turns —
 * and the event most likely to be lost is the last one, the rejection. The
 * turn's end is a signal the recorder already receives ({@link
 * StreamRecorder.passExit}), so the reset costs no new plumbing. */
export const MAX_RECORDS_PER_EVENT_TYPE = 25;

function truncate(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_PAYLOAD_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_PAYLOAD_CHARS), truncated: true };
}

/** Where an observation goes. One function, so the recorder's logic is testable
 * with no filesystem and the durable part is testable on its own. */
export type ObservationSink = (observation: Observation) => void;

export interface StreamRecorder {
  /** Record a parsed stream event if its type warrants it. */
  streamEvent(taskId: string, event: Record<string, unknown>): void;
  /** Record a stream line that was not JSON at all. */
  unparseableLine(taskId: string, line: string): void;
  /** Record how a pass ended. Never suppressed — one per turn. */
  passExit(taskId: string, exit: PassExit): void;
}

/** The key the per-(task, type) cap counts against for a non-JSON line. A
 * space-prefixed sentinel, so it can never collide with a real event type. */
const UNPARSEABLE_CAP_KEY = " unparseable";

/**
 * The recorder proper: decides *what* to write and writes it to a sink.
 *
 * Every method swallows its own errors. A forensic log that can break the pass
 * it is observing is worse than no log: this sits directly in the stream-parse
 * path, which is the hot path of every turn the fleet runs.
 */
export function createStreamRecorder(
  sink: ObservationSink,
  now: () => Date = () => new Date()
): StreamRecorder {
  // Per-process, not per-`globalThis`: the only caller is the stream-parse path
  // in the orchestrator's own module graph, so unlike the session maps of #159
  // there is no second copy for a route handler to disagree with. A duplicate
  // evaluation would at worst double the cap, never lose an observation.
  //
  // Nested by task so a turn's end can drop that task's counters in one step
  // without walking every other task's.
  const counts = new Map<string, Map<string, number>>();

  const guard = (body: () => void) => {
    try {
      body();
    } catch (err) {
      // One line, not a throw: this is best-effort evidence, and the turn it is
      // observing matters more than it does.
      console.error("[stream-recorder] failed to record observation:", err);
    }
  };

  /** Whether this observation is within its (task, type) cap for the current
   * turn, emitting the one-off `suppressed` marker on the transition past it. */
  const withinCap = (taskId: string, eventType: string | null): boolean => {
    let perType = counts.get(taskId);
    if (!perType) {
      perType = new Map<string, number>();
      counts.set(taskId, perType);
    }
    const key = eventType ?? "";
    const seen = perType.get(key) ?? 0;
    perType.set(key, seen + 1);
    if (seen < MAX_RECORDS_PER_EVENT_TYPE) return true;
    if (seen === MAX_RECORDS_PER_EVENT_TYPE) {
      sink({
        at: now().toISOString(),
        kind: "suppressed",
        taskId,
        eventType,
        recorded: MAX_RECORDS_PER_EVENT_TYPE,
      });
    }
    return false;
  };

  return {
    streamEvent(taskId, event) {
      guard(() => {
        const rawType = event?.type;
        const eventType = typeof rawType === "string" ? rawType : null;
        if (!shouldRecordEventType(eventType)) return;
        if (!withinCap(taskId, eventType)) return;
        const { text, truncated } = truncate(JSON.stringify(event));
        sink({
          at: now().toISOString(),
          kind: "stream-event",
          taskId,
          eventType,
          event: text,
          ...(truncated ? { truncated: true } : {}),
        });
      });
    },

    unparseableLine(taskId, line) {
      guard(() => {
        if (!withinCap(taskId, UNPARSEABLE_CAP_KEY)) return;
        const { text, truncated } = truncate(line);
        sink({
          at: now().toISOString(),
          kind: "unparseable-line",
          taskId,
          line: text,
          ...(truncated ? { truncated: true } : {}),
        });
      });
    },

    passExit(taskId, exit) {
      guard(() => {
        const { terminalResult, ...rest } = exit;
        const serialized =
          terminalResult === null ? null : truncate(JSON.stringify(terminalResult));
        sink({
          at: now().toISOString(),
          kind: "pass-exit",
          taskId,
          exit: {
            ...rest,
            terminalResult: serialized?.text ?? null,
            ...(serialized?.truncated ? { terminalResultTruncated: true } : {}),
          },
        });
      });
      // Never suppressed and always last: a turn's exit is the one record most
      // worth having, and it doubles as the turn boundary the per-turn cap
      // resets on. Outside `guard` on purpose — a sink that threw must still
      // release the next turn's budget, or one bad write silences a task for
      // the rest of the process's life.
      counts.delete(taskId);
    },
  };
}

/** Default log size before rotation, and the reason it is bounded at all: this
 * shares the `/data` volume with the SQLite database, so an unbounded forensic
 * log could eventually cost the fleet its database. Two generations are kept,
 * so the ceiling is twice this. */
export const MAX_LOG_BYTES = 8 * 1024 * 1024;

/**
 * Where the log lives: beside the SQLite database, so it inherits the durable
 * volume (`/data` on the VPS, the repo root in local dev) without introducing a
 * second piece of path configuration to get wrong.
 *
 * Pure, so the one thing worth checking — that it follows `DATABASE_URL`
 * wherever that points — is checkable without a filesystem.
 */
export function resolveObservationsPath(databaseUrl: string | undefined): string {
  const dbPath = databaseUrl ?? "local.db";
  return path.join(path.dirname(dbPath), "stream-observations.jsonl");
}

/**
 * A sink that appends JSONL to `filePath`, rotating to `<filePath>.1` once the
 * file passes `maxBytes`.
 *
 * Rotation rather than truncation because the interesting evidence is usually
 * the *oldest* thing in the window — the first unrecognised event of a new CLI
 * version, the exit condition before a wedge — and one generation of history is
 * the cheapest way not to throw that away the moment the log fills.
 */
export function createFileSink(
  filePath: string,
  maxBytes: number = MAX_LOG_BYTES
): ObservationSink {
  let ensuredDir = false;
  return (observation) => {
    const line = JSON.stringify(observation) + "\n";
    if (!ensuredDir) {
      const dir = path.dirname(filePath);
      if (dir !== "." && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      ensuredDir = true;
    }
    // Rotate *before* appending, so a single write can never carry the file
    // arbitrarily far past the ceiling.
    try {
      if (fs.statSync(filePath).size + line.length > maxBytes) {
        fs.renameSync(filePath, `${filePath}.1`);
      }
    } catch (err) {
      // ENOENT is the normal first-write case, not a problem.
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
    }
    fs.appendFileSync(filePath, line);
  };
}

let defaultRecorder: StreamRecorder | null = null;

/**
 * The process's recorder. Resolved lazily so `DATABASE_URL` is read when the
 * first observation is recorded rather than at import — the same reason the db
 * module reads it at construction, and what keeps importing this module free
 * for anything that never records.
 */
export function getStreamRecorder(): StreamRecorder {
  if (!defaultRecorder) {
    defaultRecorder = createStreamRecorder(
      createFileSink(resolveObservationsPath(process.env.DATABASE_URL))
    );
  }
  return defaultRecorder;
}
