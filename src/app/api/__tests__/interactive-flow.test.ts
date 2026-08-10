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
import { GET as getTasks, POST as postTask } from "@/app/api/tasks/route";

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
    expect(rows[0].sessionIssue).toBeNull();
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
    const [task] = await res.json();
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
