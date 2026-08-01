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
  const perAgentMemory = DEFAULT_AGENT_MEMORY_MB * MiB;
  const available = daemon.memTotalBytes - DEFAULT_ORCHESTRATOR_RESERVE_MB * MiB;
  const derived = Math.max(
    1,
    Math.min(Math.floor(available / perAgentMemory), daemon.cpuCount)
  );
  const override = overrides.slots;
  const slots =
    override !== undefined && Number.isInteger(override) && override >= 1
      ? override
      : derived;

  return { slots, perAgentMemory, cpuQuota: DEFAULT_AGENT_CPUS * 1e9 };
}
