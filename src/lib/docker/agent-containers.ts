/**
 * What agent containers actually exist, asked of the daemon rather than of the
 * orchestrator's own bookkeeping (issue #152).
 *
 * The fleet-health watchdog's pickup signals all read `occupiedSlots()`, so
 * when occupancy itself is the lie — a leaked reservation holding a slot with
 * no container behind it (#151) — the watchdog is silent by construction, on
 * the one input it trusts. This module is the reality it checks against, and
 * it owns the container-name prefix every counter of agent containers filters
 * on, so the census, the memory-admission probe and the stale-container reaper
 * can never disagree about what they are counting.
 */

import { getDocker } from "./client";
import { runBoundedProbe } from "../timeout";
import type { AgentContainerCensus } from "../fleet/health";

/** Every agent container's name starts with this — the one string that says
 * "this container belongs to a task". */
export const AGENT_CONTAINER_NAME_PREFIX = "interlude-task-";

/**
 * How long the census may wait on the daemon before giving up. Same bound and
 * same reasoning as the memory-admission probe (ADMISSION_PROBE_TIMEOUT_MS): a
 * hung daemon connection has no timeout of its own, and this one runs inside
 * the sweep — an unbounded call here would stall the whole decide-and-act loop
 * to observe a health signal.
 */
export const CONTAINER_CENSUS_TIMEOUT_MS = 5000;

/** Ask the daemon for every agent container and split it by whether it is
 * actually running. One listing, not two, so the two halves can never be read
 * a moment apart and disagree. */
async function probeAgentContainers(): Promise<AgentContainerCensus> {
  const containers = await getDocker().listContainers({
    all: true,
    filters: { name: [AGENT_CONTAINER_NAME_PREFIX] },
  });
  const live = containers.filter((c) => c.State === "running").length;
  return { live, stopped: containers.length - live };
}

/**
 * The reality half of the phantom-occupancy signal: what the daemon says is
 * really there, to corroborate the in-memory slot count that every other pickup
 * signal trusts.
 *
 * Returns null — *unknown* — on an error or a hang, never a number. The
 * distinction is the whole safety argument: a zero census reads as "the slots
 * are phantom, restart the app", so a daemon that cannot answer must say
 * nothing rather than be misread as saying none. `probe`/`timeoutMs` are
 * injectable for tests; production callers use the defaults.
 */
export async function observeAgentContainers(
  probe: () => Promise<AgentContainerCensus> = probeAgentContainers,
  timeoutMs: number = CONTAINER_CENSUS_TIMEOUT_MS
): Promise<AgentContainerCensus | null> {
  const outcome = await runBoundedProbe(probe, timeoutMs);
  if (outcome.ok) return outcome.value;
  if (outcome.reason === "timeout") {
    console.error(
      `[docker] agent-container census timed out after ${timeoutMs}ms — ` +
        `occupancy left uncorroborated this sweep`
    );
  } else {
    console.error("[docker] agent-container census failed:", outcome.error);
  }
  return null;
}
