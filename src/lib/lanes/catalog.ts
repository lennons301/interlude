/**
 * Reading the checked-in lane file (issue #172) — the one impure half of
 * lanes, kept apart from the parser and the resolver so those stay testable
 * with no filesystem.
 *
 * The file is version-controlled configuration, not runtime state, so it is
 * read once and cached: it cannot change without a deploy, and re-reading it
 * per pass would only add a filesystem call to the hot path. (The *choice* of
 * lane, which a human changes while the fleet runs, lives on the settings row
 * instead and is deliberately re-read at the point of use.)
 *
 * A malformed file is not swallowed. `getLaneCatalog` reports the reason, and
 * the two kinds of caller answer it differently: a pass refuses to start (a
 * fleet that cannot say what it authenticates as must not run), while the
 * settings screen renders the reason so the operator can see what to fix.
 */

import fs from "fs";
import path from "path";
import { parseLaneConfig, type LaneConfigResult } from "./lane-config";

/** Repo root, alongside the other checked-in agent-facing configuration. The
 * production image copies it explicitly (see Dockerfile) — Next's standalone
 * output carries only what the bundle imports. */
export const LANE_CONFIG_FILE = "lanes.yaml";

let cached: LaneConfigResult | null = null;

/** The declared lanes, or the reason the file could not be read. Cached after
 * the first call. */
export function getLaneCatalog(): LaneConfigResult {
  if (cached) return cached;

  const file = path.join(process.cwd(), LANE_CONFIG_FILE);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    cached = {
      ok: false,
      reason:
        `could not read ${LANE_CONFIG_FILE}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    };
    return cached;
  }

  cached = parseLaneConfig(text);
  if (!cached.ok) {
    console.error(`[lanes] ${LANE_CONFIG_FILE} is unusable — ${cached.reason}`);
  }
  return cached;
}

/** Clear the cache so the next read hits the filesystem again — for tests. */
export function resetLaneCatalog(): void {
  cached = null;
}
