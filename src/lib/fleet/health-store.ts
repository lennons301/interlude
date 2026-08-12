/**
 * Last fleet-health evaluation from the sweep (issue #126). The autonomy sweep
 * evaluates the three health signals every 30s and records them here; the read
 * model (dashboard + digest) surfaces them as needs-you cards. Backed by
 * globalThis for the same reason as the backlog / needs-human stores (see
 * fleet/backlog.ts, fleet/needs-human.ts): a route handler may load a separate
 * module instance from the orchestrator context that writes the observation.
 *
 * Null until the first sweep records — no health cards render before then, and
 * a redeploy re-arms every signal (acceptable for a watchdog, matching the
 * in-memory saturation/cap announcement flags in the sweep).
 */

import type { FleetHealthSignals } from "./health";

const globalForFleetHealth = globalThis as unknown as {
  __interludeFleetHealth?: FleetHealthSignals | null;
};

/** Record the current health signals from a sweep. */
export function recordFleetHealth(signals: FleetHealthSignals): void {
  globalForFleetHealth.__interludeFleetHealth = signals;
}

/** The last recorded health signals, or null if no sweep has run yet. */
export function getFleetHealth(): FleetHealthSignals | null {
  return globalForFleetHealth.__interludeFleetHealth ?? null;
}
