/**
 * A lane pin (issue #241): the operator's explicit lane choice, scoped to one
 * task or one run instead of the whole fleet.
 *
 * The fleet already has exactly one notion of "the operator chose this lane":
 * the `primaryLane` settings override (or `AGENT_LANE`), which #172 honours
 * even when the lane is unavailable and which #176 treats as a pin that turns
 * cost routing off. A per-task pin is that same choice with a narrower scope,
 * so it is implemented as that same choice: the pass's crossing, ranking,
 * money guards and resolver are all evaluated against settings whose
 * `primaryLane` is the pinned lane, for that pass only. Nothing downstream
 * learns a second vocabulary, and everything that already held for a fleet
 * pin — a walled pinned lane still fails over (a pin is a preference, not a
 * refusal to move), a missing credential is reported rather than routed
 * around, the money guards still key off the lane's billing kind — holds for a
 * task pin by construction.
 *
 * Pure: settings in, settings out. The DB half (storing a pin for a ticket the
 * loop has not claimed yet) is `lane-pins.ts`.
 */

import type { FleetSettings } from "../settings";
import type { SettingsOverrides } from "../settings-resolver";
import { isLaneIdShaped } from "./lane-id";
import type { LaneCatalog } from "./lane-config";
import { findLane, laneIds } from "./lane-config";
import { laneMissingEnv, missingEnvReason, laneUnavailableReason, type LaneEnv } from "./resolve";

/** The overrides a pinned pass is judged against: the fleet's, with the pin
 * standing in as the operator's explicit lane. Identity when there is no pin. */
export function overridesPinnedTo(
  overrides: SettingsOverrides,
  lanePin: string | null | undefined
): SettingsOverrides {
  if (!lanePin) return overrides;
  return { ...overrides, primaryLane: lanePin };
}

/** The fleet settings a pinned pass is judged against — see `overridesPinnedTo`. */
export function settingsPinnedTo(
  settings: FleetSettings,
  lanePin: string | null | undefined
): FleetSettings {
  if (!lanePin) return settings;
  return { ...settings, overrides: overridesPinnedTo(settings.overrides, lanePin) };
}

export type LanePinCheck =
  | { ok: true; laneId: string }
  /** Not a lane at all — a shape or name nobody declared. An input error. */
  | { ok: false; status: 400; error: string }
  /** A declared lane the environment cannot run right now. A conflict the
   * operator resolves by setting the variable, not by retyping the request. */
  | { ok: false; status: 409; error: string };

/**
 * Whether a requested pin names a lane the fleet could actually run, judged
 * the way the resolver judges the primary lane (issue #172) so the words an
 * operator reads at entry are the words a pass would have failed with.
 */
export function checkLanePin(
  laneId: unknown,
  catalog: LaneCatalog | null,
  env: LaneEnv
): LanePinCheck {
  if (typeof laneId !== "string" || !isLaneIdShaped(laneId)) {
    return { ok: false, status: 400, error: "lane must be a lane id declared in lanes.yaml" };
  }
  if (catalog === null) {
    return { ok: false, status: 409, error: "lane cannot be pinned — lanes.yaml could not be read" };
  }
  const lane = findLane(catalog, laneId);
  if (lane === null) {
    return {
      ok: false,
      status: 400,
      error: `lane "${laneId}" is not declared in lanes.yaml — declared lanes: ${laneIds(catalog).join(", ")}`,
    };
  }
  const missing = laneMissingEnv(lane, env);
  if (missing.length > 0) {
    return { ok: false, status: 409, error: laneUnavailableReason(lane.id, missingEnvReason(missing)) };
  }
  return { ok: true, laneId: lane.id };
}
