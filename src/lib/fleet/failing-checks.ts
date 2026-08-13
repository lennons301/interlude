/**
 * Last check-rollup observation for each parked PR the sweep saw red (issue
 * #130), keyed by run id. The sweep already reads every parked PR's rollup to
 * decide whether a CI repair is owed — it records the failing names here, and
 * the read model (dashboard + digest) renders them without querying GitHub
 * itself. Failing check names are not derivable from DB rows, so they arrive by
 * the same route as the backlog / needs-human / fleet-health observations.
 *
 * Recorded wholesale each sweep: a run whose rollup went green (or that left the
 * parked set) simply isn't in the next snapshot, so a stale red never lingers.
 * Null until the first sweep records, which renders no failing-checks cards.
 *
 * Backed by globalThis for the same reason as those stores: a route handler may
 * load a separate module instance from the orchestrator context that writes.
 */

const globalForFailingChecks = globalThis as unknown as {
  __interludeFailingChecks?: Record<string, string[]>;
};

/** Record this sweep's failing-check names for every parked PR observed red. */
export function recordFailingChecks(byRun: Record<string, string[]>): void {
  globalForFailingChecks.__interludeFailingChecks = byRun;
}

/** Failing check names keyed by run id, or null if no sweep has recorded yet. */
export function getFailingChecks(): Record<string, string[]> | null {
  return globalForFailingChecks.__interludeFailingChecks ?? null;
}
