import { describe, it, expect } from "vitest";
import { matchesGateGlob } from "../gates";

describe("matchesGateGlob — parity with the platform's bash evaluator", () => {
  // Every verdict below was produced by the bash evaluator itself:
  //   [[ $path == $glob ]] || { [[ $glob == '**/'* ]] && [[ $path == ${glob#**/} ]]; }
  // Bash pattern matching gives `*` (and therefore `**`) free rein across `/`,
  // and the evaluator's one extension is that a leading `**/` also matches at
  // the repo root. Notably this is NOT gitignore: `**` is not "zero or more
  // path segments", it is literally star — so `**/app/**/page.*` does not
  // match `src/app/page.tsx` (nothing between `app/` and `page.`).
  const verdicts: Array<[path: string, glob: string, matches: boolean]> = [
    // Estate visual-ui gates
    ["src/components/Button.tsx", "**/components/**", true],
    ["components/Button.tsx", "**/components/**", true], // root rule
    ["src/my-components/Button.tsx", "**/components/**", false],
    ["src/components", "**/components/**", false],
    ["src/app/admin/users/page.tsx", "**/app/**/page.*", true],
    ["app/dashboard/page.tsx", "**/app/**/page.*", true], // root rule
    ["app/page.tsx", "**/app/**/page.*", false], // ** is star, not "any depth"
    ["src/app/page.tsx", "**/app/**/page.*", false],
    // Self-gating: the gate config gates changes to itself
    ["docs/agents/review-gates.yaml", "**/review-gates.yaml", true],
    ["review-gates.yaml", "**/review-gates.yaml", true], // root rule
    ["review-gates.yaml.bak", "**/review-gates.yaml", false],
    ["standards/review-gates.yaml", "**/review-gates.yaml", true],
    // Root-level match via a leading **/
    ["middleware.ts", "**/middleware.*", true],
    ["src/middleware.ts", "**/middleware.*", true],
    [".env.local", "**/.env*", true],
    ["config/.env.production", "**/.env*", true],
    // A bare * crosses / — *.sql gates SQL anywhere in the tree
    ["schema.sql", "*.sql", true],
    ["db/schema.sql", "*.sql", true],
    // Literal paths from this repo's extension
    ["custom-server.js", "custom-server.js", true],
    ["src/custom-server.js", "custom-server.js", false],
    ["src/lib/docker/container-manager.ts", "src/lib/docker/**", true],
    ["src/lib/docker", "src/lib/docker/**", false],
    ["drizzle/0001_init.sql", "drizzle/**", true],
    // Full bash pattern language: ? and [...] also ignore /
    ["a/b.txt", "a?b.txt", true],
    ["a/b.txt", "a[/x]b.txt", true],
    ["file1.ts", "file[!0-9].ts", false],
    ["fileA.ts", "file[!0-9].ts", true],
  ];

  it.each(verdicts)("%s vs %s -> %s", (path, glob, matches) => {
    expect(matchesGateGlob(path, glob)).toBe(matches);
  });
});
