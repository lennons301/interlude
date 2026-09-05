/**
 * Which adapters exist (issues #172, #214). Its own module rather than a table
 * inside the one adapter that ships: registering a second harness should be an
 * edit here, not an edit to `claude-code/`, which has no business knowing what
 * else the fleet can run.
 *
 * Two registries would drift, so there is one table of *descriptors*
 * (`descriptors.ts` — ids and capabilities, a leaf the pure lane parser can
 * read) and one table of *adapters* (here), and `descriptors.test.ts` pins
 * them to each other: an adapter cannot be registered without a descriptor,
 * nor described without being registered. The `Record<HarnessAdapterId, …>`
 * below makes the first half a compile error as well.
 *
 * `registerHarnessAdapter` exists for one caller: the fake adapter tests
 * register (`src/test/fake-harness.ts`) so the turn manager and the reducer
 * can be driven through a whole turn without Claude Code or Docker. It is not
 * how a production adapter arrives — that is a row in the descriptor table and
 * an entry in `PRODUCTION_ADAPTERS` — and the pin test holds the registry to
 * the table before any test registration.
 *
 * Before registering one, read the limit at the foot of `adapter.ts`'s module
 * note (issues #199, #217): a lane move — a failover or an early resume of a
 * paused run — carries the pass's session across lanes only between lanes on
 * the *same* adapter. A second adapter makes cross-adapter moves possible, and
 * those start again on the branch: enforced at `restoreSessionTranscript` in
 * the turn manager through `decideSessionCarry`, with a system note telling
 * the owner. Nothing here changes for it — declare `sessionResume` honestly
 * and return the harness's own paths from `sessionArtifactPaths`.
 */

import type { HarnessAdapter } from "./adapter";
import type { HarnessAdapterId } from "./descriptors";
import { claudeCodeAdapter } from "./claude-code";

const PRODUCTION_ADAPTERS: Readonly<Record<HarnessAdapterId, HarnessAdapter>> = {
  "claude-code": claudeCodeAdapter,
};

const adapters = new Map<string, HarnessAdapter>(
  Object.values(PRODUCTION_ADAPTERS).map((adapter) => [adapter.id, adapter])
);

/**
 * The adapter a resolved lane names. Throws rather than defaulting: a lane
 * whose adapter does not exist is a config error the parser already refuses,
 * so reaching here means the two have drifted and guessing would run the pass
 * on a harness nobody chose.
 */
export function getHarnessAdapter(id: string): HarnessAdapter {
  const adapter = adapters.get(id);
  if (!adapter) {
    throw new Error(
      `no harness adapter for "${id}" — known adapters: ${registeredHarnessAdapterIds().join(", ")}`
    );
  }
  return adapter;
}

/** Every adapter id the registry currently answers for, in registration order. */
export function registeredHarnessAdapterIds(): string[] {
  return [...adapters.keys()];
}

/**
 * Register an adapter for the rest of this process — the test seam (see the
 * module note). Refuses an id already registered, because silently replacing
 * the Claude Code adapter is how a test would pass against a double while the
 * fleet ran the real thing. Returns the function that unregisters it, so a
 * test can leave the registry as it found it.
 */
export function registerHarnessAdapter(adapter: HarnessAdapter): () => void {
  if (adapters.has(adapter.id)) {
    throw new Error(`harness adapter "${adapter.id}" is already registered`);
  }
  adapters.set(adapter.id, adapter);
  return () => {
    adapters.delete(adapter.id);
  };
}
