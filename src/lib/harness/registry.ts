/**
 * Which adapters exist (issue #172). Its own module rather than a table inside
 * the one adapter that ships: registering a second harness should be an edit
 * here, not an edit to `claude-code.ts`, which has no business knowing what
 * else the fleet can run.
 *
 * Before registering one, read the stated limit at the foot of `adapter.ts`'s
 * module note (issue #199): a lane move — a failover or an early resume of a
 * paused run — carries the pass's session transcript across lanes, and it can
 * only do so between lanes on the *same* adapter. A second adapter makes
 * cross-adapter moves possible, and those must fall back to restarting on the
 * branch; `restoreSessionTranscript` is where that fallback belongs.
 */

import type { HarnessAdapter } from "./adapter";
import { claudeCodeAdapter } from "./claude-code";

const ADAPTERS: Readonly<Record<string, HarnessAdapter>> = {
  [claudeCodeAdapter.id]: claudeCodeAdapter,
};

/**
 * The adapter a resolved lane names. Throws rather than defaulting: a lane
 * whose adapter does not exist is a config error the parser already refuses,
 * so reaching here means the two have drifted and guessing would run the pass
 * on a harness nobody chose.
 */
export function getHarnessAdapter(id: string): HarnessAdapter {
  const adapter = ADAPTERS[id];
  if (!adapter) {
    throw new Error(
      `no harness adapter for "${id}" — known adapters: ${Object.keys(ADAPTERS).join(", ")}`
    );
  }
  return adapter;
}
