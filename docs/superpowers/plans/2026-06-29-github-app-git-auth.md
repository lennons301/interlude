# GitHub App Git Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the expiring `GIT_TOKEN` PAT with on-demand GitHub App installation tokens for all agent-container git operations, so there is no recurring credential to rotate.

**Architecture:** A git credential helper installed in the agent container reads a token from the `GIT_AUTH_TOKEN` env var; the remote URL stays secret-free. The orchestrator mints a fresh installation token (cached, auto-refreshed) and injects it as an ephemeral exec env var before each git operation (setup clone, each turn, each push).

**Tech Stack:** TypeScript, Next.js 16, dockerode, octokit, jsonwebtoken, vitest.

## Global Constraints

- App-only: `GIT_TOKEN` is removed from config, `.env`, and docs. The GitHub App is **required** for git operations.
- Installation tokens live ~1 hour; mint fresh per git operation. Never persist a token in `.git/config` or in command arguments.
- Credential helper value (verbatim): `!f() { test "$1" = get && echo username=x-access-token && echo "password=$GIT_AUTH_TOKEN"; }; f`
- Follow the existing exec polling pattern in `container-manager.ts` (do not change push/exit-code handling).
- Tests run with `npx vitest run <path>`. Commit after each task. End commit messages with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Branch: `feat/github-app-git-auth` (already created).

---

## File Structure

- `src/lib/github/client.ts` — add `isTokenFresh()` (pure) + `getInstallationToken()`; refactor cache to store the raw token; rebuild `getOctokit()` on top.
- `src/lib/github/__tests__/client.test.ts` — **new** — unit tests for `isTokenFresh()`.
- `src/lib/docker/container-manager.ts` — add pure `buildSetupScript()` / `buildPushScript()`; wire token injection into `execSetup` / `execClaudeTurn` / `execFallbackCommitAndPush`; drop `GIT_TOKEN` from container `Env`.
- `src/lib/docker/__tests__/container-manager.test.ts` — **new** — unit tests for the script builders.
- `src/lib/config.ts` — remove `gitToken` field + the `GIT_TOKEN` throw.
- `package.json` — add a `test` script.
- `.env.example`, `CLAUDE.md` — remove `GIT_TOKEN`; document App-required-for-git.

---

### Task 1: Installation-token accessor + cache refactor

**Files:**
- Modify: `src/lib/github/client.ts`
- Create: `src/lib/github/__tests__/client.test.ts`
- Modify: `package.json` (add `test` script)

**Interfaces:**
- Produces: `isTokenFresh(expiresAt: number, now: number): boolean` and `getInstallationToken(): Promise<string>`.
- Consumes: existing `createAppJwt()`, `getConfig()`.

- [ ] **Step 1: Add a `test` script to package.json**

In `package.json`, add to `"scripts"` (after `"lint": "eslint"`):

```json
    "test": "vitest run"
```

- [ ] **Step 2: Write the failing test for `isTokenFresh`**

Create `src/lib/github/__tests__/client.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { isTokenFresh } from "../client";

describe("isTokenFresh", () => {
  const now = 1_000_000_000_000;

  it("is fresh when expiry is well in the future", () => {
    expect(isTokenFresh(now + 30 * 60 * 1000, now)).toBe(true);
  });

  it("is stale within the 5-minute safety margin", () => {
    expect(isTokenFresh(now + 4 * 60 * 1000, now)).toBe(false);
  });

  it("is stale when already expired", () => {
    expect(isTokenFresh(now - 1000, now)).toBe(false);
  });

  it("treats a zero/unset expiry as stale", () => {
    expect(isTokenFresh(0, now)).toBe(false);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/lib/github/__tests__/client.test.ts`
Expected: FAIL — `isTokenFresh` is not exported.

- [ ] **Step 4: Refactor `client.ts` to add `isTokenFresh` + `getInstallationToken`**

Replace the cache state and `getOctokit` in `src/lib/github/client.ts`. The full file becomes:

