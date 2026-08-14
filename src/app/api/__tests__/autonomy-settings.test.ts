import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb } from "@/test/create-test-db";

// The kill-switch endpoint (issue #118) against a from-migrations DB: what the
// settings screen calls, and what the autonomy sweep then reads.
let testDb: ReturnType<typeof createTestDb>["db"];

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));

import { GET, PATCH } from "@/app/api/settings/autonomy/route";
import { resetConfig } from "@/lib/config";
import { isGlobalAutonomyPaused } from "@/lib/settings";

function patch(body: unknown, raw?: string): Request {
  return new Request("http://test/api/settings/autonomy", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: raw ?? JSON.stringify(body),
  });
}

describe("PATCH /api/settings/autonomy", () => {
  beforeEach(() => {
    testDb = createTestDb().db;
  });

  it("reports the switch as lifted on a fresh install", async () => {
    const res = await GET();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      globalAutonomyPaused: false,
      updatedAt: null,
    });
  });

  it("engages the switch, and the sweep's own read agrees", async () => {
    const res = await PATCH(patch({ paused: true }));

    expect(res.status).toBe(200);
    const state = await res.json();
    expect(state.globalAutonomyPaused).toBe(true);
    expect(state.updatedAt).not.toBeNull();
    expect(isGlobalAutonomyPaused()).toBe(true);
  });

  it("lifts the switch again", async () => {
    await PATCH(patch({ paused: true }));
    const res = await PATCH(patch({ paused: false }));

    expect((await res.json()).globalAutonomyPaused).toBe(false);
    expect(isGlobalAutonomyPaused()).toBe(false);
  });

  it("rejects a non-boolean without touching the switch", async () => {
    await PATCH(patch({ paused: true }));

    const res = await PATCH(patch({ paused: "false" }));

    expect(res.status).toBe(400);
    expect(isGlobalAutonomyPaused()).toBe(true);
  });

  it("rejects a body with no flag at all", async () => {
    const res = await PATCH(patch({}));

    expect(res.status).toBe(400);
    expect(isGlobalAutonomyPaused()).toBe(false);
  });

  it("rejects an unparseable body", async () => {
    const res = await PATCH(patch(null, "not json"));

    expect(res.status).toBe(400);
    expect(isGlobalAutonomyPaused()).toBe(false);
  });

  it("reports the env boot master alongside the switch, independently of it", async () => {
    // The two are different controls: with AUTONOMY_ENABLED unset no sweep runs
    // at all, so lifting the switch cannot arm the fleet by itself. A caller
    // rendering this state needs to tell the two apart.
    const original = process.env.AUTONOMY_ENABLED;
    try {
      process.env.AUTONOMY_ENABLED = "true";
      resetConfig();
      await PATCH(patch({ paused: true }));
      expect(await (await GET()).json()).toMatchObject({
        globalAutonomyPaused: true,
        envMaster: true,
      });

      delete process.env.AUTONOMY_ENABLED;
      resetConfig();
      await PATCH(patch({ paused: false }));
      expect(await (await GET()).json()).toMatchObject({
        globalAutonomyPaused: false,
        envMaster: false,
      });
    } finally {
      if (original === undefined) delete process.env.AUTONOMY_ENABLED;
      else process.env.AUTONOMY_ENABLED = original;
      resetConfig();
    }
  });
});
