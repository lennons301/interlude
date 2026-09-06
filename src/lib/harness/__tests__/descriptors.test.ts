import { describe, expect, it, vi } from "vitest";

// The registry pulls the Claude Code adapter in, and its stream parser writes
// to the feed; nothing here exercises it, so the DB is stubbed rather than
// opened.
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/config", () => ({
  getConfig: () => ({ maxTurns: 50, maxBudgetUsd: 20 }),
}));

import {
  HARNESS_ADAPTER_DESCRIPTORS,
  describeHarnessAdapter,
  harnessAdapterIds,
} from "../descriptors";
import {
  getHarnessAdapter,
  registerHarnessAdapter,
  registeredHarnessAdapterIds,
} from "../registry";
import { createFakeHarness } from "@/test/fake-harness";

/**
 * The descriptor table and the registry are two tables of the same fact
 * (issue #214): one the pure lane parser can read, one holding the adapters.
 * This pins them to each other, so an adapter cannot be registered without a
 * descriptor, nor described without being registered.
 */
describe("the adapter descriptor table and the registry (issue #214)", () => {
  it("describes exactly the adapters the registry holds, before any test registration", () => {
    expect([...registeredHarnessAdapterIds()].sort()).toEqual(
      [...harnessAdapterIds()].sort()
    );
  });

  it("gives every registered adapter the capabilities its descriptor declares", () => {
    for (const descriptor of HARNESS_ADAPTER_DESCRIPTORS) {
      expect(getHarnessAdapter(descriptor.id).capabilities).toEqual(
        descriptor.capabilities
      );
      expect(getHarnessAdapter(descriptor.id).id).toBe(descriptor.id);
    }
  });

  it("has unique ids", () => {
    const ids = harnessAdapterIds();
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("looks a descriptor up by id, and answers null for one it does not hold", () => {
    expect(describeHarnessAdapter("claude-code")?.capabilities.quotaTelemetry).toBe(true);
    // OpenCode ships (issue #222) and declares what it cannot do; Codex is #221's.
    expect(describeHarnessAdapter("opencode")?.capabilities).toEqual({
      userInvokedSkills: false,
      quotaTelemetry: false,
      reportsCost: false,
      sessionResume: true,
    });
    expect(describeHarnessAdapter("codex")).toBeNull();
  });

  it("does not describe the fake adapter — a lane file can never name it", () => {
    expect(describeHarnessAdapter("fake")).toBeNull();
  });
});

describe("registering an adapter under test", () => {
  it("makes it resolvable until unregistered, and refuses to shadow a shipped one", () => {
    const fake = createFakeHarness();
    const unregister = registerHarnessAdapter(fake.adapter);
    try {
      expect(getHarnessAdapter("fake")).toBe(fake.adapter);
      expect(() =>
        registerHarnessAdapter(createFakeHarness([], { id: "claude-code" }).adapter)
      ).toThrow(/already registered/);
    } finally {
      unregister();
    }
    expect(() => getHarnessAdapter("fake")).toThrow(/no harness adapter/);
    // Left as found: the pin above still holds after a registration.
    expect([...registeredHarnessAdapterIds()].sort()).toEqual(
      [...harnessAdapterIds()].sort()
    );
  });
});
