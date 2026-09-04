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
const RUBRIC_HEADING = "### Choosing the tier";
const TRIAGE_DOC = "docs/agents/triage-pass.md";
const TRIAGE_RUBRIC_HEADING = "## The tier";

/** A rubric criterion line: "- `tier` — <criterion>". */
const CRITERION_LINE = /^- `([a-z]+)` — (.*)$/;

interface Contract {
  /** The section's prose, fenced code removed, keyed by `###` subsection. */
  prose: Map<string, string[]>;
  /** Each fenced example in the section, verbatim. */
  examples: string[];
}

/**
 * One walk over the document, from the contract's H2 to the next H2 outside
 * a code fence. Deliberately its own reader rather than the parser's
 * `workflowSectionLines`: the examples inside the section are whole ticket
 * shapes carrying `## Workflow` headings of their own, which must not end
 * the section early, and this walk *keeps* fenced lines (as examples) where
 * the parser drops them.
 */
function readContract(): Contract {
  const doc = readFileSync(path.join(process.cwd(), "docs/agents/issue-tracker.md"), "utf8");
  const prose = new Map<string, string[]>();
  const examples: string[] = [];
  let subsection = "";
  let inSection = false;
  let fence: string[] | null = null;

  for (const line of doc.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      if (fence) {
        if (inSection) examples.push(fence.join("\n"));
        fence = null;
      } else {
        fence = [];
      }
      continue;
    }
    if (fence) {
      fence.push(line);
      continue;
    }
    if (line.startsWith("## ")) {
      if (inSection) break;
      inSection = line.startsWith(CONTRACT_HEADING);
      continue;
    }
    if (!inSection) continue;
    if (line.startsWith("### ")) subsection = line;
    if (!prose.has(subsection)) prose.set(subsection, []);
    prose.get(subsection)!.push(line);
  }
  return { prose, examples };
}

describe("tracker ticket contract (issue #197)", () => {
  it("shows examples the directive parser reads as a tier", () => {
    const { examples } = readContract();
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) {
      const { model } = parseTicketDirectives(example);
      expect(model, `example parses to a tier:\n${example}`).not.toBeNull();
      expect(MODEL_TIERS).toContain(model);
    }
  });

  it("gives a rubric criterion for exactly the parser's tier vocabulary", () => {
    const rubric = readContract().prose.get(RUBRIC_HEADING);
    expect(rubric, `the contract has a "${RUBRIC_HEADING}" subsection`).toBeDefined();
    const criteria = rubric!
      .map((line) => line.match(CRITERION_LINE))
      .flatMap((m) => (m ? [m[1]] : []));
    expect([...criteria].sort()).toEqual([...MODEL_TIERS].sort());
  });

  // Issue #200: the triage pass is the second producer of tiers, for raw
  // issues, and its rubric must be the contract's own words so the two cannot
  // disagree about the same ticket. Pinned line-for-line rather than by
  // vocabulary alone — a paraphrase that kept the three names but moved the
  // criteria would pass the test above and still split the producers.
  it("is the same rubric, word for word, that the triage pass judges by", () => {
    const contract = readContract().prose.get(RUBRIC_HEADING)!;
    const triage = readFileSync(path.join(process.cwd(), TRIAGE_DOC), "utf8").split("\n");
    const start = triage.indexOf(TRIAGE_RUBRIC_HEADING);
    expect(start, `${TRIAGE_DOC} has a "${TRIAGE_RUBRIC_HEADING}" section`).toBeGreaterThan(-1);
    const end = triage.findIndex((line, i) => i > start && line.startsWith("## "));
    const section = triage.slice(start, end === -1 ? undefined : end);

    const criteriaOf = (lines: string[]) =>
      joinContinuations(lines)
        .map((line) => line.match(CRITERION_LINE))
        .flatMap((m) => (m ? [`${m[1]}: ${m[2]}`] : []))
        .sort();

    const expected = criteriaOf(contract);
    expect(expected).toHaveLength(MODEL_TIERS.length);
    expect(criteriaOf(section)).toEqual(expected);
  });
});

/** Markdown list items wrap: fold an indented continuation line into the
 * bullet it continues, so the comparison is of criteria, not of line breaks. */
function joinContinuations(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (/^\s+\S/.test(line) && out.length > 0 && out[out.length - 1].startsWith("- ")) {
      out[out.length - 1] += ` ${line.trim()}`;
    } else {
      out.push(line);
    }
  }
  return out;
}
