import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb } from "@/test/create-test-db";
import { projects } from "@/db/schema";

// GET /api/projects never serves a stored secret's value (issue #242): the
// Doppler token is a per-project service token and was returned in cleartext
// to anyone who could reach the host. The list route now masks it the way the
// single-project route always has, and the UI only asks whether it is set.
let testDb: ReturnType<typeof createTestDb>["db"];

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));

import { GET } from "@/app/api/projects/route";

describe("GET /api/projects", () => {
  beforeEach(() => {
    testDb = createTestDb().db;
  });

  it("masks a stored Doppler token and keeps an unset one null", async () => {
    const now = new Date();
    testDb
      .insert(projects)
      .values([
        { id: "01WITH", name: "with", dopplerToken: "dp.st.dev.REALSECRET", createdAt: now },
        { id: "01WITHOUT", name: "without", dopplerToken: null, createdAt: now },
      ])
      .run();

    const res = await GET();
    const body = JSON.stringify(await res.json());
    expect(body).not.toContain("REALSECRET");

    const rows = JSON.parse(body) as Array<{ id: string; dopplerToken: string | null }>;
    expect(rows.find((r) => r.id === "01WITH")?.dopplerToken).toBe("••••••••");
    expect(rows.find((r) => r.id === "01WITHOUT")?.dopplerToken).toBeNull();
  });
});
