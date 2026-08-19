/**
 * One shape for "bound a promise that has no bound of its own" (issue #151),
 * and the one place the race that does it is written.
 *
 * Callers want different things when the bound is reached. The Docker admission
 * probe fails *open*: an unhealthy daemon must never wedge dispatch behind a
 * phantom memory ceiling (issue #115). The agent-container census reports
 * *unknown*, so a daemon that cannot answer is never misread as answering
 * "none" (issue #152). A Discord REST call fails *closed*: its callers log and
 * move on, or own a retry. An outbound GitHub request additionally aborts the
 * underlying connection. So `raceWithTimeout` returns a sentinel rather than
 * throwing, and each caller decides what the timeout means.
 *
 * {@link runBoundedProbe} sits on top of it for the probe-shaped callers, which
 * additionally want a *rejection* folded into the same return shape. It is a
 * wrapper, not a second race — the subtle part stays written once.
 */

/** What the race resolves with when the bound is reached. A symbol, so it can
 * never collide with a value the awaited work might legitimately return. */
export const TIMED_OUT = Symbol("timed-out");

/**
 * Resolve with `work`'s value, or with {@link TIMED_OUT} once `timeoutMs` has
 * passed — whichever comes first. A rejection from `work` still propagates: the
 * bound covers waiting too long, not failing.
 *
 * Note this abandons the losing work rather than cancelling it; a caller with
 * something cancellable (an AbortController) should abort it on the sentinel.
 */
export async function raceWithTimeout<T>(
  work: Promise<T>,
  timeoutMs: number
): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Keep a losing (timed-out) promise's eventual rejection from surfacing as an
  // unhandled rejection once nothing awaits the race any more.
  work.catch(() => {});
  try {
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
      // Never a reason to hold the process open on its own.
      timer.unref?.();
    });
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** What asking a bounded probe produced: an answer, or one of the two ways of
 * not answering. `ok` is the outcome of *asking* — a probe whose answer is
 * itself a refusal still answered, and lands in `value`. */
export type BoundedProbeOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "timeout" }
  | { ok: false; reason: "error"; error: unknown };

/**
 * Run a probe against the bound above and report which of the three things
 * happened, so a dependency that stops answering can never freeze the caller.
 *
 * The orchestrator has been bitten by this three times (issues #115, #125,
 * #128): a hung Docker daemon connection has no timeout of its own, so an
 * awaited probe that never returns stalls whatever loop waits on it — the
 * queue's dispatch path, or the sweep's decide-and-act cycle. A *stall* is not
 * an error, so try/catch does not cover it; only the race does. Conversely a
 * rejection is not a stall, so the race does not cover it either. A probe's
 * caller has to decide what a non-answer means whichever way it arrives, which
 * is why both arrive here in one shape and neither is turned into a fallback:
 * memory admission fails *open*, the census reports *unknown*. Each caller owns
 * its own fallback and its own log line.
 */
export async function runBoundedProbe<T>(
  probe: () => Promise<T>,
  timeoutMs: number
): Promise<BoundedProbeOutcome<T>> {
  try {
    // Inside the try: a probe that throws synchronously is an error like any
    // other, not an exception that escapes the bound.
    const result = await raceWithTimeout(probe(), timeoutMs);
    return result === TIMED_OUT
      ? { ok: false, reason: "timeout" }
      : { ok: true, value: result };
  } catch (error) {
    return { ok: false, reason: "error", error };
  }
}
