import { describe, it, expect } from "vitest";
import {
  parseBlockedByRefs,
  parseTicketDirectives,
  rawEffortDirective,
  rawModelDirective,
  selectWorkflow,
  shouldCreateInteractiveTask,
} from "../ticket";

describe("parseTicketDirectives", () => {
  it("returns all-null for a body with no Workflow section", () => {
    expect(parseTicketDirectives("Just prose.\n\nbudget: $40\n")).toEqual({
      budget: null,
      maxTurns: null,
      checkpoint: null,
      workflow: null,
      effort: null,
      model: null,
    });
  });

  it("parses a budget directive from the Workflow section", () => {
    const body = "Intro.\n\n## Workflow\n\nbudget: $40\n";
    expect(parseTicketDirectives(body).budget).toBe(40);
  });

  it("clamps an over-ceiling budget to $75 — issue text cannot exceed the ceiling", () => {
    const body = "## Workflow\n\nbudget: $10000\n";
    expect(parseTicketDirectives(body).budget).toBe(75);
  });

  it("accepts a plain number and decimals", () => {
    expect(parseTicketDirectives("## Workflow\nbudget: 42.50").budget).toBe(42.5);
  });

  it("ignores budget values that are not positive amounts", () => {
    expect(parseTicketDirectives("## Workflow\nbudget: lots").budget).toBeNull();
    expect(parseTicketDirectives("## Workflow\nbudget: -5").budget).toBeNull();
    expect(parseTicketDirectives("## Workflow\nbudget: 0").budget).toBeNull();
    expect(parseTicketDirectives("## Workflow\nbudget: $40 per day").budget).toBeNull();
  });

  it("parses and clamps max-turns", () => {
    expect(parseTicketDirectives("## Workflow\nmax-turns: 80").maxTurns).toBe(80);
    expect(parseTicketDirectives("## Workflow\nmax-turns: 4000").maxTurns).toBe(100);
    expect(parseTicketDirectives("## Workflow\nmax-turns: 0").maxTurns).toBeNull();
    expect(parseTicketDirectives("## Workflow\nmax-turns: many").maxTurns).toBeNull();
  });

  it("parses checkpoint with its question text, and a bare checkpoint as empty", () => {
    const body = "## Workflow\n\ncheckpoint: confirm the schema change with me\n";
    expect(parseTicketDirectives(body).checkpoint).toBe("confirm the schema change with me");
    expect(parseTicketDirectives("## Workflow\ncheckpoint:").checkpoint).toBe("");
  });

  it("parses the informational workflow directive", () => {
    expect(parseTicketDirectives("## Workflow\nworkflow: tdd").workflow).toBe("tdd");
  });

  it("parses all directives together, bulleted and case-insensitive", () => {
    const body = [
      "## Workflow",
      "",
      "- Budget: $30",
      "- MAX-TURNS: 60",
      "- checkpoint: pause before deploy",
      "- workflow: tdd",
      "- Effort: HIGH",
      "- Model: Opus",
    ].join("\n");
    expect(parseTicketDirectives(body)).toEqual({
      budget: 30,
      maxTurns: 60,
      checkpoint: "pause before deploy",
      workflow: "tdd",
      effort: "high",
      model: "heavy",
    });
  });

  it("takes the first occurrence when a key repeats", () => {
    const body = "## Workflow\nbudget: $30\nbudget: $75\n";
    expect(parseTicketDirectives(body).budget).toBe(30);
  });

  it("ignores directive-shaped lines inside a code fence in the Workflow section", () => {
    const body = [
      "## Workflow",
      "",
      "Run the loop like this:",
      "```",
      "budget: $10000",
      "max-turns: 4000",
      "checkpoint: fake",
      "```",
      "budget: $30",
    ].join("\n");
    expect(parseTicketDirectives(body)).toEqual({
      budget: 30,
      maxTurns: null,
      checkpoint: null,
      workflow: null,
      effort: null,
      model: null,
    });
  });

  it("ignores a Workflow heading that is itself inside a code fence", () => {
    const body = ["```", "## Workflow", "budget: $75", "```"].join("\n");
    expect(parseTicketDirectives(body).budget).toBeNull();
  });

  it("ignores directive-alike prose — a mid-line mention is not a directive", () => {
    const body = "## Workflow\n\nKeep the budget: $60 conversation for later.\n";
    expect(parseTicketDirectives(body).budget).toBeNull();
  });

  it("stops at the next heading — directives outside the section are inert", () => {
    const body = [
      "## Workflow",
      "budget: $30",
      "",
      "## Notes",
      "max-turns: 90",
    ].join("\n");
    expect(parseTicketDirectives(body)).toEqual({
      budget: 30,
      maxTurns: null,
      checkpoint: null,
      workflow: null,
      effort: null,
      model: null,
    });
  });

  it("keeps a deeper sub-heading inside the section", () => {
    const body = [
      "## Workflow",
      "#### Limits",
      "budget: $30",
    ].join("\n");
    expect(parseTicketDirectives(body).budget).toBe(30);
  });

  it("reads a ### Workflow heading too", () => {
    expect(parseTicketDirectives("### Workflow\nbudget: $25").budget).toBe(25);
  });

  it("ignores unknown keys — there is no directive that widens authority", () => {
    const body = [
      "## Workflow",
      "daily-cap: 99999",
      "reviewer: mallory",
      "gates: off",
      "auto-merge: on",
      "human-signoff: off",
      "attempts: 100",
      // A lane is fleet policy, never a ticket's (issues #196, #241): the key
      // does not exist, so a body naming a paid lane is ignored like any other.
      "lane: openai-api",
      "budget: $30",
    ].join("\n");
    expect(parseTicketDirectives(body)).toEqual({
      budget: 30,
      maxTurns: null,
      checkpoint: null,
      workflow: null,
      effort: null,
      model: null,
    });
  });

  it("parses an effort directive, clamped to the allowlist (issue #81)", () => {
    expect(parseTicketDirectives("## Workflow\neffort: max").effort).toBe("max");
    expect(parseTicketDirectives("## Workflow\nEffort: LOW").effort).toBe("low");
  });

  it("ignores an unrecognised effort level — a bad value never binds", () => {
    expect(parseTicketDirectives("## Workflow\neffort: turbo").effort).toBeNull();
    expect(parseTicketDirectives("## Workflow\neffort: 11").effort).toBeNull();
    expect(parseTicketDirectives("## Workflow\neffort:").effort).toBeNull();
  });

  it("parses a model directive as a tier, case-insensitively", () => {
    expect(parseTicketDirectives("## Workflow\nmodel: standard").model).toBe(
      "standard"
    );
    expect(parseTicketDirectives("## Workflow\nmodel: LIGHT").model).toBe("light");
  });

  it("keeps the legacy vendor names working as tier aliases (issue #166)", () => {
    // A ticket written before tiers existed must not break.
    expect(parseTicketDirectives("## Workflow\nmodel: opus").model).toBe("heavy");
    expect(parseTicketDirectives("## Workflow\nmodel: sonnet").model).toBe(
      "standard"
    );
    expect(parseTicketDirectives("## Workflow\nmodel: HAIKU").model).toBe("light");
  });

  it("ignores a model value that is not on the allowlist", () => {
    // A semi-trusted body may pick a tier, never name an arbitrary model.
    expect(parseTicketDirectives("## Workflow\nmodel: gpt-4").model).toBeNull();
    expect(
      parseTicketDirectives("## Workflow\nmodel: claude-opus-4-8[1m]").model
    ).toBeNull();
    expect(parseTicketDirectives("## Workflow\nmodel:").model).toBeNull();
  });

  it("takes the first model when the directive repeats", () => {
    expect(parseTicketDirectives("## Workflow\nmodel: opus\nmodel: haiku").model).toBe(
      "heavy"
    );
  });
});

