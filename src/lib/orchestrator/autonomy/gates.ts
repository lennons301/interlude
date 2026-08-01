/**
 * Review-gate evaluation (issue #16) — the deterministic answer to "may this
 * agent-authored PR merge without a human?". Pure: config text and changed
 * paths come in, matched categories come out. The laptop runner's bash
 * evaluator and this module are two executors of one contract, so the glob
 * semantics here must reproduce bash `[[ == ]]` exactly: `*` (and therefore
 * `**`) crosses `/`, and the evaluator's single extension is that a leading
 * `**` + `/` also matches at the repo root.
 */

import { parse as parseYaml } from "yaml";

/** Label a gated PR receives; a human must approve and merge it. */
export const HUMAN_SIGNOFF_LABEL = "human-signoff";

/** Estate-wide gate config, read from the platform repo's default branch. */
export const ESTATE_GATES_PATH = "standards/review-gates.yaml";

/** A repo's additive extension, read from its own default branch. */
export const REPO_GATES_PATH = "docs/agents/review-gates.yaml";

/** Gate categories: name -> the globs that trip it. */
export type GateConfig = Record<string, string[]>;

export type GateConfigResult =
  | { ok: true; config: GateConfig }
  | { ok: false; reason: string };

/**
 * Parse one review-gates.yaml. The contract shape is a `human_signoff`
 * mapping of category name to a list of globs; anything else is unparseable
 * and the caller fails closed. Two deliberate leniencies match real files:
 * an empty `human_signoff:` means "no gates here", and a category left with
 * no globs (a commented-out list) means an empty category, not an error.
 */
export function parseGateConfig(text: string): GateConfigResult {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    return { ok: false, reason: `invalid YAML: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (doc === null || doc === undefined || typeof doc !== "object" || Array.isArray(doc)) {
    return { ok: false, reason: "document is not a mapping with a human_signoff key" };
  }
  if (!("human_signoff" in doc)) {
    return { ok: false, reason: "document has no human_signoff key" };
  }

  const signoff = (doc as Record<string, unknown>).human_signoff;
  if (signoff === null || signoff === undefined) return { ok: true, config: {} };
  if (typeof signoff !== "object" || Array.isArray(signoff)) {
    return { ok: false, reason: "human_signoff is not a mapping of categories" };
  }

  const config: GateConfig = {};
  for (const [category, globs] of Object.entries(signoff as Record<string, unknown>)) {
    if (globs === null || globs === undefined) {
      config[category] = [];
      continue;
    }
    if (!Array.isArray(globs) || globs.some((g) => typeof g !== "string" || g === "")) {
      return {
        ok: false,
        reason: `category "${category}" is not a list of glob strings`,
      };
    }
    config[category] = globs as string[];
  }
  return { ok: true, config };
}

/**
 * Which gate categories do these changed paths trip? The estate config and
 * the repo extension merge by glob-list union, so an extension can only ever
 * add gates: a category redefined by the extension still carries every
 * estate glob. Returns matched category names, sorted and unique — empty
 * means the PR is ungated and may be armed.
 */
export function evaluateGates(
  estateConfig: GateConfig,
  repoExtension: GateConfig,
  changedPaths: string[]
): string[] {
  const merged: GateConfig = {};
  for (const source of [estateConfig, repoExtension]) {
    for (const [category, globs] of Object.entries(source)) {
      merged[category] = [...(merged[category] ?? []), ...globs];
    }
  }

  const matched = new Set<string>();
  for (const [category, globs] of Object.entries(merged)) {
    if (changedPaths.some((path) => globs.some((glob) => matchesGateGlob(path, glob)))) {
      matched.add(category);
    }
  }
  return [...matched].sort();
}

/**
 * Translate one bash pattern to an anchored RegExp. Bash `[[ == ]]` matching
 * knows nothing about path separators: `*` and `?` match `/` like any other
 * character, and consecutive stars collapse to one.
 */
function bashPatternToRegex(pattern: string): RegExp {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      re += ".*";
      while (pattern[i] === "*") i++;
    } else if (c === "?") {
      re += ".";
      i++;
    } else if (c === "[") {
      // Bash class: `!` (or `^`) negates, a `]` in first position is literal,
      // an unterminated `[` is a literal bracket.
      let j = i + 1;
      let body = "";
      let negate = false;
      if (pattern[j] === "!" || pattern[j] === "^") {
        negate = true;
        j++;
      }
      if (pattern[j] === "]") {
        body += "\\]";
        j++;
      }
      while (j < pattern.length && pattern[j] !== "]") {
        body += pattern[j] === "-" ? "-" : pattern[j].replace(/[\\^\]]/g, "\\$&").replace(/[.*+?()[{|$]/g, "\\$&");
        j++;
      }
      if (j >= pattern.length) {
        re += "\\[";
        i++;
      } else {
        re += `[${negate ? "^" : ""}${body}]`;
        i = j + 1;
      }
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i++;
    }
  }
  // The `s` flag keeps `.` matching newlines: bash patterns have no notion
  // of a special character, and a newline smuggled into a filename must not
  // slip a gated path past its glob (that would fail open).
  return new RegExp(`^${re}$`, "s");
}

/**
 * Does a changed path hit a gate glob? Exactly the bash evaluator's test:
 * `[[ $path == $glob ]]`, plus the root rule that a glob starting `**\/`
 * also matches with that prefix stripped.
 */
export function matchesGateGlob(path: string, glob: string): boolean {
  if (bashPatternToRegex(glob).test(path)) return true;
  if (glob.startsWith("**/") && bashPatternToRegex(glob.slice(3)).test(path)) {
    return true;
  }
  return false;
}
