/**
 * Whether each harness's agent image is built (issue #219) — what the
 * execution-lane settings screen shows beside a lane's harness and its
 * credentials, so an unavailable lane is explained before a pass tries it.
 *
 * The image is the *adapter's* fact (`HarnessAdapter.image`, issue #214), not
 * the lane's: two lanes on one harness share one image, so the probe is made
 * once per adapter the lane file names and the screen joins on the lane's
 * adapter id. Impure by nature — it asks the Docker daemon — and bounded like
 * every other outbound call the orchestrator awaits (issue #151): a daemon
 * that does not answer inside the bound yields `built: null`, which the screen
 * renders as *unknown* rather than as "not built", because a guess dressed as
 * a verdict is the one answer a settings screen must never give (the same
 * rule the Docker status panel follows).
 *
 * Read on the app-router graph (the settings route), so it touches no
 * orchestrator memory; the registry it reads is a module-level table with no
 * state to split (issue #159).
 */

import { DOCKER_PROBE_TIMEOUT_MS } from "../docker/agent-containers";
import { probeImageBuilt } from "../docker/image-builder";
import { runBoundedProbe } from "../timeout";
import { getHarnessAdapter } from "./registry";

/** How long the settings screen waits on the daemon for one image. The same
 * bound the admission probe and the container census use. */
export const IMAGE_PROBE_TIMEOUT_MS = DOCKER_PROBE_TIMEOUT_MS;

export interface HarnessImageState {
  /** The adapter id, as a lane names it. */
  id: string;
  /** The image reference the adapter's containers run (`name:tag`). */
  image: string;
  /** Whether the daemon holds that image; null when it did not answer inside
   * the bound (or threw) — *unknown*, never "not built". */
  built: boolean | null;
}

/**
 * The image state of every adapter named, in the order given, each probed
 * once. Ids come from a parsed lane file, which the parser has already held
 * to the registered adapters, so an unknown id here is a drift between the
 * descriptor table and the registry — which `getHarnessAdapter` reports by
 * throwing, and `descriptors.test.ts` pins against.
 */
export async function readHarnessImageStates(
  adapterIds: Iterable<string>,
  timeoutMs: number = IMAGE_PROBE_TIMEOUT_MS
): Promise<HarnessImageState[]> {
  const ids = [...new Set(adapterIds)];
  return Promise.all(
    ids.map(async (id) => {
      const image = getHarnessAdapter(id).image.name;
      const outcome = await runBoundedProbe(() => probeImageBuilt(image), timeoutMs);
      return { id, image, built: outcome.ok ? outcome.value : null };
    })
  );
}
