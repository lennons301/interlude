/**
 * The sweep's memory of a parked PR's check rollup (issue #130), as a pure
 * fold so the confirmation rule is testable without a sweep.
 *
 * A red rollup is only actionable once it has been seen twice in a row. The
 * failure that motivated the ticket sat beside an infrastructure-shaped one (a
 * Vercel deployment), and spending a bounded repair pass on a flake wastes the
 * one repair the ticket gets. One sweep of added latency buys that: the
 * decision (settled 2026-08-12) is two-sweep confirmation rather than re-running
 * the failed check, which would not help a non-Actions context anyway.
 */

import type { CheckRollupState } from "../../github/pull-requests";

/** One PR's consecutive-failing observation, tied to the head it was made at. */
export interface CheckObservation {
  /** The head SHA the count belongs to */
  headSha: string;
  /** Consecutive sweeps this head's rollup has been observed failing */
  sweepsFailing: number;
}

/**
 * Fold this sweep's rollup reading into the previous observation. Null means
 * "nothing to remember": the rollup is not failing (or could not be read), so
 * the run is re-polled next sweep and no repair is owed. A push that moves the
 * head restarts the count — a new commit's failure earns its own confirmation.
 */
export function observeCheckRollup(
  prev: CheckObservation | undefined,
  headSha: string,
  state: CheckRollupState
): CheckObservation | null {
  if (state !== "failing") return null;
  const sweepsFailing = prev?.headSha === headSha ? prev.sweepsFailing + 1 : 1;
  return { headSha, sweepsFailing };
}
