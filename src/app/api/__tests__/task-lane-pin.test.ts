import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test/create-test-db";
import * as schema from "@/db/schema";
import { HARNESS_ADAPTER_DESCRIPTORS } from "@/lib/harness/descriptors";
import { parseLaneConfig, type LaneCatalog } from "@/lib/lanes/lane-config";
import {
  FAKE_HARNESS_ID,
  FAKE_NO_SKILLS_HARNESS_ID,
  fakeHarnessDescriptor,
  fakeNoSkillsDescriptor,
} from "@/test/fake-harness";

/**
 * The entry half of a lane pin (issue #241): `POST /api/tasks` with `lane`
 * pins that one task, judged at entry the way the resolver judges the fleet's
 * primary — refused before a row exists when the lane is not declared or not
 * runnable — and the operator route stores a pin for a ticket the loop has not
 * claimed yet, spent exactly once by the claim.
 *
 * Three lanes: two on the fake adapter (one subscription, one metered) and one
 * on the fake adapter that cannot invoke a skill. The fleet's primary is the
 * first; every pin here names another lane, so what is pinned is that the pin
 * — and only the pin — decides.
 */

let testDb: ReturnType<typeof createTestDb>["db"];
vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));

function catalog(): LaneCatalog {
  const parsed = parseLaneConfig(
    `
primary:
  - fake-a
lanes:
  - id: fake-a
    label: Fake A
    adapter: ${FAKE_HARNESS_ID}
    billing: subscription
    auth:
      FAKE_A_TOKEN: FAKE_A_TOKEN
    models:
      heavy: fake-heavy
      standard: fake-standard
      light: fake-light
  - id: fake-b
    label: Fake B (metered)
    adapter: ${FAKE_HARNESS_ID}
    billing: metered
    auth:
      FAKE_B_KEY: FAKE_B_KEY
    models:
      heavy: fake-heavy
      standard: fake-standard
      light: fake-light
    prices:
      heavy: { input: 1.0, output: 4.0, cache_read: 0.1 }
      standard: { input: 0.1, output: 0.4, cache_read: 0.01 }
      light: { input: 0.05, output: 0.2, cache_read: 0.005 }
    caps:
      daily_budget_usd: 20
  - id: no-skills
    label: No skills
    adapter: ${FAKE_NO_SKILLS_HARNESS_ID}
    billing: subscription
    auth:
      NO_SKILLS_TOKEN: NO_SKILLS_TOKEN
    models:
      heavy: other-big
      standard: other-mid
      light: other-small
`,
    [...HARNESS_ADAPTER_DESCRIPTORS, fakeHarnessDescriptor, fakeNoSkillsDescriptor]
  );
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.catalog;
}

vi.mock("@/lib/lanes/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/lanes/catalog")>();
  return {
    ...actual,
    getLaneCatalog: () => ({ ok: true, catalog: catalog() }),
  };
});

import { resetConfig } from "@/lib/config";
import { readLanePin, setLanePin, takeLanePin } from "@/lib/lanes/lane-pins";
import { POST as postProject } from "@/app/api/projects/route";
import { POST as postTask } from "@/app/api/tasks/route";
import {
  DELETE as deletePin,
  GET as getPin,
  PUT as putPin,
} from "@/app/api/projects/[id]/issues/[number]/lane/route";

const savedEnv = { ...process.env };

