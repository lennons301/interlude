import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb } from "@/test/create-test-db";

// The interactive chat flow's API surface, run against a from-migrations DB —
// verifying the Phase 5 schema additions leave it untouched (issue #13)
let testDb: ReturnType<typeof createTestDb>["db"];

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));

import { GET as getProjects, POST as postProject } from "@/app/api/projects/route";
import {
  GET as getTasks,
  POST as postTask,
  parseLimit,
} from "@/app/api/tasks/route";
import {
  GET as getTask,
  PATCH as patchTaskRoute,
} from "@/app/api/tasks/[id]/route";
import { TASK_LIST_LIMIT } from "@/lib/tasks/organize-tasks";

/** The list route is a projection for the archive (issue #120); the whole
 * persisted row is read through the task's own route. */
function readTask(id: string) {
  return getTask(new Request(`http://test/api/tasks/${id}`), {
    params: Promise.resolve({ id }),
  });
}

function patchTask(id: string, status: string) {
  return patchTaskRoute(
    jsonRequest(`http://test/api/tasks/${id}`, { status }),
    { params: Promise.resolve({ id }) }
  );
}

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("interactive chat flow API against the migrated schema", () => {
  beforeEach(() => {
    testDb = createTestDb().db;
  });

  it("creates and lists a project, defaulting autonomy off", async () => {
    const created = await postProject(
      jsonRequest("http://test/api/projects", { name: "Smoke" })
    );
    expect(created.status).toBe(201);

    const res = await getProjects();
    expect(res.status).toBe(200);
    const [project] = await res.json();
    expect(project.name).toBe("Smoke");
    expect(project.autonomyEnabled).toBe(false);
    expect(project.preflightStatus).toBeNull();
    expect(project.preflightReason).toBeNull();
  });

  it("creates and lists a task, defaulting to an interactive kind with no run", async () => {
    const projectRes = await postProject(
      jsonRequest("http://test/api/projects", { name: "Smoke" })
    );
    const { id: projectId } = await projectRes.json();

    const created = await postTask(
      jsonRequest("http://test/api/tasks", {
        title: "Chat task",
        projectId,
      })
    );
    expect(created.status).toBe(201);

    const res = await getTasks(
      new Request(`http://test/api/tasks?status=queued&projectId=${projectId}`)
    );
    expect(res.status).toBe(200);
    const rows = await res.json();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("interactive");
    expect(rows[0].runId).toBeNull();
    expect(rows[0].status).toBe("queued");
    // An ordinary chat task is not a generation session (issue #61).
    expect(rows[0].sessionSkill).toBeNull();

    const task = await (await readTask(rows[0].id)).json();
    expect(task.sessionIssue).toBeNull();
  });

  it("records a generation session's skill and issue anchor, kind still interactive (#61)", async () => {
    const projectRes = await postProject(
      jsonRequest("http://test/api/projects", { name: "Smoke" })
    );
    const { id: projectId } = await projectRes.json();

    const created = await postTask(
      jsonRequest("http://test/api/tasks", {
        title: "Grill the fleet dashboard",
        projectId,
        sessionSkill: "grill-me",
        sessionIssue: "lennons301/interlude#61",
      })
    );
    expect(created.status).toBe(201);

    // Re-read the persisted row: a session stays interactive with no run —
    // spend exemption holds by construction — and the anchor lives in
    // sessionIssue, never githubIssue (which drives implement-lifecycle).
    const res = await getTasks(
      new Request(`http://test/api/tasks?projectId=${projectId}`)
    );
    const [listed] = await res.json();
    const task = await (await readTask(listed.id)).json();
    expect(task.sessionSkill).toBe("grill-me");
    expect(task.sessionIssue).toBe("lennons301/interlude#61");
    expect(task.kind).toBe("interactive");
    expect(task.runId).toBeNull();
    expect(task.githubIssue).toBeNull();
  });

  it("rejects an unknown session skill", async () => {
    const projectRes = await postProject(
      jsonRequest("http://test/api/projects", { name: "Smoke" })
    );
    const { id: projectId } = await projectRes.json();

    const res = await postTask(
      jsonRequest("http://test/api/tasks", {
        title: "Bad session",
        projectId,
        sessionSkill: "not-a-real-skill",
      })
    );
    expect(res.status).toBe(400);
  });

  it("still validates input", async () => {
    const res = await postTask(
      jsonRequest("http://test/api/tasks", { title: "  " })
    );
    expect(res.status).toBe(400);
  });
});

