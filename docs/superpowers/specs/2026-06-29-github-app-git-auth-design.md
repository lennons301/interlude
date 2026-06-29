# GitHub App Token for Git Auth — Design

**Date:** 2026-06-29
**Status:** Approved (design)
**Author:** Sean + Claude

## Problem

Agent containers authenticate git (clone + push) using a single global
fine-grained PAT (`GIT_TOKEN`), injected at container creation and baked into
the remote URL at clone time (`https://${GIT_TOKEN}@github.com/...`). PATs
expire. When the PAT expired, every `git push` failed with exit code 128 and
tasks failed at the push step — even though the agent's work itself completed.
Public repos masked the failure (clone needs no auth) until push exposed it.

Manual PAT rotation is the recurring failure mode we want to eliminate.

## Goal

Replace the PAT entirely with the **GitHub App installation token** for all git
operations. The App is already configured, working, and scoped
(`repository_selection: all`, `contents: write`) to every `lennons301` repo.
Installation tokens are minted on demand from the App private key (which does
not expire), so there is no recurring credential to rotate.

**Decision (confirmed):** App-only. Remove `GIT_TOKEN` from config, `.env`, and
docs. The GitHub App becomes **required** for git operations.

## Design

### Core mechanism: env-based git credential helper

Instead of embedding a token in the remote URL (which persists a stale secret in
`.git/config` and is why the dead token lingered), the container is configured
with a git credential helper that reads the token from an environment variable.
The remote stays a clean `https://github.com/owner/repo.git`.

At setup, `git config --global` installs:

```
credential.helper = '!f() { test "$1" = get && echo username=x-access-token && echo "password=$GIT_AUTH_TOKEN"; }; f'
```

Any git operation whose process has `GIT_AUTH_TOKEN` set in its environment then
authenticates automatically. Properties:

- No secret persisted in `.git/config`.
- No token in command arguments → cannot leak via `ps` output or git error logs.
- `git clone <clean-url>` and `git push origin HEAD` work unchanged.
- Token is supplied per-exec as an ephemeral env var, minted fresh each time.

### Token minting

`src/lib/github/client.ts` gains `getInstallationToken(): Promise<string>`,
returning the raw installation token. The existing module-level cache is
refactored to store the raw token + expiry (currently it caches an `Octokit`);
`getOctokit()` is rebuilt on top of it. The cache already refreshes ~5 minutes
before the ~1 hour expiry, so callers always get a valid token.

`getInstallationToken()` throws if the App is not configured (App ID, private
key, or installation ID missing) — see error handling below.

### Where the token is injected

The three container-manager exec wrappers mint a fresh token internally (calling
`getInstallationToken()`) and set `GIT_AUTH_TOKEN` in the exec's `Env`. This
keeps token-minting in one layer and means **no signature changes** in
`turn-manager.ts`:

| Exec wrapper | Git operations it covers | Token source |
|---|---|---|
| `execSetup` | install credential helper, `git clone`, branch checkout | fresh per call |
| `execClaudeTurn` | agent-initiated git ops during the turn (parity with old behavior) | fresh per turn |
| `execFallbackCommitAndPush` | `git add`/`commit`/`git push origin HEAD` after each turn | fresh per push |

The token is minted fresh immediately before each operation, so a long-lived
container never pushes with a stale token (a single push completes in well under
the token's ~1 hour life).

### Components changed

1. **`src/lib/github/client.ts`** — add `getInstallationToken()`; refactor cache
   to store the raw token; rebuild `getOctokit()` on top of it.
2. **`src/lib/config.ts`** — remove the `gitToken` field and the
   `if (!gitToken) throw`. Keep `gitUserName` / `gitUserEmail`.
3. **`src/lib/docker/container-manager.ts`**
   - Remove `GIT_TOKEN=${config.gitToken}` from the container's creation-time
     `Env`.
   - `execSetup`: install the credential helper, clone the clean `$GIT_URL`,
     mint + inject `GIT_AUTH_TOKEN`.
   - `execClaudeTurn`: add `GIT_AUTH_TOKEN` alongside `CLAUDE_PROMPT` in exec
     `Env`.
   - `execFallbackCommitAndPush`: mint + inject `GIT_AUTH_TOKEN`; push via
     `origin` (unchanged command).
   - Extract the bash command strings into pure builders (`buildSetupScript`,
     `buildPushScript`) for unit testing.
4. **`.env.example`, `/opt/interlude/.env`, `CLAUDE.md`** — remove `GIT_TOKEN`;
   document that the GitHub App is required for git operations and update the
   "GitHub config is optional" convention accordingly.

### Testability

The bash strings in `execSetup` / `execFallbackCommitAndPush` are currently
untestable (they run via Docker exec). Extracting them into pure functions that
return the command string lets us unit-test the credential-helper wiring (e.g.
that the helper is installed, the clone URL is token-free, push targets
`origin`) without a live container. `getInstallationToken()` caching is also
unit-tested (returns cached token within expiry, re-mints after).

## Error handling

- **App not configured:** `getInstallationToken()` throws inside `execSetup`;
  the existing `startTask` try/catch marks the task `failed` and records the
  message. The thrown error is worded clearly: "GitHub App required for git
  operations (set GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY /
  GITHUB_APP_INSTALLATION_ID)".
- **Push still fails (e.g. branch protection):** unchanged — non-zero exit code
  surfaces as today's "Commit and push failed with exit code N".

## Edge cases / tradeoffs

- **Token expiry mid-task:** avoided — fresh token per operation; cache
  refreshes 5 min before expiry.
- **Agent-initiated git ops:** `GIT_AUTH_TOKEN` is injected into the turn exec
  too, so the agent's own `git push`/`fetch` work — restoring parity with the
  old baked-PAT behavior. Net security gain: the agent now sees only a
  short-lived, installation-scoped token instead of a long-lived PAT.
- **Repo coverage:** installation is `repository_selection: all`, so every
  current/future `lennons301` repo is covered with no per-repo setup. A repo
  outside the installation would fail to clone/push (acceptable; not a current
  case).
- **Platform repo clone:** `PLATFORM_REPO_URL` is public and cloned best-effort
  (`|| echo WARN`); unchanged. The credential helper is harmless for it.
- **Convention change:** CLAUDE.md currently says "GitHub config is optional —
  all features degrade gracefully when unconfigured." With App-only git auth,
  the App is now required for any git operation. This doc supersedes that for
  git; the issue/PR App features remain as they were.

## Out of scope

- A callback-based credential helper (container → orchestrator HTTP endpoint) for
  fully decoupled token refresh. The env-injection approach covers the actual
  flows; a callback helper can be added later if needed.
- Supporting non-GitHub git hosts (the App-only decision drops that).

## Rollout

1. Implement + unit tests; `pnpm build` and `pnpm lint` clean.
2. Deploy to VPS (push to main → CI auto-deploy rebuilds app + agent images).
3. Remove the dead `GIT_TOKEN` from `/opt/interlude/.env`.
4. Verify end-to-end: create a task that edits a file and confirm the branch
   pushes and a draft PR opens.
