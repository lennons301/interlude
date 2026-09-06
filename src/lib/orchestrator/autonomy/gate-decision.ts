/**
 * Carrying out a gate decision (issues #16, #238): what the executor does
 * once the reducer has said whether an agent-authored PR may merge without a
 * human.
 *
 * Extracted from the sweep when the gated path gained its disarm, so the two
 * executors can be driven over a real (in-memory, migrated) database with a
 * stand-in for the PR's auto-merge state — the way `paused-runs.ts` is —
 * rather than sitting private inside a module nothing can import under test.
 *
 * Two outcomes, one decided per head:
 *
 *  - **gated** (`gatePr`): disarm auto-merge, label `human-signoff`, land the
 *    run in `gated`, and say so on the issue. A human approves and merges.
 *  - **ungated** (`armAutoMerge`): arm auto-merge (squash), land the run in
 *    `reviewing`, and say so. The reviewer's approval lands it.
 *
 * A gate is re-decided on every head — a CI repair (#130) or an integration
 * repair (#54) pushes onto a PR the sweep already decided — so "ungated head,
 * then gated head" is an ordinary sequence, and the PR arrives at the gated
 * path *armed*. Before #238 the gated path never disarmed: it labelled, moved
 * the run and said "auto-merge left disarmed", true only of a PR gated on its
 * first head, and one PR whose repair touched a gated path merged on the
 * reviewer's approval past its `human-signoff` label. Now the gated executor
 * disarms **unconditionally** and first — everything that reduces automation
 * happens before anything else, the sweep's ordering everywhere — and the
 * comment says which it found. Unconditional rather than keyed on a fact
 * read at gather time, because that fact can be stale by execution (a
 * webhook-triggered sweep runs beside the interval one, and a human can
 * toggle the PR), and a stale "unarmed" would re-open the hole; the disarm
 * is idempotent, so the cost is one PR read on a gate that had nothing to
 * disarm. A disarm that fails leaves the run pending for the next sweep,
 * exactly as a failed label does.
 */

import { db } from "@/db";
import { runs } from "@/db/schema";
import { eq } from "drizzle-orm";
import { commentOnIssue, parseIssueRef } from "../../github/issues";
import {
  armAutoMergeSquash,
  disarmAutoMerge,
  getPrState,
  labelPr,
} from "../../github/pull-requests";
import type { Action } from "./decide";
import { HUMAN_SIGNOFF_LABEL } from "./gates";

/**
 * A gated PR: disarm auto-merge, label it human-signoff, record the matched
 * categories on the run, and say so on the issue. The disarm goes first and
 * the label second — if either fails, the run stays pending and the next
 * sweep retries the whole step, so nothing is ever labelled gated while
 * still armed. Moving to `gated` clears any previous cycle's verdict: the
 * review pass that follows judges the PR as it now stands. A supervised
 * run's comment leads with the checkpoint — the decision the owner is being
 * waited on — rather than the (possibly empty) gate categories.
 */
export async function executeGatePr(
  action: Extract<Action, { type: "gatePr" }>
): Promise<void> {
  const ref = parseIssueRef(action.issueRef);
  if (!ref) return;

  const disarmed = await disarmAutoMerge(ref.owner, ref.repo, action.prNumber);
  if (!disarmed) return;
  const labeled = await labelPr(ref.owner, ref.repo, action.prNumber, HUMAN_SIGNOFF_LABEL);
  if (!labeled) return;

  db.update(runs)
    .set({
      status: "gated",
      gateCategories: action.categories,
      reviewVerdict: null,
      reviewResult: null,
      reviewedHeadSha: null,
    })
    .where(eq(runs.id, action.runId))
    .run();

  const gatedBy = [
    ...(action.checkpoint !== null ? ["checkpoint"] : []),
    ...action.categories,
  ];
  console.log(
    `[autonomy] Gated ${action.issueRef} PR #${action.prNumber}: ${gatedBy.join(", ")}` +
      (disarmed === "disarmed" ? " (auto-merge disarmed)" : "")
  );

  // What happened to auto-merge, said as it was found: a PR an earlier
  // ungated head armed has just been disarmed; one gated on its first head
  // never was.
  const autoMerge =
    disarmed === "disarmed" ? "auto-merge disarmed" : "auto-merge left disarmed";

  if (action.checkpoint !== null) {
    const lines = [
      `Checkpoint: this ticket runs supervised — PR #${action.prNumber} is labelled ` +
        `\`${HUMAN_SIGNOFF_LABEL}\` with ${autoMerge}, regardless of gate ` +
        `matches. A human approves and merges this one.`,
    ];
    if (action.checkpoint.trim()) {
      lines.push(`The decision waiting:\n\n> ${action.checkpoint.trim()}`);
    }
    if (action.categories.length > 0) {
      lines.push(`It also touches **${action.categories.join(", ")}**.`);
    }
    await commentOnIssue(action.issueRef, lines.join("\n\n"));
    return;
  }

  await commentOnIssue(
    action.issueRef,
    `Review gates: PR #${action.prNumber} touches **${action.categories.join(", ")}** — ` +
      `labelled \`${HUMAN_SIGNOFF_LABEL}\`, ${autoMerge}. A human approves and merges this one.`
  );
}

/**
 * An ungated PR: arm auto-merge (squash), move the run to `reviewing`, and
 * say so on the issue. The status flip is what hands the run to the review
 * machinery, and it clears any previous cycle's verdict. Arming an
 * already-armed PR (a crash between arm and flip, or a re-gate after a
 * fix-up cycle) is tolerated by re-reading the PR's state. Genuine arming
 * failure (e.g. auto-merge disabled on the repo) leaves the run pending for
 * the next sweep and is already logged by the GitHub helper.
 */
export async function executeArmAutoMerge(
  action: Extract<Action, { type: "armAutoMerge" }>
): Promise<void> {
  const ref = parseIssueRef(action.issueRef);
  if (!ref) return;

  let armed = await armAutoMergeSquash(ref.owner, ref.repo, action.prNumber);
  if (!armed) {
    const pr = await getPrState(ref.owner, ref.repo, action.prNumber);
    armed = pr?.autoMergeArmed === true;
  }
  if (!armed) return;

  db.update(runs)
    .set({
      status: "reviewing",
      gateCategories: [],
      reviewVerdict: null,
      reviewResult: null,
      reviewedHeadSha: null,
    })
    .where(eq(runs.id, action.runId))
    .run();

  console.log(`[autonomy] Armed auto-merge on ${action.issueRef} PR #${action.prNumber}`);
  await commentOnIssue(
    action.issueRef,
    `Review gates: PR #${action.prNumber} matched no gates — auto-merge (squash) armed; ` +
      `an approving review will land it.`
  );
}
