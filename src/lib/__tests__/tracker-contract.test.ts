/**
 * The ticket contract in docs/agents/issue-tracker.md (issue #197) tells
 * every producer of tickets to write a `## Workflow` section naming a tier.
 * The rubric itself is documentation and is judged by the tickets it
 * produces, not here. What this pins is the seam between the document and
 * the reader: the syntax the contract shows must be the syntax the directive
 * parser accepts, and the tiers the rubric names must be the parser's own
 * vocabulary — otherwise a generation session follows the document faithfully
 * and the fleet silently runs every ticket at the default tier.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseTicketDirectives } from "@/lib/orchestrator/autonomy/ticket";
import { MODEL_TIERS } from "@/lib/model-tiers";

const CONTRACT_HEADING = "## Ticket contract";

/** The contract section: from its H2 to the next H2 *outside* a code fence —
 * the examples inside it are ticket shapes and carry `## Workflow` headings
 * of their own, which must not end the section early. */
function contractSection(): string {
  const doc = readFileSync(path.join(process.cwd(), "docs/agents/issue-tracker.md"), "utf8");
  const lines: string[] = [];
  let inSection = false;
  let inFence = false;
  for (const line of doc.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (!inFence && line.startsWith("## ")) {
      if (inSection) break;
      inSection = line.startsWith(CONTRACT_HEADING);
      continue;
    }
    if (inSection) lines.push(line);
  }
  expect(lines.length, `the tracker doc has a "${CONTRACT_HEADING}" section`).toBeGreaterThan(0);
  return lines.join("\n");
}

function fencedExamples(section: string): string[] {
  return [...section.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1]);
}

describe("tracker ticket contract (issue #197)", () => {
  it("shows examples the directive parser reads as a tier", () => {
    const examples = fencedExamples(contractSection());
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) {
      const { model } = parseTicketDirectives(example);
      expect(model, `example parses to a tier:\n${example}`).not.toBeNull();
      expect(MODEL_TIERS).toContain(model);
    }
  });

  it("gives a rubric criterion for exactly the parser's tier vocabulary", () => {
    const section = contractSection();
    const criteria = [...section.matchAll(/^- `([a-z]+)` — /gm)].map((m) => m[1]);
    expect([...criteria].sort()).toEqual([...MODEL_TIERS].sort());
  });
});
