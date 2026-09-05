/**
 * The boot-time lane-availability report (issue #226): which declared lanes
 * the orchestrator's environment cannot run, and the variables each lacks.
 *
 * Before this ticket the app config read two vendor credential variables by
 * name and warned "no agent auth configured" when both were absent — a
 * sentence that was only true of one harness on one provider, and that said
 * nothing about a third lane missing *its* variable. The lane file is the one
 * statement of which variables the fleet needs (`auth`, names only), so the
 * report is read off the catalog: one line per unavailable lane, naming the
 * lane and the variables, in the resolver's own wording — the line in the boot
 * log is the line a pass on that lane would fail with. When every lane is
 * available it says nothing.
 *
 * A report, not a gate: an unavailable lane is refused at pass start by
 * `resolveLane` (issue #172), and cost routing never sends a pass onto one
 * (#176). This only makes the state visible at the moment an operator is most
 * likely to be looking at the log.
 */

import type { LaneCatalog } from "./lane-config";
import {
  laneMissingEnv,
  laneUnavailableReason,
  missingEnvReason,
  type LaneEnv,
} from "./resolve";

export interface UnavailableLane {
  id: string;
  /** The orchestrator variables the lane names and the environment lacks. */
  missingEnvVars: string[];
}

/** Every declared lane the environment cannot run, in declaration order.
 * Empty when every lane is available. */
export function unavailableLanes(
  catalog: LaneCatalog,
  env: LaneEnv
): UnavailableLane[] {
  return catalog.lanes
    .map((lane) => ({ id: lane.id, missingEnvVars: laneMissingEnv(lane, env) }))
    .filter((lane) => lane.missingEnvVars.length > 0);
}

/** One line per unavailable lane, for the boot log — none when every lane is
 * available, so a fully configured fleet boots quietly. */
export function describeLaneAvailability(
  catalog: LaneCatalog,
  env: LaneEnv
): string[] {
  return unavailableLanes(catalog, env).map((lane) =>
    laneUnavailableReason(lane.id, missingEnvReason(lane.missingEnvVars))
  );
}
