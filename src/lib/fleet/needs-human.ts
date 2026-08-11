/**
 * Last tracker observation of the open `ready-for-human` issues, per project.
 * The autonomy sweep already lists a repo's issues every 30s — it records the
 * refs still open and labelled `ready-for-human` here, and the read model
 * (dashboard + digest) uses them to retire an exhausted needs-you card the
 * moment a human has dealt with the ticket, rather than waiting out the 7-day
 * recent window.
 *
 * At exhaustion the loop applies `ready-for-human` (issue #33's ledger); a
 * human then closes the issue (a merged fix does this) or drops the label to
 * re-route it. Either way the ref leaves this open+labelled set, which is the
 * signal that the "attempts exhausted" card no longer names an outstanding
 * action. The DB can't see the tracker on its own, so — exactly as with the
 * backlog observation — the sweep is the only thing that ever writes here.
 *
 * Null until the first observation: "unknown" must stay distinguishable from a
 * genuinely empty set, so an exhausted card is never cleared on a project the
 * sweep hasn't actually looked at (the 7-day window remains the safe fallback).
 *
 * Backed by globalThis for the same reason as the backlog store and the bot
 * client (see fleet/backlog.ts, discord/notifications.ts): route handlers may
 * load a separate module instance from the orchestrator context that writes
 * the observations.
 */

const globalForNeedsHuman = globalThis as unknown as {
  __interludeNeedsHuman?: Map<string, string[]>;
};

/** Record one project's open `ready-for-human` issue refs from a sweep. A
 * project whose listing failed simply isn't recorded — its last good
 * observation stands, so a transient API error can't wrongly clear its
 * exhausted cards. */
export function recordNeedsHuman(projectId: string, issueRefs: string[]): void {
  const store = (globalForNeedsHuman.__interludeNeedsHuman ??= new Map());
  store.set(projectId, issueRefs);
}

/** Open `ready-for-human` issue refs keyed by project id, or null if the
 * tracker was never observed. */
export function getNeedsHumanByProject(): Record<string, string[]> | null {
  const store = globalForNeedsHuman.__interludeNeedsHuman;
  return store ? Object.fromEntries(store) : null;
}