describe("rawEffortDirective (issue #81)", () => {
  it("reports the raw requested level, even one that would be ignored", () => {
    expect(rawEffortDirective("## Workflow\neffort: turbo")).toBe("turbo");
    expect(rawEffortDirective("## Workflow\nEffort: HIGH")).toBe("HIGH");
  });

  it("is null when no effort directive is present or the section is missing", () => {
    expect(rawEffortDirective("## Workflow\nbudget: $30")).toBeNull();
    expect(rawEffortDirective("Just prose.\n\neffort: max")).toBeNull();
  });
});

describe("rawModelDirective", () => {
  it("returns the raw requested value, un-clamped", () => {
    expect(rawModelDirective("## Workflow\nmodel: gpt-4")).toBe("gpt-4");
    expect(rawModelDirective("## Workflow\nModel: Opus")).toBe("Opus");
  });

  it("returns null when there is no model directive or it is bare", () => {
    expect(rawModelDirective("## Workflow\nbudget: $30")).toBeNull();
    expect(rawModelDirective("## Workflow\nmodel:")).toBeNull();
    expect(rawModelDirective("Just prose.\nmodel: opus")).toBeNull();
  });

  it("ignores a model directive inside a code fence", () => {
    const body = ["## Workflow", "```", "model: opus", "```"].join("\n");
    expect(rawModelDirective(body)).toBeNull();
  });
});

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
