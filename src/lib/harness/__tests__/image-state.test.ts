import { describe, expect, it, vi } from "vitest";

// The registry pulls the Claude Code adapter in, and its stream parser writes
// to the feed; nothing here exercises it, so the DB is stubbed rather than
// opened.
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/config", () => ({
  getConfig: () => ({ maxTurns: 50, maxBudgetUsd: 20 }),
}));

const probe = vi.hoisted(() => ({
  answer: async (): Promise<boolean> => true,
  asked: [] as string[],
}));

vi.mock("@/lib/docker/image-builder", () => ({
  probeImageBuilt: (name: string) => {
    probe.asked.push(name);
    return probe.answer();
  },
}));

import { readHarnessImageStates } from "../image-state";

/**
 * Per-harness image state for the settings screen (issue #219): one probe per
 * adapter, and a daemon that does not answer reads as *unknown* rather than as
 * "not built" — a screen must not dress a non-answer as a verdict.
 */
describe("readHarnessImageStates", () => {
  it("asks once per adapter, under the adapter's own image name", async () => {
    probe.asked.length = 0;
    probe.answer = async () => true;

    const states = await readHarnessImageStates(["claude-code", "claude-code"]);

    expect(states).toEqual([
      { id: "claude-code", image: "interlude-agent-claude-code:latest", built: true },
    ]);
    expect(probe.asked).toEqual(["interlude-agent-claude-code:latest"]);
  });

  it("reports a positive 'not built'", async () => {
    probe.answer = async () => false;

    expect((await readHarnessImageStates(["claude-code"]))[0].built).toBe(false);
  });

  it("reports unknown when the daemon throws, and when it does not answer in time", async () => {
    probe.answer = async () => {
      throw new Error("connect ENOENT /var/run/docker.sock");
    };
    expect((await readHarnessImageStates(["claude-code"]))[0].built).toBeNull();

    probe.answer = () => new Promise(() => {});
    expect((await readHarnessImageStates(["claude-code"], 20))[0].built).toBeNull();
  });

  it("reports nothing for no adapters", async () => {
    expect(await readHarnessImageStates([])).toEqual([]);
  });
});