// The archive's read path (issue #120). On prod the list shipped every column
// of every row — 1035 KB of `description` (the full implement prompt) in a
// 1219 KB response for 44 KB of rendered fields — unbounded and growing with
// every task, which is what made the screen unusable over a slow connection.
describe("the tasks list is a bounded projection", () => {
  beforeEach(() => {
    testDb = createTestDb().db;
  });

  async function seedProject(name: string): Promise<string> {
    const res = await postProject(
      jsonRequest("http://test/api/projects", { name })
    );
    const { id } = await res.json();
    return id;
  }

  async function seedTask(projectId: string, title: string, description = "") {
    await postTask(
      jsonRequest("http://test/api/tasks", { title, projectId, description })
    );
  }

  it("carries what a card renders — and not the description", async () => {
    const projectId = await seedProject("lemons");
    await seedTask(projectId, "Chat task", "x".repeat(30_000));

    const [row] = await (
      await getTasks(new Request("http://test/api/tasks"))
    ).json();

    expect(Object.keys(row).sort()).toEqual([
      "costUsd",
      "githubIssue",
      "id",
      "kind",
      "projectId",
      "projectName",
      "runId",
      "sessionIssue",
      "sessionSkill",
      "status",
      "title",
      "updatedAt",
    ]);
    // The project's name comes joined in, so a card names its project without
    // a round trip per row.
    expect(row.projectName).toBe("lemons");
  });

  it("bounds the list", async () => {
    const projectId = await seedProject("lemons");
    for (let i = 0; i < 5; i++) await seedTask(projectId, `Task ${i}`);

    const bounded = await (
      await getTasks(new Request("http://test/api/tasks?limit=2"))
    ).json();

    expect(bounded).toHaveLength(2);
  });

  // The bound itself is asserted here rather than by seeding 500 rows through
  // the API: `parseLimit` is the whole of it, so this is where a deleted clamp
  // or a lifted default actually fails.
  it("caps, floors and falls back on the requested limit", () => {
    expect(parseLimit(null)).toBe(TASK_LIST_LIMIT);
    expect(parseLimit("")).toBe(TASK_LIST_LIMIT);
    expect(parseLimit("nope")).toBe(TASK_LIST_LIMIT);
    expect(parseLimit("0")).toBe(TASK_LIST_LIMIT);
    expect(parseLimit("-5")).toBe(TASK_LIST_LIMIT);
    expect(parseLimit("25")).toBe(25);
    expect(parseLimit("99999")).toBe(500);
  });

  it("applies status and projectId together rather than one replacing the other", async () => {
    const lemons = await seedProject("lemons");
    const moontide = await seedProject("moontide");
    await seedTask(lemons, "Lemons task");
    await seedTask(moontide, "Moontide queued task");
    await seedTask(moontide, "Moontide finished task");

    // The finished task shares the project, so only a status filter that
    // survives alongside projectId can exclude it — the shape the old
    // two-`where` builder silently dropped.
    const listed = await (
      await getTasks(new Request(`http://test/api/tasks?projectId=${moontide}`))
    ).json();
    const finished = listed.find(
      (r: { title: string }) => r.title === "Moontide finished task"
    );
    await patchTask(finished.id, "completed");

    const rows = await (
      await getTasks(
        new Request(
          `http://test/api/tasks?status=queued&projectId=${moontide}`
        )
      )
    ).json();

    expect(rows.map((r: { title: string }) => r.title)).toEqual([
      "Moontide queued task",
    ]);
  });

  it("treats an empty filter parameter as no filter, as it always has", async () => {
    const projectId = await seedProject("lemons");
    await seedTask(projectId, "Chat task");

    const res = await getTasks(
      new Request("http://test/api/tasks?status=&projectId=")
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toHaveLength(1);
  });

  it("rejects a status outside the enum instead of silently listing nothing", async () => {
    const res = await getTasks(
      new Request("http://test/api/tasks?status=not-a-status")
    );
    expect(res.status).toBe(400);
  });
});
