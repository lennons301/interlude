import { describe, it, expect } from "vitest";
import {
  createLocalCapacityProvider,
  deriveCapacity,
  wouldOvercommitMemory,
} from "../capacity";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

describe("deriveCapacity", () => {
  // Slot derivation: (memTotal - orchestrator reserve) / per-agent allocation,
  // capped by CPU count, minimum 1.
  it.each([
    {
      name: "CX22 nominal (4 GiB, 2 vCPU) yields 2 — today's practical ceiling",
      daemon: { memTotalBytes: 4 * GiB, cpuCount: 2 },
      slots: 2,
    },
    {
      name: "CX22 as the daemon actually reports it (~3.8 GiB) still yields 2",
      daemon: { memTotalBytes: 4_000_000_000, cpuCount: 2 },
      slots: 2,
    },
    {
      name: "resize to CX32 (8 GiB, 4 vCPU) changes the answer: memory allows 5, CPU caps at 4",
      daemon: { memTotalBytes: 8 * GiB, cpuCount: 4 },
      slots: 4,
    },
    {
      name: "memory-only resize (8 GiB, still 2 vCPU) stays CPU-capped at 2",
      daemon: { memTotalBytes: 8 * GiB, cpuCount: 2 },
      slots: 2,
    },
    {
      name: "a box too small for the formula (2 GiB, 1 vCPU) still gets the minimum of 1",
      daemon: { memTotalBytes: 2 * GiB, cpuCount: 1 },
      slots: 1,
    },
    {
      name: "a daemon reporting garbage still yields the minimum of 1, never NaN",
      daemon: { memTotalBytes: NaN, cpuCount: 0 },
      slots: 1,
    },
  ])("$name", ({ daemon, slots }) => {
    expect(deriveCapacity(daemon).slots).toBe(slots);
  });

  it("an explicit slots override replaces the derivation for when it is wrong for a workload", () => {
    const capacity = deriveCapacity(
      { memTotalBytes: 4 * GiB, cpuCount: 2 },
      { slots: 4 }
    );
    expect(capacity.slots).toBe(4);
  });

  it.each([{ slots: 0 }, { slots: -1 }, { slots: NaN }])(
    "an invalid slots override ($slots) is ignored rather than halting the fleet",
    (overrides) => {
      const capacity = deriveCapacity(
        { memTotalBytes: 4 * GiB, cpuCount: 2 },
        overrides
      );
      expect(capacity.slots).toBe(2);
    }
  );

  it("returns per-agent container limits: 1200 MiB of memory and 1 CPU in NanoCpus", () => {
    const capacity = deriveCapacity({ memTotalBytes: 4 * GiB, cpuCount: 2 });
    expect(capacity.perAgentMemory).toBe(1_258_291_200);
    expect(capacity.cpuQuota).toBe(1_000_000_000);
  });

  it("a per-agent memory override resizes the container cap and the slot divisor together", () => {
    const capacity = deriveCapacity(
      { memTotalBytes: 4 * GiB, cpuCount: 2 },
      { perAgentMemoryMb: 2000 }
    );
    expect(capacity.perAgentMemory).toBe(2000 * MiB);
    expect(capacity.slots).toBe(1);
  });

  it.each([{ perAgentMemoryMb: 0 }, { perAgentMemoryMb: -500 }, { perAgentMemoryMb: NaN }])(
    "an invalid per-agent memory override ($perAgentMemoryMb) is ignored",
    (overrides) => {
      const capacity = deriveCapacity(
        { memTotalBytes: 4 * GiB, cpuCount: 2 },
        overrides
      );
      expect(capacity.perAgentMemory).toBe(1_258_291_200);
      expect(capacity.slots).toBe(2);
    }
  );
});

describe("wouldOvercommitMemory", () => {
  // Defense in depth for issue #93: cgroup limits cap each container but never
  // reserve memory, so the host OOMs on overcommit before any one container
  // hits its cap. The check charges each container (the live set plus the one
  // about to start) its full per-agent allowance against usable memory
  // (MemTotal minus the 1 GiB orchestrator reserve deriveCapacity uses).
  const cx22 = deriveCapacity({ memTotalBytes: 4 * GiB, cpuCount: 2 });

  it.each([
    { live: 0, overcommit: false },
    { live: 1, overcommit: false },
    // The incident: a 2-slot box (usable ~3 GiB, 1200 MiB per agent) fits two
    // live containers; the third — the review that stacked on two parked
    // implements on 2026-08-04 — is refused before it can OOM the host.
    { live: 2, overcommit: true },
    { live: 3, overcommit: true },
  ])(
    "CX22 with $live live container(s) → overcommit=$overcommit",
    ({ live, overcommit }) => {
      expect(
        wouldOvercommitMemory({
          memTotalBytes: 4 * GiB,
          perAgentMemory: cx22.perAgentMemory,
          liveContainers: live,
        })
      ).toBe(overcommit);
    }
  );

  it("always admits the first container, even on a box too small to fit one (matches deriveCapacity's slot floor of 1)", () => {
    // 2 GiB box, 1 GiB reserve → ~1 GiB usable, less than a 1200 MiB agent. The
    // box must still run a single task (its own cgroup cap is the backstop);
    // only a second start is refused.
    expect(
      wouldOvercommitMemory({ memTotalBytes: 2 * GiB, perAgentMemory: 1200 * MiB, liveContainers: 0 })
    ).toBe(false);
    expect(
      wouldOvercommitMemory({ memTotalBytes: 2 * GiB, perAgentMemory: 1200 * MiB, liveContainers: 1 })
    ).toBe(true);
  });

  it("a larger per-agent allowance admits fewer containers, in step with the slot divisor", () => {
    // 2000 MiB per agent yields deriveCapacity slots=1 on the same box — so the
    // second container (one live, one more) must be refused.
    const perAgentMemory = 2000 * MiB;
    expect(
      wouldOvercommitMemory({ memTotalBytes: 4 * GiB, perAgentMemory, liveContainers: 0 })
    ).toBe(false);
    expect(
      wouldOvercommitMemory({ memTotalBytes: 4 * GiB, perAgentMemory, liveContainers: 1 })
    ).toBe(true);
  });
});

describe("capacity provider", () => {
  const twoSlots = deriveCapacity({ memTotalBytes: 4 * GiB, cpuCount: 2 });

  it("reports a slot available while active agents are below the slot count", async () => {
    const provider = createLocalCapacityProvider(twoSlots, () => 1);
    await expect(provider.isSlotAvailable()).resolves.toBe(true);
  });

  it("reports no slot once every slot is occupied", async () => {
    const provider = createLocalCapacityProvider(twoSlots, () => 2);
    await expect(provider.isSlotAvailable()).resolves.toBe(false);
  });

  it("frees a slot when an active agent finishes", async () => {
    let active = 2;
    const provider = createLocalCapacityProvider(twoSlots, () => active);
    await expect(provider.isSlotAvailable()).resolves.toBe(false);
    active = 1;
    await expect(provider.isSlotAvailable()).resolves.toBe(true);
  });
});
