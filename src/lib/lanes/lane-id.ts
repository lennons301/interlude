/**
 * What a lane id looks like (issue #172). A leaf module with no imports,
 * because two layers need the shape and neither should drag the other in: the
 * lane parser validates the file's ids with it, and the settings resolver
 * validates a stored `primaryLane` override with it before any catalog is
 * available. Two copies of this pattern would drift, and the drift would show
 * up as a lane the file accepts and the settings row rejects.
 *
 * Bounded as well as shaped: membership in the real catalog is the check that
 * matters, and a caller that has no catalog still must not be able to park
 * something large in the settings row.
 */
export const LANE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Whether a written value is lane-id-shaped. Says nothing about whether such
 * a lane is declared — that is the catalog's answer. */
export function isLaneIdShaped(value: string): boolean {
  return LANE_ID_PATTERN.test(value);
}
