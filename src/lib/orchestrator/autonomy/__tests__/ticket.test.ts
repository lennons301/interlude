import { describe, it, expect } from "vitest";
import {
  parseBlockedByRefs,
  selectWorkflow,
  shouldCreateInteractiveTask,
} from "../ticket";

describe("selectWorkflow", () => {
  it("selects the skill named by a workflow:<skill> label", () => {
    expect(selectWorkflow("Do the thing.", ["ready-for-agent", "workflow:tdd"])).toEqual({
      source: "label",
      skill: "tdd",
    });
  });

  it("defaults to agent judgement when nothing selects a workflow", () => {
    expect(selectWorkflow("Do the thing.", ["ready-for-agent"])).toEqual({
      source: "default",
    });
  });

  it("lets a ticket's own Workflow section take precedence over the label", () => {
    const body = "Intro.\n\n## Workflow\n\n1. Write a failing test.\n";
    expect(selectWorkflow(body, ["workflow:tdd"])).toEqual({ source: "body" });
  });

  it("treats multiple workflow labels as an error, not a guess", () => {
    const selection = selectWorkflow("Body.", ["workflow:tdd", "workflow:prototype"]);
    expect(selection.source).toBe("error");
    if (selection.source === "error") {
      expect(selection.reason).toContain("workflow:tdd");
      expect(selection.reason).toContain("workflow:prototype");
    }
  });

  it("treats an empty skill name as an error", () => {
    expect(selectWorkflow("Body.", ["workflow:"]).source).toBe("error");
  });

  it("does not mistake a deeper heading or prose mention for a Workflow section", () => {
    expect(selectWorkflow("The workflow: label picks a skill.", ["workflow:tdd"])).toEqual({
      source: "label",
      skill: "tdd",
    });
    expect(selectWorkflow("#### Workflow notes\n", ["workflow:tdd"])).toEqual({
      source: "label",
      skill: "tdd",
    });
  });
});

describe("parseBlockedByRefs", () => {
  it("parses a single Blocked by line", () => {
    expect(parseBlockedByRefs("Blocked by: #13")).toEqual([13]);
  });

  it("parses comma-separated refs and bullets, case-insensitively", () => {
    expect(parseBlockedByRefs("Intro\n- blocked by: #13, #14\nOutro")).toEqual([13, 14]);
  });

  it("ignores prose mentions that are not a Blocked by line", () => {
    expect(parseBlockedByRefs("This was blocked by #13 once.")).toEqual([]);
    expect(parseBlockedByRefs("See #13 and #14.")).toEqual([]);
  });

  it("returns an empty list for a body with no blockers", () => {
    expect(parseBlockedByRefs("## Blocked by\n\n- Runs ledger (no ref)")).toEqual([]);
  });

  it("dedupes repeated refs", () => {
    expect(parseBlockedByRefs("Blocked by: #5\nBlocked by: #5")).toEqual([5]);
  });
});

describe("shouldCreateInteractiveTask", () => {
  it("creates an interactive task for the interlude label alone", () => {
    expect(shouldCreateInteractiveTask(["interlude"])).toBe(true);
  });

  it("lets ready-for-agent win when both labels are present", () => {
    expect(shouldCreateInteractiveTask(["interlude", "ready-for-agent"])).toBe(false);
  });
});
