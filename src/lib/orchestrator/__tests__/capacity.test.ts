import { describe, it, expect } from "vitest";
import { createLocalCapacityProvider, deriveCapacity } from "../capacity";

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
