/**
 * The sweep's reading of whether a parked run's posted review still stands for
 * the commit its PR now carries (issue #131), as a pure fold so the rule is
 * testable without a sweep.
 *
 * Until this existed, only the loop's own repair path invalidated a verdict:
 * any other push — a human clicking *Update branch*, a human commit, a `main`
 * merge — left the approval standing over code nobody reviewed, and an armed
 * run would auto-merge that head. The reviewed commit is recorded when the
 * orchestrator posts the verdict (runs.reviewedHeadSha) and compared with the
 * head `getPrState` already reads for the check rollup, so detecting movement
 * costs no extra API call.
 */

/** A PR head that has moved past the commit its posted verdict was about. */
export interface MovedHead {
  /** The head the verdict was written about */
  reviewedHeadSha: string;
  /** The head the PR carries now */
  headSha: string;
}

/**
 * Fold the PR's current head against the reviewed one. Null means "nothing to
 * act on": no verdict has been posted (nothing was reviewed, so nothing can be
 * stale), or the head is exactly the commit that was reviewed — which is the
 * no-churn rule, so an untouched PR costs nothing sweep after sweep.
 */
export function observeReviewedHead(
  reviewedHeadSha: string | null,
  headSha: string
): MovedHead | null {
  if (reviewedHeadSha == null) return null;
  if (reviewedHeadSha === headSha) return null;
  return { reviewedHeadSha, headSha };
}
