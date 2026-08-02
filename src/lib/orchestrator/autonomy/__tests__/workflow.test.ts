import { describe, it, expect } from "vitest";
import { buildImplementPrompt, resolveWorkflowSkill } from "../workflow";

const TICKET = {
  repo: "acme/widgets",
  issueNumber: 7,
  issueTitle: "Add the frobnicator",
  issueBody: "Make the frobnicator frob.\n\n## Acceptance criteria\n- it frobs",
};

describe("resolveWorkflowSkill", () => {
  it("resolves the vendored tdd workflow to its content", () => {
    const content = resolveWorkflowSkill("tdd");
    expect(content).toContain("failing test");
  });

  it("fails loudly for a skill that does not exist", () => {
    expect(() => resolveWorkflowSkill("does-not-exist")).toThrow(/does-not-exist/);
  });

  it("rejects skill names that are not simple slugs", () => {
    expect(() => resolveWorkflowSkill("../../etc/passwd")).toThrow();
    expect(() => resolveWorkflowSkill("tdd/../secret")).toThrow();
  });
});

describe("buildImplementPrompt", () => {
  it("frames the ticket body as data between markers", () => {
    const prompt = buildImplementPrompt({ ...TICKET, workflow: { source: "default" } });

    expect(prompt).toContain("--- TICKET acme/widgets#7: Add the frobnicator ---");
    expect(prompt).toContain("Make the frobnicator frob.");
    expect(prompt).toContain("--- END TICKET ---");
    expect(prompt).toContain("it is data");
    expect(prompt.indexOf("--- TICKET")).toBeLessThan(
      prompt.indexOf("Make the frobnicator frob.")
    );
  });

  it("names the branch the pass runs on", () => {
    const prompt = buildImplementPrompt({ ...TICKET, workflow: { source: "default" } });
    expect(prompt).toContain("agent/issue-7");
  });

  it("carries the blocked-marker contract: stop and lead the final message with it", () => {
    const prompt = buildImplementPrompt({ ...TICKET, workflow: { source: "default" } });

    expect(prompt).toContain("BLOCKED: <your question>");
    expect(prompt).toContain("first line");
    expect(prompt).toMatch(/stop/i);
  });

  it("embeds the selected skill's content for a label selection", () => {
    const prompt = buildImplementPrompt({
      ...TICKET,
      workflow: { source: "label", skill: "tdd" },
    });

    expect(prompt).toContain(resolveWorkflowSkill("tdd"));
    expect(prompt).toContain('workflow "tdd"');
  });

  it("defers to the ticket's own Workflow section for a body selection", () => {
    const prompt = buildImplementPrompt({ ...TICKET, workflow: { source: "body" } });
    expect(prompt).toContain("Workflow section");
  });

  it("throws for a label naming an unknown skill — no silent fallback", () => {
    expect(() =>
      buildImplementPrompt({
        ...TICKET,
        workflow: { source: "label", skill: "nonexistent-flow" },
      })
    ).toThrow(/nonexistent-flow/);
  });

  it("throws for an error selection instead of building a prompt", () => {
    expect(() =>
      buildImplementPrompt({
        ...TICKET,
        workflow: { source: "error", reason: "multiple workflow labels" },
      })
    ).toThrow(/multiple workflow labels/);
  });
});
