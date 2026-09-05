import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb } from "@/test/create-test-db";
import { HARNESS_ADAPTER_DESCRIPTORS } from "@/lib/harness/descriptors";
import { parseLaneConfig, type LaneCatalog } from "@/lib/lanes/lane-config";
import { FAKE_NO_SKILLS_HARNESS_ID, fakeNoSkillsDescriptor } from "@/test/fake-harness";

/**
 * The session-entry half of issue #218: `POST /api/tasks` refuses a generation
 * session, with the reason, when no lane's harness can invoke its skill — before
 * the row exists, so before a container is anywhere near being provisioned.
 *
 * Against a from-migrations DB and a two-lane catalog: a lane on a harness that
 * does not expand a user-invoked skill, made primary, beside the Claude
 * subscription. The judgement is the crossing's — the same pure decision the
 * queue reads before starting a session — so what is pinned here is that the
 * route asks it, answers it as a refusal, and asks it of nothing else.
 */

let testDb: ReturnType<typeof createTestDb>["db"];

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));

const NO_SKILLS = FAKE_NO_SKILLS_HARNESS_ID;

function catalog(): LaneCatalog {
  const parsed = parseLaneConfig(
    `
primary:
  - other-sub
  - claude-subscription
lanes:
  - id: other-sub
    label: Other harness
    adapter: ${NO_SKILLS}
    billing: subscription
    auth:
      OTHER_TOKEN: OTHER_TOKEN
    models:
      heavy: other-big
      standard: other-mid
      light: other-small
  - id: claude-subscription
    label: Claude subscription
    adapter: claude-code
    billing: subscription
    auth:
      CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_CODE_OAUTH_TOKEN
    models:
      heavy: opus
      standard: sonnet
      light: haiku
`,
    [...HARNESS_ADAPTER_DESCRIPTORS, fakeNoSkillsDescriptor]
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
import { recordQuotaObservation } from "@/lib/quota/quota-store";
import { POST as postProject } from "@/app/api/projects/route";
import { GET as getTasks, POST as postTask } from "@/app/api/tasks/route";

const savedEnv = { ...process.env };

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function seedProject(): Promise<string> {
  const res = await postProject(jsonRequest("http://test/api/projects", { name: "Smoke" }));
  const { id } = await res.json();
  return id;
}

async function listed(projectId: string) {
  const res = await getTasks(new Request(`http://test/api/tasks?projectId=${projectId}`));
  return res.json();
}

describe("POST /api/tasks for a generation session (issue #218)", () => {
  beforeEach(() => {
    testDb = createTestDb().db;
    // The other harness's lane is primary and available; the one lane that
    // could host a session has no credential.
    process.env.OTHER_TOKEN = "t";
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.AGENT_LANE;
    resetConfig();
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    resetConfig();
  });

  it("refuses the session with the lane-by-lane reason, creating nothing", async () => {
    const projectId = await seedProject();

    const res = await postTask(
      jsonRequest("http://test/api/tasks", {
        title: "Grill the fleet dashboard",
        projectId,
        sessionSkill: "grill-me",
      })
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.reason).toBe("no-skill-capable-lane");
    expect(body.error).toContain("A grill-me session needs a lane whose harness can invoke skills");
    expect(body.error).toContain(`other-sub runs ${NO_SKILLS}, which cannot invoke a skill`);
    expect(body.error).toContain("claude-subscription needs CLAUDE_CODE_OAUTH_TOKEN");
    // Refused means refused: no row, so nothing for the queue to pick up and
    // no container to provision.
    expect(await listed(projectId)).toEqual([]);
  });

  it("creates the session once a lane that can host it is available", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth";
    resetConfig();
    const projectId = await seedProject();

    const res = await postTask(
      jsonRequest("http://test/api/tasks", {
        title: "Grill the fleet dashboard",
        projectId,
        sessionSkill: "grill-me",
      })
    );

    expect(res.status).toBe(201);
    const [row] = await listed(projectId);
    expect(row.sessionSkill).toBe("grill-me");
    expect(row.status).toBe("queued");
  });

  it("creates the session, to be held on its clock, when the only lane that can host it is walled", async () => {
    // A wall lifts itself, so this is not the operator's to fix: the session
    // is created and held on its feed exactly as a walled chat is, and the
    // queue starts it when the window resets.
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth";
    resetConfig();
    recordQuotaObservation("claude-subscription", {
      status: "rejected",
      rateLimitType: "five_hour",
      utilization: null,
      resetsAt: new Date(Date.now() + 4 * 60 * 60 * 1000),
      overageStatus: null,
      overageResetsAt: null,
      isUsingOverage: false,
      overageInUse: null,
      observedAt: new Date(),
    });
    const projectId = await seedProject();

    const res = await postTask(
      jsonRequest("http://test/api/tasks", {
        title: "Grill the fleet dashboard",
        projectId,
        sessionSkill: "grill-me",
      })
    );

    expect(res.status).toBe(201);
    expect((await listed(projectId))[0].sessionSkill).toBe("grill-me");
  });

  it("creates the session when the lane in force is unavailable but another lane can host it", async () => {
    // The lane in force could never have hosted the session, so its missing
    // credential is beside the point (issue #218): the session routes to the
    // lane that can, rather than being created only to die naming a variable
    // that would not have helped.
    delete process.env.OTHER_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth";
    resetConfig();
    const projectId = await seedProject();

    const res = await postTask(
      jsonRequest("http://test/api/tasks", {
        title: "Grill the fleet dashboard",
        projectId,
        sessionSkill: "grill-me",
      })
    );

    expect(res.status).toBe(201);
  });

  it("refuses the session when the lane in force is unavailable and nothing else can host it", async () => {
    delete process.env.OTHER_TOKEN;
    resetConfig();
    const projectId = await seedProject();

    const res = await postTask(
      jsonRequest("http://test/api/tasks", {
        title: "Grill the fleet dashboard",
        projectId,
        sessionSkill: "grill-me",
      })
    );

    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe("no-skill-capable-lane");
  });

  it("creates an ordinary chat task on the same fleet exactly as before", async () => {
    const projectId = await seedProject();

    const res = await postTask(
      jsonRequest("http://test/api/tasks", { title: "Chat task", projectId })
    );

    expect(res.status).toBe(201);
    const [row] = await listed(projectId);
    expect(row.sessionSkill).toBeNull();
    expect(row.status).toBe("queued");
  });

  it("still validates the skill before asking the fleet anything", async () => {
    const projectId = await seedProject();

    const res = await postTask(
      jsonRequest("http://test/api/tasks", {
        title: "Bad session",
        projectId,
        sessionSkill: "not-a-real-skill",
      })
    );

    expect(res.status).toBe(400);
  });
});
