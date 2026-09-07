import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb } from "@/test/create-test-db";

/**
 * The live-preview session at entry (issue #160): `POST /api/tasks` accepts the
 * flag on an ordinary chat, refuses it beside a generation skill, and a task
 * created without it is byte-for-byte the chat it always was.
 */

let testDb: ReturnType<typeof createTestDb>["db"];

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));

import { POST as postProject } from "@/app/api/projects/route";
import { POST as postTask } from "@/app/api/tasks/route";
import { GET as getTask } from "@/app/api/tasks/[id]/route";

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function seedProject(): Promise<string> {
  const res = await postProject(jsonRequest("http://test/api/projects", { name: "Lemons" }));
  const { id } = await res.json();
  return id;
}

async function readTask(id: string) {
  const res = await getTask(new Request(`http://test/api/tasks/${id}`), {
    params: Promise.resolve({ id }),
  });
  return res.json();
}

describe("POST /api/tasks for a live-preview session", () => {
  beforeEach(() => {
    testDb = createTestDb().db;
  });

  it("creates an interactive, skill-less task carrying the flag", async () => {
    const projectId = await seedProject();
    const res = await postTask(
      jsonRequest("http://test/api/tasks", {
        title: "Add a dark mode toggle",
        projectId,
        livePreview: true,
      })
    );
    expect(res.status).toBe(201);
    const { id } = await res.json();

    const task = await readTask(id);
    expect(task.kind).toBe("interactive");
    expect(task.sessionSkill).toBeNull();
    expect(task.runId).toBeNull();
    expect(task.livePreview).toBe(true);
  });

  it("defaults the flag off, so a plain chat is unchanged", async () => {
    const projectId = await seedProject();
    const res = await postTask(
      jsonRequest("http://test/api/tasks", { title: "Chat", projectId })
    );
    const { id } = await res.json();
    expect((await readTask(id)).livePreview).toBe(false);
  });

  it("refuses the flag beside a generation skill — a grilling session runs no app", async () => {
    const projectId = await seedProject();
    const res = await postTask(
      jsonRequest("http://test/api/tasks", {
        title: "Grill the preview",
        projectId,
        sessionSkill: "grill-me",
        livePreview: true,
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("livePreview cannot be combined with a sessionSkill");
  });

  it("refuses a non-boolean flag", async () => {
    const projectId = await seedProject();
    const res = await postTask(
      jsonRequest("http://test/api/tasks", { title: "Chat", projectId, livePreview: "yes" })
    );
    expect(res.status).toBe(400);
  });
});
