import { describe, it, expect } from "vitest";
import {
  planParkedAdoption,
  type ContainerPresence,
  type ParkedTaskRow,
} from "../parked-adoption";

function blockedRow(overrides: Partial<ParkedTaskRow> = {}): ParkedTaskRow {
  return {
    taskId: "task-1",
    runId: "run-1",
    status: "blocked",
    kind: "implement",
    containerName: "interlude-task-1",
    containerId: "sha256-1",
    previewSubdomain: "task-0000001",
    ...overrides,
  };
}

const presence = (answers: Record<string, ContainerPresence>) =>
  (name: string): ContainerPresence => answers[name] ?? "absent";

describe("planParkedAdoption", () => {
  it("adopts a blocked task whose container is still there", () => {
    const plan = planParkedAdoption(
      [blockedRow()],
      presence({ "interlude-task-1": "present" })
    );

    expect(plan.adopt).toEqual([
      {
        taskId: "task-1",
        runId: "run-1",
        kind: "implement",
        containerName: "interlude-task-1",
        containerId: "sha256-1",
        previewSubdomain: "task-0000001",
      },
    ]);
    expect(plan.orphaned).toEqual([]);
    expect(plan.deferred).toEqual([]);
  });

  it("orphans a blocked task whose container the daemon has lost", () => {
    const plan = planParkedAdoption(
      [blockedRow()],
      presence({ "interlude-task-1": "absent" })
    );

    expect(plan.adopt).toEqual([]);
    expect(plan.orphaned).toEqual([
      { taskId: "task-1", runId: "run-1", reason: "container-gone" },
    ]);
    expect(plan.deferred).toEqual([]);
  });

  it("defers a task the daemon could not answer for, deciding nothing", () => {
    const plan = planParkedAdoption(
      [blockedRow()],
      presence({ "interlude-task-1": "unknown" })
    );

    expect(plan.adopt).toEqual([]);
    expect(plan.orphaned).toEqual([]);
    expect(plan.deferred).toEqual(["task-1"]);
  });

  it("orphans a blocked task that never recorded a container", () => {
    const plan = planParkedAdoption(
      [blockedRow({ containerName: null, containerId: null })],
      presence({})
    );

    expect(plan.adopt).toEqual([]);
    expect(plan.orphaned).toEqual([
      { taskId: "task-1", runId: "run-1", reason: "no-container-recorded" },
    ]);
  });

  it("leaves a task that is already adopted alone, so repeated boots are idempotent", () => {
    const rows = [blockedRow()];
    const answers = presence({ "interlude-task-1": "present" });

    const first = planParkedAdoption(rows, answers);
    const second = planParkedAdoption(rows, answers, first.adopt.map((a) => a.taskId));

    expect(first.adopt).toHaveLength(1);
    expect(second.adopt).toEqual([]);
    expect(second.orphaned).toEqual([]);
    expect(second.deferred).toEqual([]);
  });

  it("never resurrects a task whose status is no longer blocked", () => {
    const plan = planParkedAdoption(
      [
        blockedRow({ taskId: "done", status: "completed" }),
        blockedRow({ taskId: "dead", status: "failed" }),
        blockedRow({ taskId: "gone", status: "cancelled", containerName: null, containerId: null }),
      ],
      () => "present"
    );

    expect(plan).toEqual({ adopt: [], orphaned: [], deferred: [] });
  });
});