function jsonRequest(url: string, body: unknown, method = "POST"): Request {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function seedProject(): Promise<string> {
  const res = await postProject(jsonRequest("http://test/api/projects", { name: "Smoke" }));
  const { id } = await res.json();
  return id;
}

function taskRow(id: string) {
  return testDb.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get()!;
}

beforeEach(() => {
  testDb = createTestDb().db;
  process.env.FAKE_A_TOKEN = "a";
  process.env.FAKE_B_KEY = "b";
  process.env.NO_SKILLS_TOKEN = "n";
  delete process.env.AGENT_LANE;
  resetConfig();
});
afterEach(() => {
  process.env = { ...savedEnv };
  resetConfig();
});

describe("POST /api/tasks with a lane pin (issue #241)", () => {
  it("stores the pin on the task and nothing else changes for the fleet", async () => {
    const projectId = await seedProject();
    const res = await postTask(
      jsonRequest("http://test/api/tasks", { title: "Try B", projectId, lane: "fake-b" })
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.lanePin).toBe("fake-b");
    expect(taskRow(body.id).lanePin).toBe("fake-b");
    // A second task without a pin is an ordinary task.
    const plain = await postTask(jsonRequest("http://test/api/tasks", { title: "Plain", projectId }));
    expect((await plain.json()).lanePin).toBeNull();
  });

  it("treats an empty lane as no pin", async () => {
    const projectId = await seedProject();
    const res = await postTask(
      jsonRequest("http://test/api/tasks", { title: "Plain", projectId, lane: "" })
    );
    expect(res.status).toBe(201);
    expect((await res.json()).lanePin).toBeNull();
  });

  it("refuses a lane nobody declared as an input error naming the declared ones, creating nothing", async () => {
    const projectId = await seedProject();
    const res = await postTask(
      jsonRequest("http://test/api/tasks", { title: "Nope", projectId, lane: "openai-api" })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("declared lanes: fake-a, fake-b, no-skills");
    expect(testDb.select().from(schema.tasks).all()).toEqual([]);
  });

  it("refuses a declared lane whose credential is missing, naming the variable, before any row exists", async () => {
    delete process.env.FAKE_B_KEY;
    resetConfig();
    const projectId = await seedProject();
    const res = await postTask(
      jsonRequest("http://test/api/tasks", { title: "Try B", projectId, lane: "fake-b" })
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain('execution lane "fake-b" is unavailable');
    expect(body.error).toContain("FAKE_B_KEY");
    expect(testDb.select().from(schema.tasks).all()).toEqual([]);
  });

  it("refuses a generation session pinned to a lane whose harness cannot invoke its skill, even though another lane could", async () => {
    const projectId = await seedProject();
    const res = await postTask(
      jsonRequest("http://test/api/tasks", {
        title: "Grill it",
        projectId,
        sessionSkill: "grill-me",
        lane: "no-skills",
      })
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.reason).toBe("no-skill-capable-lane");
    expect(body.error).toContain("no-skills");
    expect(testDb.select().from(schema.tasks).all()).toEqual([]);
  });

  it("creates a generation session pinned to a lane that can host it", async () => {
    const projectId = await seedProject();
    const res = await postTask(
      jsonRequest("http://test/api/tasks", {
        title: "Grill it",
        projectId,
        sessionSkill: "grill-me",
        lane: "fake-b",
      })
    );
    expect(res.status).toBe(201);
    expect((await res.json()).lanePin).toBe("fake-b");
  });
});

describe("the operator pin for an unclaimed ticket (issue #241)", () => {
  const params = (id: string, number: string) => ({ params: Promise.resolve({ id, number }) });

  it("records, reads, replaces and withdraws a pin through the route", async () => {
    const projectId = await seedProject();
    const url = `http://test/api/projects/${projectId}/issues/7/lane`;

    expect(await (await getPin(new Request(url), params(projectId, "7"))).json()).toEqual({
      lane: null,
      createdAt: null,
    });

    const put = await putPin(jsonRequest(url, { lane: "fake-b" }, "PUT"), params(projectId, "7"));
    expect(put.status).toBe(200);
    expect((await put.json()).lane).toBe("fake-b");
    expect(readLanePin(projectId, 7)?.lane).toBe("fake-b");

    const again = await putPin(jsonRequest(url, { lane: "fake-a" }, "PUT"), params(projectId, "7"));
    expect((await again.json()).lane).toBe("fake-a");
    expect(testDb.select().from(schema.lanePins).all()).toHaveLength(1);

    const removed = await deletePin(new Request(url, { method: "DELETE" }), params(projectId, "7"));
    expect(await removed.json()).toEqual({ removed: true });
    expect(readLanePin(projectId, 7)).toBeNull();
  });

  it("judges the pinned lane exactly as task entry does", async () => {
    const projectId = await seedProject();
    const url = `http://test/api/projects/${projectId}/issues/7/lane`;
    const unknown = await putPin(jsonRequest(url, { lane: "nope" }, "PUT"), params(projectId, "7"));
    expect(unknown.status).toBe(400);
    delete process.env.FAKE_B_KEY;
    resetConfig();
    const unavailable = await putPin(jsonRequest(url, { lane: "fake-b" }, "PUT"), params(projectId, "7"));
    expect(unavailable.status).toBe(409);
    expect((await unavailable.json()).error).toContain("FAKE_B_KEY");
    expect(readLanePin(projectId, 7)).toBeNull();
  });

  it("is spent exactly once — the claim takes it and a second claim finds nothing", async () => {
    const projectId = await seedProject();
    setLanePin(projectId, 9, "fake-b");
    expect(takeLanePin(projectId, 9)).toBe("fake-b");
    expect(takeLanePin(projectId, 9)).toBeNull();
    expect(readLanePin(projectId, 9)).toBeNull();
  });

  it("answers 404 for a project that does not exist and 400 for a nonsense issue number", async () => {
    const missing = await getPin(new Request("http://test/x"), params("no-such-project", "7"));
    expect(missing.status).toBe(404);
    const projectId = await seedProject();
    const bad = await getPin(new Request("http://test/x"), params(projectId, "seven"));
    expect(bad.status).toBe(400);
  });
});
