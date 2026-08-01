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
  });

  it("still validates input", async () => {
    const res = await postTask(
      jsonRequest("http://test/api/tasks", { title: "  " })
    );
    expect(res.status).toBe(400);
  });
});