```typescript
import { Octokit } from "octokit";
import jwt from "jsonwebtoken";
import { getConfig } from "../config";

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

function createAppJwt(): string {
  const config = getConfig();
  if (!config.githubAppId || !config.githubAppPrivateKey) {
    throw new Error("GitHub App not configured");
  }

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iat: now - 60,
    exp: now + 600,
    iss: config.githubAppId,
  };

  return jwt.sign(payload, config.githubAppPrivateKey, { algorithm: "RS256" });
}

export function isGitHubConfigured(): boolean {
  const config = getConfig();
  return !!(
    config.githubAppId &&
    config.githubAppPrivateKey &&
    config.githubWebhookSecret &&
    config.githubAppInstallationId
  );
}

/** Pure: is a cached token still safe to reuse (5-min margin before expiry)? */
export function isTokenFresh(expiresAt: number, now: number): boolean {
  return now < expiresAt - 5 * 60 * 1000;
}

/** Mint (or reuse a cached) GitHub App installation token for git + API use. */
export async function getInstallationToken(): Promise<string> {
  const config = getConfig();
  if (!config.githubAppId || !config.githubAppPrivateKey || !config.githubAppInstallationId) {
    throw new Error(
      "GitHub App required for git operations (set GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY / GITHUB_APP_INSTALLATION_ID)"
    );
  }

  if (cachedToken && isTokenFresh(tokenExpiresAt, Date.now())) {
    return cachedToken;
  }

  const appJwt = createAppJwt();
  const appOctokit = new Octokit({ auth: appJwt });

  const { data: installation } = await appOctokit.rest.apps.createInstallationAccessToken({
    installation_id: parseInt(config.githubAppInstallationId, 10),
  });

  cachedToken = installation.token;
  tokenExpiresAt = new Date(installation.expires_at).getTime();

  return cachedToken;
}

export async function getOctokit(): Promise<Octokit> {
  const token = await getInstallationToken();
  return new Octokit({ auth: token });
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/lib/github/__tests__/client.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add package.json src/lib/github/client.ts src/lib/github/__tests__/client.test.ts
git commit -m "feat: add getInstallationToken + isTokenFresh, cache raw token

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Pure git-command builders

**Files:**
- Modify: `src/lib/docker/container-manager.ts` (add two exported functions near the top, after the imports)
- Create: `src/lib/docker/__tests__/container-manager.test.ts`

**Interfaces:**
- Consumes: `PLATFORM_REPO_URL` (already imported in `container-manager.ts`).
- Produces: `buildSetupScript(platformRepoUrl: string): string` and `buildPushScript(): string`.

- [ ] **Step 1: Write the failing tests for the builders**

Create `src/lib/docker/__tests__/container-manager.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildSetupScript, buildPushScript } from "../container-manager";

describe("buildSetupScript", () => {
  const script = buildSetupScript("https://github.com/lennons301/platform.git");

  it("installs an env-based credential helper", () => {
    expect(script).toContain("credential.helper");
    expect(script).toContain("username=x-access-token");
    expect(script).toContain('password=$GIT_AUTH_TOKEN');
  });

  it("clones the clean repo URL with no embedded token", () => {
    expect(script).toContain('git clone "$GIT_URL" /workspace/repo');
    expect(script).not.toContain("GIT_TOKEN");
    expect(script).not.toContain("${GIT_TOKEN}@");
  });

  it("clones the platform repo and checks out the branch", () => {
    expect(script).toContain("https://github.com/lennons301/platform.git");
    expect(script).toContain('git checkout -b "$GIT_BRANCH"');
  });

  it("still writes Doppler secrets when DOPPLER_TOKEN is set", () => {
    expect(script).toContain('if [ -n "$DOPPLER_TOKEN" ]');
  });
});

