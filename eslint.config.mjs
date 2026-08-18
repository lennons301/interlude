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
]);

export default eslintConfig;
