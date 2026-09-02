/**
 * How long past its window's reset a paused run waits before it is eligible
 * again (issue #169).
 *
 * An account-wide quota window is account-wide: every run the fleet paused was
 * refused by the *same* window and carries the *same* reset time, so without
 * this they all become eligible on the same sweep tick, race for the same
 * slots, and hit the freshly-reset window together — the stampede the ticket
 * asks to avoid.
 *
 * Derived from the run id rather than drawn at random, which matters more than
 * it looks: the reducer is pure, so a random offset would have to be an input
 * gathered per sweep, and it would then differ on every tick — a run could be
 * eligible at 12:01 and ineligible at 12:02. A hash of the id gives each run
 * its own fixed place in the window, stable across sweeps and across restarts,
 * with no clock and no state.
 *
 * A leaf module with no imports, so the spread can be tested — and reasoned
 * about — without the reducer.
 */

/** FNV-1a, 32-bit. Chosen for being short enough to read in one sitting: this
 * needs an even spread over a handful of ids, not a cryptographic one. */
function hash32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    // The FNV prime, by shifts, so the intermediate stays inside 32 bits.
    hash = (hash + (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) >>> 0;
  }
  return hash >>> 0;
}

/**
 * This run's offset into the jitter window, in milliseconds — always in
 * `[0, windowMs)`, and always the same for the same run.
 *
 * A non-positive window means no jitter at all, which is what a test (and an
 * operator who wants the fleet to move the instant the wall lifts) asks for by
 * setting it to zero.
 */
export function resumeJitterMs(runId: string, windowMs: number): number {
  if (!Number.isFinite(windowMs) || windowMs <= 0) return 0;
  return hash32(runId) % Math.floor(windowMs);
}

/** The instant a paused run may be tried again: its window's reset, plus its
 * own place in the jitter window. The one place the two are combined, so the
 * reducer and anything that explains a wait cannot disagree. */
export function resumeEligibleAt(
  runId: string,
  resumeAfter: Date,
  jitterWindowMs: number
): Date {
  return new Date(resumeAfter.getTime() + resumeJitterMs(runId, jitterWindowMs));
}
