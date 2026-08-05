/**
 * Slot capacity derived from what the Docker daemon reports, so a VPS resize
 * is understood at boot with no config change (Phase 5, issue #14).
 *
 * Defaults are tuned so the current CX22 (4 GB nominal, ~3.7-3.9 GiB as the
 * daemon reports it) derives 2 slots — today's practical ceiling. The spec's
 * illustrative ~1.5 GB reserve only yields 2 against the *nominal* 4096 MiB;
 * against the daemon's reported total it yields 1, so the reserve default is
 * 1 GiB (orchestrator + Caddy + system headroom) instead.
 */

import { getDocker } from "../docker/client";
import { getConfig } from "../config";

const MiB = 1024 * 1024;

export const DEFAULT_ORCHESTRATOR_RESERVE_MB = 1024;
export const DEFAULT_AGENT_MEMORY_MB = 1200;
export const DEFAULT_AGENT_CPUS = 1;

export interface DaemonInfo {
  /** Docker `info.MemTotal` — total memory in bytes as the daemon reports it */
  memTotalBytes: number;
  /** Docker `info.NCPU` */
  cpuCount: number;
}

export interface CapacityOverrides {
  /** Explicit slot count for when the derivation is wrong for a workload */
  slots?: number;
  /** Per-agent memory allocation in MiB — resizes the container cap and the slot divisor together */
  perAgentMemoryMb?: number;
}

export interface DerivedCapacity {
  /** Concurrent agent slots */
  slots: number;
  /** Hard memory limit per agent container, in bytes */
  perAgentMemory: number;
  /** Hard CPU limit per agent container, in NanoCpus (1e9 = one CPU) */
  cpuQuota: number;
}

export function deriveCapacity(
  daemon: DaemonInfo,
  overrides: CapacityOverrides = {}
): DerivedCapacity {
  const memoryOverride = overrides.perAgentMemoryMb;
  const perAgentMb =
    memoryOverride !== undefined && Number.isFinite(memoryOverride) && memoryOverride > 0
      ? memoryOverride
      : DEFAULT_AGENT_MEMORY_MB;
  const perAgentMemory = perAgentMb * MiB;
  const available = daemon.memTotalBytes - DEFAULT_ORCHESTRATOR_RESERVE_MB * MiB;
  const byMemory = Math.floor(available / perAgentMemory);
  const capped = Math.min(byMemory, daemon.cpuCount);
  const derived = Number.isFinite(capped) ? Math.max(1, capped) : 1;
  const override = overrides.slots;
  const slots =
    override !== undefined && Number.isInteger(override) && override >= 1
      ? override
      : derived;

  return { slots, perAgentMemory, cpuQuota: DEFAULT_AGENT_CPUS * 1e9 };
}

/**
 * Defense in depth for the OOM incident (issue #93): would starting one more
 * agent container overcommit host memory? Cgroup limits *cap* each container
 * but never *reserve* its memory, so the host OOMs on overcommit before any
 * single container hits its own cap — which is exactly how a 2-slot box ended
 * up with 4 live agent containers and thrashed. Pure, so the arithmetic is
 * unit-testable; `checkMemoryAdmission` gathers the live numbers from Docker.
 *
 * Uses the same figures `deriveCapacity` does: usable memory is the daemon's
 * reported total minus the orchestrator reserve, and each container is charged
 * its full per-agent allowance. The first container is always admitted — a box
 * too small to fit even one still runs a single task (`deriveCapacity` floors
 * slots at 1 for the same reason), trusting that container's own cgroup cap as
 * the backstop; the gate only bites once starting *another* would overcommit.
 */
export function wouldOvercommitMemory(input: {
  memTotalBytes: number;
  perAgentMemory: number;
  /** Agent containers already holding memory (running, not parked/stopped) */
  liveContainers: number;
}): boolean {
  if (input.liveContainers <= 0) return false;
  const available = input.memTotalBytes - DEFAULT_ORCHESTRATOR_RESERVE_MB * MiB;
  return (input.liveContainers + 1) * input.perAgentMemory > available;
}

/**
 * Ask the daemon how many agent containers are actually *running* and refuse
 * to start another when the live set plus the newcomer would overcommit host
 * memory (issue #93). Independent of the in-memory slot count, so it also
 * catches leaked or drifted containers the slot bookkeeping missed. Parked
 * containers are `docker stop`ped since #93, so they are correctly absent from
 * the running set and weigh nothing here.
 *
 * Fails open: a Docker probe error logs and allows, so a transient daemon
 * hiccup never wedges the queue behind a phantom memory ceiling.
 */
export async function checkMemoryAdmission(): Promise<{ ok: boolean; reason?: string }> {
  try {
    const docker = getDocker();
    const capacity = await getCapacity();
    const info = await docker.info();
    // Default listing (no `all`) returns only running containers — the ones
    // holding memory right now.
    const running = await docker.listContainers({
      filters: { name: ["interlude-task-"] },
    });
    const liveContainers = running.length;

    if (
      wouldOvercommitMemory({
        memTotalBytes: info.MemTotal,
        perAgentMemory: capacity.perAgentMemory,
        liveContainers,
      })
    ) {
      const perMb = Math.round(capacity.perAgentMemory / MiB);
      const usableMb = Math.round(
        (info.MemTotal - DEFAULT_ORCHESTRATOR_RESERVE_MB * MiB) / MiB
      );
      return {
        ok: false,
        reason: `${liveContainers} agent container(s) live × ${perMb} MiB + one more exceeds ~${usableMb} MiB usable`,
      };
    }
    return { ok: true };
  } catch (err) {
    console.error("[capacity] memory-admission probe failed, allowing start:", err);
    return { ok: true };
  }
}

/**
 * The seam callers consume instead of querying Docker directly — Phase 7's
 * on-demand remote compute answers the same question differently, so the
 * answer is async even though the local provider is not.
 */
export interface CapacityProvider {
  capacity: DerivedCapacity;
  isSlotAvailable(): Promise<boolean>;
}

export function createLocalCapacityProvider(
  capacity: DerivedCapacity,
  activeCount: () => number
): CapacityProvider {
  return {
    capacity,
    isSlotAvailable: async () => activeCount() < capacity.slots,
  };
}

let _capacity: DerivedCapacity | null = null;

/**
 * Capacity as derived at boot from the daemon's reported CPU and memory
 * (first call queries `docker info`; a VPS resize is picked up on restart).
 * `CAPACITY_SLOTS` overrides the slot count and `AGENT_MEMORY_MB` the
 * per-agent allocation when the derivation is wrong for a workload.
 */
export async function getCapacity(): Promise<DerivedCapacity> {
  if (_capacity) return _capacity;

  const info = await getDocker().info();
  const config = getConfig();
  _capacity = deriveCapacity(
    { memTotalBytes: info.MemTotal, cpuCount: info.NCPU },
    {
      slots: config.capacitySlots ?? undefined,
      perAgentMemoryMb: config.agentMemoryMb ?? undefined,
    }
  );
  return _capacity;
}
