/**
 * The bridge between the lane catalog and the settings layer (issue #172).
 *
 * The settings resolver is pure and knows nothing about lanes; it takes the
 * lane vocabulary as data (`SettingsContext`). This one-function module is
 * where that data is fetched, so the resolver keeps no filesystem dependency
 * and every caller that validates or reads a `primaryLane` override goes
 * through the same place.
 *
 * An unusable lane file yields an *empty* context rather than an empty lane
 * list: "no lanes are declared" and "I could not read the file" must not be
 * confused, and the difference decides whether a stored lane id is rejected as
 * unknown or left alone until the file is fixed.
 */

import { getLaneCatalog } from "./catalog";
import { laneIds } from "./lane-config";
import type { SettingsContext } from "../settings-resolver";

export function laneCatalogContext(): SettingsContext {
  const catalog = getLaneCatalog();
  return catalog.ok ? { laneIds: laneIds(catalog.catalog) } : {};
}
