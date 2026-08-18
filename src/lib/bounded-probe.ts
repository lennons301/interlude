/**
 * Run a probe against a bound, so a dependency that stops answering can never
 * freeze the caller.
 *
 * The orchestrator has been bitten by this three times (issues #115, #125,
 * #128): a hung Docker daemon connection has no timeout of its own, so an
 * awaited probe that never returns stalls whatever loop is waiting on it — the
 * queue's dispatch path, or the sweep's decide-and-act cycle. A *stall* is not
 * an error, so try/catch does not cover it; only a race does.
 *
 * The outcome is returned rather than a fallback value, because the two probes
 * that use this want opposite things from a non-answer: memory admission fails
 * *open* (allow the start), the container census reports *unknown* (alarm on
 * nothing). Each caller owns its own fallback and its own log line; what they
 * share is the race, which is the subtle part.
 */

export type BoundedProbeOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "timeout" }
  | { ok: false; reason: "error"; error: unknown };

/** Sentinel the timeout resolves with, distinct from any value a probe can
 * return, so the race can tell "timed out" from a genuine answer. */
const TIMED_OUT = Symbol("bounded-probe-timeout");

export async function runBoundedProbe<T>(
  probe: () => Promise<T>,
  timeoutMs: number
): Promise<BoundedProbeOutcome<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Inside the try: a probe that throws synchronously is an error like any
    // other, not an exception that escapes the bound.
    const probePromise = probe();
    // Keep a losing (timed-out) probe's eventual rejection from surfacing as an
    // unhandled rejection once nothing awaits the race any more.
    probePromise.catch(() => {});
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    });
    const result = await Promise.race([probePromise, timeout]);
    return result === TIMED_OUT
      ? { ok: false, reason: "timeout" }
      : { ok: true, value: result };
  } catch (error) {
    return { ok: false, reason: "error", error };
  } finally {
    clearTimeout(timer);
  }
}
