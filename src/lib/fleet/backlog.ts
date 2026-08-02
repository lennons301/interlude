/**
 * Last tracker observation of the ready-for-agent backlog, per project.
 * The autonomy sweep already lists armed issues every 30s — it records what
 * it saw here, and the read model (dashboard + digest) renders it without
 * ever querying GitHub itself. Null until the first observation: "unknown"
 * must stay distinguishable from a genuinely empty queue.
 *
 * Backed by globalThis for the same reason as the bot client (see
 * discord/notifications.ts): route handlers may load a separate module
 * instance from the orchestrator context that writes the observations.
 */

const globalForBacklog = globalThis as unknown as {
  __interludeBacklog?: Map<string, number>;
};

/** Record one project's unclaimed ready-for-agent count from a sweep. A
 * project whose listing failed simply isn't recorded — its last good
 * observation stands. */
export function recordBacklog(projectId: string, readyCount: number): void {
  const store = (globalForBacklog.__interludeBacklog ??= new Map());
  store.set(projectId, readyCount);
}

/** Counts keyed by project id, or null if the tracker was never observed */
export function getBacklogByProject(): Record<string, number> | null {
  const store = globalForBacklog.__interludeBacklog;
  return store ? Object.fromEntries(store) : null;
}
