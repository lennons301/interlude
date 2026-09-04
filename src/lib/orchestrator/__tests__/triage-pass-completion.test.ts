import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import fs from "fs";
import path from "path";
import { createTestDb } from "@/test/create-test-db";
import * as schema from "@/db/schema";
import { newId } from "@/lib/ulid";

/**
 * How a triage pass's end is written (issue #200), driven through the real
 * completion seam over a real (in-memory, migrated) database.
 *
 * Two readers select triage rows by two different facts: the sweep gathers a
 * pass to apply by its *stored exit*, and the claim reads the suggested tier
 * off the newest *completed* pass. The recommendation embed and the run it
 * authorizes name the same tier only if those are the same rows — so the exit,
 * the tier and `completed` must land in one write, ahead of anything that can
 * throw. A `failed` row holding a good exit is the shape that must never be
 * produced: the sweep would apply it and the embed name its tier, while the
 * claim skipped it and ran the ticket on an earlier pass's tier or the default.
 *
 * Only outbound I/O is stubbed (Docker). The DB writes and their ordering
 * against the container teardown are the real thing — the ordering is the point.
 */

let testDb: ReturnType<typeof createTestDb>["db"];

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));

const docker = vi.hoisted(() => ({
  /** Whether the daemon refuses the removal. */
  removeFails: false,
  /** What the task row read at the moment the container was first touched. */
  rowAtRemove: null as null | { status: string; triageTier: string | null; exit: unknown },
}));

vi.mock("../../docker/container-manager", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../docker/container-manager")>();
  return {
    ...actual,
    removeContainer: async () => {
      docker.rowAtRemove = readRow();
      if (docker.removeFails) throw new Error("removal refused: daemon busy");
    },
  };
});

vi.mock("../../github/issues", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../github/issues")>();
  return { ...actual, commentOnIssue: async () => undefined };
});

vi.mock("../../discord/notifications", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../discord/notifications")>();
  return { ...actual, notifyTaskFailed: async () => null };
});

type TurnManager = typeof import("../turn-manager");

const FIXTURES = path.join(__dirname, "..", "autonomy", "__tests__", "fixtures");
function fixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), "utf8");
}

let taskId: string;

function readRow() {
  const row = testDb.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get()!;
  return { status: row.status, triageTier: row.triageTier, exit: row.triageResult };
}

function seedTriagePass(): void {
  const projectId = newId();
  testDb
    .insert(schema.projects)
    .values({ id: projectId, name: "lemons", createdAt: new Date() })
    .run();
  taskId = newId();
  testDb
    .insert(schema.tasks)
    .values({
      id: taskId,
      projectId,
      title: "Triage: lennons301/lemons#34",
      status: "running",
      kind: "triage",
      githubIssue: "lennons301/lemons#34",
      containerStatus: "idle",
      containerId: "abc123",
      containerName: "interlude-task-triage",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
}

const RUNNING = {
  id: "abc123",
  name: "interlude-task-triage",
  previewSubdomain: "task-triage",
  container: {} as never,
};

describe("the end of a triage pass (issue #200)", () => {
  let turns: TurnManager;

  beforeEach(async () => {
    testDb = createTestDb().db;
    docker.removeFails = false;
    docker.rowAtRemove = null;
    vi.resetModules();
    turns = await import("../turn-manager");
    turns.getActiveTasks().clear();
    seedTriagePass();
    turns.getActiveTasks().set(taskId, {
      container: RUNNING,
      state: "running",
      kind: "triage",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes the exit, the tier and completion together, before the container is touched", async () => {
    await turns.finishTriagePass(taskId, RUNNING, fixture("triage-recommend-tier.ndjson"));

    // At the first Docker call the row already held all three: nothing that
    // can throw runs between the exit landing and the pass reading completed.
    expect(docker.rowAtRemove).toEqual({
      status: "completed",
      triageTier: "light",
      exit: expect.objectContaining({ kind: "recommend", tier: "light" }),
    });
    expect(readRow()).toEqual(docker.rowAtRemove);
    expect(turns.getActiveTasks().has(taskId)).toBe(false);
  });

  it("leaves a completed pass holding its exit when the container's removal fails", async () => {
    docker.removeFails = true;

    await expect(
      turns.finishTriagePass(taskId, RUNNING, fixture("triage-recommend-tier.ndjson"))
    ).rejects.toThrow("removal refused");

    // The pass finished; only cleanup did not. The sweep applies this exit
    // and the embed names `light`, so the claim must read the same row —
    // which it does by status. `startTask`'s catch sees a finished task and
    // stands down (#159), so this row is never downgraded to `failed`.
    expect(readRow()).toEqual({
      status: "completed",
      triageTier: "light",
      exit: expect.objectContaining({ kind: "recommend", tier: "light" }),
    });
  });

  it("leaves a completed pass holding its exit when a later write is refused", async () => {
    // The old shape: exit stored, then a system message, then `completed` in a
    // second statement. A write refused between the two left a `running` row
    // holding a good exit, which `startTask`'s catch then marked `failed` —
    // the row the sweep applied and the claim skipped. The first write after
    // the exit lands is the system message; refuse it.
    vi.spyOn(testDb, "insert").mockImplementationOnce(() => {
      throw new Error("disk I/O error");
    });

    await expect(
      turns.finishTriagePass(taskId, RUNNING, fixture("triage-recommend-tier.ndjson"))
    ).rejects.toThrow("disk I/O error");

    expect(readRow()).toEqual({
      status: "completed",
      triageTier: "light",
      exit: expect.objectContaining({ kind: "recommend", tier: "light" }),
    });
  });

  it("completes a pass whose exit was unparseable too — completed means ran to the end, not judged well", async () => {
    await turns.finishTriagePass(taskId, RUNNING, fixture("triage-malformed.ndjson"));

    // The sweep applies the stored result fail-closed (owner told once,
    // needs-triage kept). At claim this is the newest completed pass and it
    // suggests nothing, so the run takes the default — not an earlier pass's
    // judgement about an earlier body. Only a pass that *died* is `failed`.
    expect(readRow()).toEqual({
      status: "completed",
      triageTier: null,
      exit: expect.objectContaining({ kind: "unparseable" }),
    });
  });
});
