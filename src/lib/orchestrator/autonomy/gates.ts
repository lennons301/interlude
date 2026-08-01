/**
 * Review-gate evaluation (issue #16) — the deterministic answer to "may this
 * agent-authored PR merge without a human?". Pure: config text and changed
 * paths come in, matched categories come out. The laptop runner's bash
 * evaluator and this module are two executors of one contract, so the glob
 * semantics here must reproduce bash `[[ == ]]` exactly: `*` (and therefore
 * `**`) crosses `/`, and the evaluator's single extension is that a leading
 * `**` + `/` also matches at the repo root.
 */

/** Label a gated PR receives; a human must approve and merge it. */
export const HUMAN_SIGNOFF_LABEL = "human-signoff";

/** Estate-wide gate config, read from the platform repo's default branch. */
export const ESTATE_GATES_PATH = "standards/review-gates.yaml";

/** A repo's additive extension, read from its own default branch. */
export const REPO_GATES_PATH = "docs/agents/review-gates.yaml";

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
  return new RegExp(`^${re}$`);
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
