import { describe, it, expect } from "vitest";
import {
  evaluateGates,
  matchesGateGlob,
  parseGateConfig,
  type GateConfig,
} from "../gates";

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
    // Bash * matches absolutely anything — a newline smuggled into a
    // filename must not slip a gated path past its glob
    ["evil\nname/schema.sql", "*.sql", true],
  ];

  it.each(verdicts)("%s vs %s -> %s", (path, glob, matches) => {
    expect(matchesGateGlob(path, glob)).toBe(matches);
  });
});

describe("parseGateConfig", () => {
  it("parses categories and their globs from the estate shape", () => {
    const text = [
      "human_signoff:",
      "  visual-ui:",
      '    - "**/components/**"',
      '    - "**/app/**/page.*"',
      "  persistence:",
      '    - "**/migrations/**"',
    ].join("\n");

    expect(parseGateConfig(text)).toEqual({
      ok: true,
      config: {
        "visual-ui": ["**/components/**", "**/app/**/page.*"],
        persistence: ["**/migrations/**"],
      },
    });
  });

  it("accepts an empty human_signoff mapping as a config with no gates", () => {
    // A migrated repo with nothing extra to gate ships exactly this file
    expect(parseGateConfig("# nothing beyond the estate\nhuman_signoff:\n")).toEqual({
      ok: true,
      config: {},
    });
  });

  it("rejects invalid YAML with a reason", () => {
    const result = parseGateConfig("human_signoff:\n  visual-ui: [unclosed");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBeTruthy();
  });

  it("rejects a document without a human_signoff mapping", () => {
    expect(parseGateConfig("signoff:\n  visual-ui:\n    - '*'\n").ok).toBe(false);
    expect(parseGateConfig("").ok).toBe(false);
  });

  it("rejects a category whose globs are not a list of strings", () => {
    expect(parseGateConfig("human_signoff:\n  visual-ui: '**/components/**'\n").ok).toBe(false);
    expect(parseGateConfig("human_signoff:\n  visual-ui:\n    - 42\n").ok).toBe(false);
  });

  it("treats a category with no globs as empty rather than an error", () => {
    // A commented-out category leaves `name:` with a null value behind
    expect(parseGateConfig("human_signoff:\n  visual-ui:\n")).toEqual({
      ok: true,
      config: { "visual-ui": [] },
    });
  });
});

describe("evaluateGates", () => {
  // Estate categories as documented in the repo extension's header
  const estate: GateConfig = {
    "visual-ui": ["**/components/**", "**/app/**/page.*", "**/app/**/layout.*"],
    persistence: ["**/migrations/**", "*.sql"],
    "gate-config": ["**/review-gates.yaml"],
  };
  const extension: GateConfig = {
    infrastructure: ["custom-server.js", "Caddyfile"],
    persistence: ["src/db/schema.ts", "drizzle/**"],
  };

  it("returns no matches for paths no glob covers", () => {
    expect(evaluateGates(estate, extension, ["src/lib/ulid.ts", "README.md"])).toEqual([]);
  });

  it("names every matched category once, sorted", () => {
    const matches = evaluateGates(estate, extension, [
      "src/components/Button.tsx",
      "src/components/Card.tsx",
      "custom-server.js",
      "db/schema.sql",
    ]);
    expect(matches).toEqual(["infrastructure", "persistence", "visual-ui"]);
  });

  it("matches categories added by the repo extension", () => {
    expect(evaluateGates(estate, extension, ["Caddyfile"])).toEqual(["infrastructure"]);
  });

  it("keeps estate globs live when the extension redefines their category", () => {
    // Additive-only: the extension's own `persistence` globs cannot shadow
    // the estate's — a *.sql change still gates even though the extension's
    // persistence list doesn't mention it.
    expect(evaluateGates(estate, extension, ["db/schema.sql"])).toEqual(["persistence"]);
    expect(evaluateGates(estate, extension, ["src/db/schema.ts"])).toEqual(["persistence"]);
  });

  it("gates a PR that touches the gate config itself", () => {
    expect(evaluateGates(estate, extension, ["docs/agents/review-gates.yaml"])).toEqual([
      "gate-config",
    ]);
  });

  it("evaluates with an empty extension against the estate alone", () => {
    expect(evaluateGates(estate, {}, ["app/dashboard/page.tsx"])).toEqual(["visual-ui"]);
  });

  it("returns no matches for an empty change set", () => {
    expect(evaluateGates(estate, extension, [])).toEqual([]);
  });
});
