/**
 * One shape for "bound a promise that has no bound of its own" (issue #151).
 *
 * Three callers so far — the Docker admission probe, a Discord REST call, an
 * outbound GitHub request — and they want different things when the bound is
 * reached. The probe fails *open*: an unhealthy daemon must never wedge dispatch
 * behind a phantom memory ceiling (issue #115). A Discord call fails *closed*:
 * its callers log and move on, or own a retry. A GitHub request additionally
 * aborts the underlying connection. So this returns a sentinel rather than
 * throwing, and each caller decides what the timeout means.
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
