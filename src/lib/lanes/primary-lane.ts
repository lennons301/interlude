/**
 * Which lane the fleet is running on right now (issue #175) — the impure
 * half of `choosePrimaryLane`, in one place.
 *
 * Two callers need this and they must never disagree: the autonomy sweep, whose
 * admission gate (#171) is only allowed to judge the quota of the lane it is
 * about to spend on, and the dashboard, which names the same lane beside the
 * same reading. Two copies of "read the catalog, read the row, read the
 * environment" would be two chances to answer differently — and the answer
 * decides whether a metered lane is held behind the subscription's wall.
 *
 * The overrides are a **parameter**, not read here: both callers already read
 * the settings row once for everything else they take from it (the kill switch,
 * the quota threshold), and re-reading it would let this answer drift from the
 * one its caller made all its other decisions with, within a single tick.
 *
 * Deliberately `choosePrimaryLane` rather than `resolveLane`: this needs the
 * lane's *identity*, not its credentials. A lane whose secret is missing is
 * still the lane whose quota and prices apply, and it still has a name worth
 * putting on the screen — refusing to say so is `resolveLane`'s job, at the
 * point a pass would actually start.
 */

import { getLaneCatalog } from "./catalog";
import { findLane, type LaneDefinition } from "./lane-config";
import { choosePrimaryLane } from "./resolve";
import { getConfig } from "../config";
import type { SettingsOverrides } from "../settings-resolver";

/**
 * The lane in force, or null when `lanes.yaml` is unusable or names no lane.
 *
 * Null is not "no quota to worry about" — it is "we cannot say what this fleet
 * authenticates as", which every caller already has to treat as unknown rather
 * than as clear.
 */
export function currentPrimaryLane(
  overrides: SettingsOverrides
): LaneDefinition | null {
  const catalog = getLaneCatalog();
  if (!catalog.ok) return null;
  const choice = choosePrimaryLane({
    catalog: catalog.catalog,
    override: overrides.primaryLane ?? null,
    envLane: getConfig().agentLane,
    env: process.env,
  });
  return findLane(catalog.catalog, choice.laneId);
}
