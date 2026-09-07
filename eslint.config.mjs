import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    // Every GitHub client must carry the request bound (issue #151): a stalled
    // call that hangs forever leaves whatever awaited it unsettled, and that is
    // how one post-turn call wedged the box's only queue slot. `createOctokit`
    // in src/lib/github/client.ts is the one place that builds one, so this is
    // enforced here rather than by a test that reads source text.
    files: ["src/**/*.ts", "src/**/*.tsx"],
    ignores: ["src/lib/github/client.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "NewExpression[callee.name='Octokit']",
          message:
            "Build GitHub clients with createOctokit() from @/lib/github/client so every request carries the timeout (issue #151).",
        },
      ],
    },
  },
  {
    // Only the orchestrator's own loop may run an autonomy sweep (issue #163).
    // Route handlers are compiled into a separate module graph from
    // `instrumentation.ts`, so a sweep started from one runs against a second,
    // empty copy of every flag in sweep.ts — single-flight, in-flight claims,
    // the fleet-health debounce — which claimed one ticket twice and silenced
    // a standing needs-you card in production. A route that needs a sweep
    // records a nudge via `requestAutonomySweep` (sweep-nudge.ts) and the loop
    // picks it up within a second. Enforced here rather than by a test that
    // reads source text, like the Octokit rule above.
    files: ["src/app/**/*.ts", "src/app/**/*.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/orchestrator/autonomy/sweep", "@/lib/orchestrator/autonomy/sweep"],
              message:
                "Route handlers run on a separate module graph and must not sweep. Call requestAutonomySweep() from @/lib/orchestrator/autonomy/sweep-nudge instead (issue #163).",
            },
          ],
        },
      ],
      // `no-restricted-imports` only sees static imports; a dynamic
      // `await import("…/autonomy/sweep")` — the shape client.ts already uses
      // to dodge a cycle — would slip past it. Close that door too.
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "ImportExpression > Literal[value=/(^|\\/)orchestrator\\/autonomy\\/sweep$/]",
          message:
            "Route handlers run on a separate module graph and must not sweep, dynamically or otherwise. Call requestAutonomySweep() from @/lib/orchestrator/autonomy/sweep-nudge instead (issue #163).",
        },
      ],
    },
  },
]);

export default eslintConfig;
