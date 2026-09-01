import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb } from "@/test/create-test-db";

/**
 * The orchestrator's session state is one map per *process*, not one per module
 * instance (issue #159).
 *
 * Next.js compiles `instrumentation.ts` (where the queue loop and the sweep
 * live) and the app-router route handlers into separate module graphs, so
 * `turn-manager` is evaluated twice in one process. Before this was understood,
 * `activeTasks` was a module-level `const`: `POST /api/tasks/[id]/complete`
 * deleted the finished session's entry from the route's copy while the queue
 * went on counting it in the orchestrator's copy, and one normal UI close held
 * the box's only slot until a restart.
 *
 * `vi.resetModules()` reproduces exactly that — a second, independent evaluation
 * of the same module in the same process. It is the only seam that can: the bug
 * is not in what any one copy does, it is that there were two. A test inside a
 * single module instance cannot see it, which is why the leak survived #151 and
 * #157 and read as an unexplained re-add race.
 */

let testDb: ReturnType<typeof createTestDb>["db"];

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));

type TurnManager = typeof import("../turn-manager");

/** Two full evaluations of the orchestrator's module graph is the cost of
 * reproducing the defect, and it comfortably outruns vitest's 5s default once
 * the rest of the suite is running beside it — so these two tests state their
 * own bound rather than failing on how busy the machine was. */
const TWO_GRAPHS_MS = 30_000;

/** A fresh module graph, as Next gives the app-router alongside the
 * orchestrator's. */
async function loadInSeparateGraph(): Promise<TurnManager> {
  vi.resetModules();
  return import("../turn-manager");
}

describe("orchestrator state across module graphs", () => {
  beforeEach(() => {
    testDb = createTestDb().db;
  });

  it("gives every module instance the same activeTasks map", async () => {
    const orchestratorGraph = await loadInSeparateGraph();
    const routeGraph = await loadInSeparateGraph();

    // Two genuinely distinct evaluations — otherwise the assertion below is
    // vacuous and would pass against the module-level `const` that caused #159.
    expect(routeGraph).not.toBe(orchestratorGraph);

    expect(routeGraph.getActiveTasks()).toBe(orchestratorGraph.getActiveTasks());
  }, TWO_GRAPHS_MS);

  it("lets a route-graph delete free the slot the orchestrator graph counts", async () => {
    const orchestratorGraph = await loadInSeparateGraph();
    const routeGraph = await loadInSeparateGraph();

    // What `startTask` leaves behind for a live interactive session: an entry
    // the queue counts as occupying a slot.
    orchestratorGraph.getActiveTasks().set("task-159", {
      container: {} as never,
      state: "idle",
      kind: "interactive",
    });
    expect(orchestratorGraph.getActiveTasks().size).toBe(1);

    // What `completeTask`'s `finally` does when the owner clicks Complete — run
    // from the route's graph, which is where that request is handled.
    routeGraph.getActiveTasks().delete("task-159");

    // The slot the queue reads is free again. Two maps, and it never was.
    expect(orchestratorGraph.getActiveTasks().size).toBe(0);
  }, TWO_GRAPHS_MS);
});