describe("buildPushScript", () => {
  const script = buildPushScript();

  it("commits uncommitted changes and pushes to origin", () => {
    expect(script).toContain("git add -A");
    expect(script).toContain("git push origin HEAD");
  });

  it("does not embed any token", () => {
    expect(script).not.toContain("GIT_TOKEN");
    expect(script).not.toContain("GIT_AUTH_TOKEN");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/docker/__tests__/container-manager.test.ts`
Expected: FAIL — `buildSetupScript` / `buildPushScript` not exported.

- [ ] **Step 3: Add the builder functions**

In `src/lib/docker/container-manager.ts`, immediately after the imports (before `export interface WorkspaceOptions`), add:

```typescript
/**
 * Bash run at container setup: install an env-based git credential helper
 * (token supplied at exec time via GIT_AUTH_TOKEN), clone the repo with a
 * secret-free URL, clone the platform repo (best-effort), check out the task
 * branch, and pull Doppler secrets if a token is present.
 */
export function buildSetupScript(platformRepoUrl: string): string {
  return [
    'git config --global user.name "$GIT_USER_NAME"',
    'git config --global user.email "$GIT_USER_EMAIL"',
    `git config --global credential.helper '!f() { test "$1" = get && echo username=x-access-token && echo "password=$GIT_AUTH_TOKEN"; }; f'`,
    'git clone "$GIT_URL" /workspace/repo',
    `git clone --depth 1 ${platformRepoUrl} /workspace/platform 2>/dev/null || echo "WARN: platform repo clone failed, continuing without platform context"`,
    "cd /workspace/repo",
    'git checkout -b "$GIT_BRANCH"',
    'if [ -n "$DOPPLER_TOKEN" ]; then curl -sf --request GET "https://api.doppler.com/v3/configs/config/secrets/download?format=env" --header "Authorization: Bearer $DOPPLER_TOKEN" > .env.local && echo "Doppler: wrote .env.local ($(wc -l < .env.local) vars)" || echo "Doppler: API request failed"; fi',
  ].join(" && ");
}

/** Bash run after each turn: commit any changes and push the branch via origin. */
export function buildPushScript(): string {
  return [
    "cd /workspace/repo",
    'git add -A && git diff --cached --quiet || git commit -m "agent: uncommitted changes"',
    "git push origin HEAD",
  ].join(" && ");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/docker/__tests__/container-manager.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/docker/container-manager.ts src/lib/docker/__tests__/container-manager.test.ts
git commit -m "feat: add pure git setup/push script builders

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Wire token injection into the exec functions

**Files:**
- Modify: `src/lib/docker/container-manager.ts` (createContainer env array; `execSetup`; `execClaudeTurn`; `execFallbackCommitAndPush`)

**Interfaces:**
- Consumes: `getInstallationToken()` (Task 1), `buildSetupScript`/`buildPushScript` (Task 2), `PLATFORM_REPO_URL`.
- Produces: no signature changes — `execSetup(running)`, `execFallbackCommitAndPush(running)`, `execClaudeTurn(options)` keep their current signatures; they mint the token internally.

- [ ] **Step 1: Import the token accessor**

At the top of `src/lib/docker/container-manager.ts`, add to the imports:

```typescript
import { getInstallationToken } from "../github/client";
```

- [ ] **Step 2: Remove `GIT_TOKEN` from the container creation env**

In `createWorkspaceContainer`, delete the first line of the `env` array so it no longer injects the PAT. The array changes from:

```typescript
  const env = [
    `GIT_TOKEN=${config.gitToken}`,
    `GIT_URL=${options.gitUrl}`,
```

to:

```typescript
  const env = [
    `GIT_URL=${options.gitUrl}`,
```

- [ ] **Step 3: Update `execSetup` to use the builder + inject the token**

In `execSetup`, replace the `container.exec({...})` call. The `Cmd` becomes the builder output and an `Env` with a fresh token is added:

```typescript
export async function execSetup(
  running: RunningContainer
): Promise<void> {
  const token = await getInstallationToken();
  const exec = await running.container.exec({
    Cmd: ["bash", "-c", buildSetupScript(PLATFORM_REPO_URL)],
    Env: [`GIT_AUTH_TOKEN=${token}`],
    AttachStdout: true,
    AttachStderr: true,
  });
```

Leave the rest of `execSetup` (stream/poll handling) unchanged.

- [ ] **Step 4: Update `execClaudeTurn` to also carry the token**

In `execClaudeTurn`, change the exec `Env` to include a fresh token alongside the prompt (so agent-initiated git ops authenticate). Add `const token = await getInstallationToken();` just before the `container.exec` call, then:

```typescript
  const exec = await options.container.exec({
    Cmd: ["bash", "-c", cmdParts.join(" ")],
    Env: [`CLAUDE_PROMPT=${options.prompt}`, `GIT_AUTH_TOKEN=${token}`],
    AttachStdout: true,
    AttachStderr: true,
  });
```

- [ ] **Step 5: Update `execFallbackCommitAndPush` to use the builder + inject the token**

In `execFallbackCommitAndPush`, replace the `container.exec({...})` call:

```typescript
export async function execFallbackCommitAndPush(
  running: RunningContainer
): Promise<void> {
  const token = await getInstallationToken();
  const exec = await running.container.exec({
    Cmd: ["bash", "-c", buildPushScript()],
    Env: [`GIT_AUTH_TOKEN=${token}`],
    AttachStdout: true,
    AttachStderr: true,
  });
```

Leave the rest of `execFallbackCommitAndPush` (stream/poll/exit-code handling) unchanged.

- [ ] **Step 6: Verify the builder unit tests still pass and typecheck**

Run: `npx vitest run src/lib/docker/__tests__/container-manager.test.ts`
Expected: PASS (6 tests, unchanged).

Run: `npx tsc --noEmit`
Expected: no errors related to `container-manager.ts` (a `config.gitToken` "unused" situation is fine; it is removed in Task 4).

- [ ] **Step 7: Commit**

```bash
git add src/lib/docker/container-manager.ts
git commit -m "feat: inject GitHub App token into git execs via credential helper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Remove `gitToken` from config

**Files:**
- Modify: `src/lib/config.ts`

**Interfaces:**
- Produces: `AppConfig` no longer has a `gitToken` field. `GIT_TOKEN` is no longer read or required.

- [ ] **Step 1: Remove the `gitToken` type field**

In `src/lib/config.ts`, delete the line `  gitToken: string;` from the `AppConfig` interface.

- [ ] **Step 2: Remove the `GIT_TOKEN` read and the required-throw**

Delete `  const gitToken = process.env.GIT_TOKEN;` and the block:

```typescript
  if (!gitToken) {
    throw new Error("GIT_TOKEN is required");
  }
```

- [ ] **Step 3: Remove `gitToken` from the returned config object**

In the `_config = { ... }` object, delete the `    gitToken,` line.

- [ ] **Step 4: Verify nothing references `gitToken` and the build is clean**

Run: `grep -rn "gitToken\|GIT_TOKEN" src/`
Expected: no matches.

Run: `pnpm build`
Expected: build succeeds.

Run: `npx vitest run`
Expected: all tests pass.

Run: `pnpm lint`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/config.ts
git commit -m "refactor: drop GIT_TOKEN from config (App-only git auth)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Update env example + docs

**Files:**
- Modify: `.env.example`
- Modify: `CLAUDE.md`

**Interfaces:** none (documentation only).

- [ ] **Step 1: Update `.env.example`**

Remove the PAT lines and promote the GitHub App to required-for-git. Replace the current `.env.example` contents with:

```bash
# Auth — one of these is required:
# Option 1: Use Claude Code subscription (auto-detected from ~/.claude/.credentials.json)
# Option 2: ANTHROPIC_API_KEY=sk-ant-...

# Optional
GIT_USER_NAME=Interlude Agent
GIT_USER_EMAIL=agent@interlude.dev
KEEP_CONTAINERS=false

# Agent limits (per task)
MAX_TURNS=50
MAX_BUDGET_USD=5.00

# Deployment (production only)
# DATABASE_URL=/data/interlude.db  # set in docker-compose.yml environment block; override here only if needed
# DOMAIN=interlude.dev
# CLAUDE_CREDENTIALS_PATH=/home/deploy/.claude/.credentials.json  # host path passed to agent containers; not mounted into app container

# GitHub App — REQUIRED for git (clone/push) and for issue sync + PR creation.
# The agent authenticates git using a short-lived App installation token; there is no PAT to rotate.
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n..."
GITHUB_WEBHOOK_SECRET=whsec_...
GITHUB_APP_INSTALLATION_ID=12345678
```

- [ ] **Step 2: Update `CLAUDE.md` conventions**

In `CLAUDE.md`, under **Key Conventions**, replace the line:

```markdown
- GitHub config is optional — all features degrade gracefully when unconfigured
```

with:

```markdown
- GitHub App is REQUIRED for git auth — agent containers clone/push using short-lived App installation tokens (no PAT). Issue sync + PR features still degrade gracefully if webhook/installation are partially configured.
- Git credential helper in agent containers reads a per-exec `GIT_AUTH_TOKEN` (minted fresh from the App); no token is persisted in `.git/config`.
```

- [ ] **Step 3: Commit**

```bash
git add .env.example CLAUDE.md
git commit -m "docs: GitHub App now required for git auth; drop GIT_TOKEN

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Deploy and verify end-to-end

**Files:** none (operational). Deploy is triggered by merging to `main` (`.github/workflows/deploy.yml` deploys on push to `main`).

**Interfaces:** none.

- [ ] **Step 1: Open a PR and merge to main**

```bash
git push -u origin feat/github-app-git-auth
gh pr create --fill --title "GitHub App token for git auth (replace PAT)" --body "Replaces the expiring GIT_TOKEN PAT with on-demand GitHub App installation tokens. Spec: docs/superpowers/specs/2026-06-29-github-app-git-auth-design.md"
```

Review, then merge (squash). Merging to `main` triggers the auto-deploy workflow.

- [ ] **Step 2: Watch the deploy complete**

Run: `gh run watch` (or `gh run list --workflow=deploy.yml --limit 1`)
Expected: the deploy run for the merge commit finishes successfully.

- [ ] **Step 3: Remove the now-unused `GIT_TOKEN` from the VPS env**

```bash
ssh deploy@178.104.72.109 "sed -i '/^GIT_TOKEN=/d' /opt/interlude/.env && grep -c GIT_TOKEN /opt/interlude/.env"
```
Expected: prints `0`. (The app no longer reads it; this is cleanup.)

- [ ] **Step 4: Confirm the deployed app is healthy**

```bash
curl -sS -o /dev/null -w "%{http_code}\n" https://interludes.co.uk/api/tasks
```
Expected: `200`.

- [ ] **Step 5: End-to-end push verification**

In the UI, create a task on the `lemons` project that makes a trivial change (e.g. "Add a line to README"). Then confirm via the orchestrator logs and GitHub:

```bash
ssh deploy@178.104.72.109 "docker logs interlude-app-1 --tail 40 2>&1 | grep -iE 'push|branch|Push failed|Push warning'"
```
Expected: a `Branch '...' pushed.` message and **no** "Push failed" / "exit code 128".

Then confirm the branch exists on GitHub:

```bash
git ls-remote https://github.com/lennons301/lemons "refs/heads/agent/*"
```
Expected: at least one `agent/<taskId>` ref is listed.

- [ ] **Step 6: Done**

The system is restored and self-maintaining for git auth. No further commit needed (deploy is the deliverable).

---

## Notes for the executor

- Do not change the stream/poll/exit-code handling in `execSetup` or `execFallbackCommitAndPush` — only the `exec({...})` `Cmd`/`Env` arguments change.
- The credential-helper string must be passed inside `bash -c` as a single argument (it already is, via the dockerode `Cmd` array), so its inner `&&`/`;`/`{}` are not re-interpreted by the join separators.
- Public repos cloned fine even with the dead PAT; the real signal of success is a **push** with no exit-128, which Step 5 checks.
