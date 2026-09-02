/**
 * Which adapters exist (issue #172). Its own module rather than a table inside
 * the one adapter that ships: registering a second harness should be an edit
 * here, not an edit to `claude-code.ts`, which has no business knowing what
 * else the fleet can run.
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
