import { describe, expect, it, vi } from "vitest";

// The registry pulls the Claude Code adapter in, and its stream parser writes
// to the feed; nothing here exercises it, so the DB is stubbed rather than
// opened (the shape image-state.test.ts uses).
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/config", () => ({
  getConfig: () => ({ maxTurns: 50, maxBudgetUsd: 20 }),
}));

const daemon = vi.hoisted(() => ({
  up: true,
  probe: async (): Promise<boolean> => true,
  asked: [] as string[],
}));

vi.mock("@/lib/docker/client", () => ({
  isDockerAvailable: async () => daemon.up,
}));
vi.mock("@/lib/docker/image-builder", () => ({
  probeImageBuilt: (name: string) => {
    daemon.asked.push(name);
    return daemon.probe();
  },
}));

import { GET } from "@/app/api/settings/docker/route";
import { CLAUDE_CODE_IMAGE } from "@/lib/harness/claude-code/image";
import { registeredHarnessAdapterIds } from "@/lib/harness/registry";

/**
 * The environment readout (issue #119) since issue #216: one agent image per
 * registered harness adapter, each probed through the bounded probe the
 * execution-lane screen shares, so the two panels cannot disagree.
 */
describe("GET /api/settings/docker", () => {
  it("reports the daemon and one image row per registered adapter", async () => {
    daemon.up = true;
    daemon.asked.length = 0;
    daemon.probe = async () => true;

    const body = await (await GET()).json();

    expect(body.docker).toBe(true);
    expect(body.images).toEqual(
      registeredHarnessAdapterIds().map((id) => expect.objectContaining({ id, built: true }))
    );
    expect(body.images).toContainEqual({
      id: "claude-code",
      image: CLAUDE_CODE_IMAGE.name,
      built: true,
    });
    expect(daemon.asked).toContain(CLAUDE_CODE_IMAGE.name);
  });

  it("reports a positive 'not built' as false", async () => {
    daemon.probe = async () => false;
    const body = await (await GET()).json();
    expect(body.images.find((i: { id: string }) => i.id === "claude-code").built).toBe(false);
  });

  it("leaves every image unknown when the daemon does not answer — never 'not built'", async () => {
    daemon.up = false;
    daemon.probe = async () => {
      throw new Error("connect ENOENT /var/run/docker.sock");
    };
    const body = await (await GET()).json();
    expect(body.docker).toBe(false);
    expect(body.images.length).toBeGreaterThan(0);
    for (const image of body.images) expect(image.built).toBeNull();
  });
});
