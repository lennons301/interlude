# Phase 3: GitHub Integration — Design Spec

## Goal

Connect Interlude to GitHub so that labeled issues automatically become agent tasks, and agent work automatically produces draft PRs. The platform acts as a GitHub App — no personal access tokens to manage for API operations.

## Architecture

```
GitHub                          Interlude (VPS)
  |                                |
  |-- issue labeled "interlude" -->|-- webhook verified
  |                                |-- task created (queued)
  |<-- comment: "task queued" -----|
  |                                |
  |                                |-- agent picks up task
  |<-- comment: "agent working" ---|
  |                                |-- agent pushes branch
  |<-- draft PR created -----------|
  |                                |
  |                                |-- task completed
  |<-- PR marked ready for review -|
  |<-- comment: "complete, $0.08" -|
```

**Two data flows:**

1. **Inbound (GitHub -> Interlude):** Issue labeled `interlude` -> webhook -> create task (queued) -> agent picks up when ready
2. **Outbound (Interlude -> GitHub):** Agent pushes branch -> create draft PR on first push -> mark PR ready on completion -> comment on issue with status updates

## Authentication

**GitHub App** registered at github.com/settings/apps, installed on target repos.

- JWT created from App ID + private key on startup
- Exchanged for installation token (valid 1 hour, auto-refreshed)
- All GitHub API calls (PRs, comments) use installation tokens
- Installation ID stored as env var (single-user platform, no dynamic lookup needed)

**Existing `GIT_TOKEN` PAT stays** for git clone/push inside agent containers. The GitHub App tokens are used by the Interlude app itself for API calls. This separation is intentional — mounting App tokens into ephemeral agent containers adds complexity with no benefit.

**Environment variables:**

```
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n..."
GITHUB_WEBHOOK_SECRET=whsec_...
GITHUB_APP_INSTALLATION_ID=12345678
```

**Library:** `octokit` — official GitHub SDK. Handles JWT signing, token refresh, and all API calls.

## GitHub App Configuration

**Permissions:**
- Issues: read/write (receive events, post status comments)
- Pull Requests: read/write (create/update PRs)
- Contents: read/write (branch metadata)

**Webhook events subscribed:**
- `issues` (opened, labeled)

**Webhook URL:** `https://interludes.co.uk/api/webhooks/github`

## Inbound Flow: Issue -> Task

**Trigger:** `issues` webhook with action `labeled`, label name `interlude`.

**Steps:**
1. Receive webhook POST, verify HMAC-SHA256 signature with `GITHUB_WEBHOOK_SECRET`
2. Extract: issue title, body, number, repo full name (`owner/repo`)
3. Check for duplicate — if a task already exists with this `githubIssue`, ignore (idempotent)
4. Look up project by `githubRepo` matching repo full name
5. If no matching project: comment on issue ("This repo is not connected to an Interlude project") and stop
6. Extract agent prompt: if body contains `## Prompt` section, use that content; otherwise use title + body verbatim
7. Create task with `githubIssue` set to `owner/repo#number`, status `queued`
8. Comment on issue: "Task queued — agent will pick this up shortly" with link to Interlude task page

**Edge cases:**
- No matching project -> comment on issue with feedback, do not create task
- Duplicate issue -> ignore silently (already linked)
- Label removed -> no action (task persists, can be cancelled manually from Interlude)

## Outbound Flow: Agent -> PR

### Draft PR Creation

After the first successful `git push` of an agent branch (in `runPostTurnCommitAndPush`), if no PR exists yet for this task:

1. Call GitHub API to create a draft PR
   - Title: task title
   - Body: link to Interlude task page; if linked to an issue, include `Closes #N`
   - Base: repo default branch
   - Head: `agent/{taskId}`
   - Draft: `true`
2. Store PR number and URL on the task record
3. If task is linked to a GitHub issue, comment: "Draft PR opened: #N"

### PR Update on Completion

When `completeTask` runs:

1. Mark the draft PR as ready for review via GitHub API
2. Comment on the PR with a summary (cost, turn count)
3. If linked to a GitHub issue, comment: "Complete — PR #N ready for review ($X.XX)"

### Issue Status Comments

At key lifecycle points, post a comment on the linked GitHub issue:

| Event | Comment |
|-------|---------|
| Task queued | "Task queued — agent will pick this up shortly" + Interlude link |
| Agent started | "Agent working" + Interlude link |
| Draft PR created | "Draft PR opened: #N" |
| Task completed | "Complete — PR #N ready for review ($X.XX)" |
| Task failed | "Task failed — check Interlude for details" + link |

## Schema Changes

**Tasks table — new fields:**
```
pullRequestNumber: int("pull_request_number")
pullRequestUrl: text("pull_request_url")
```

**Existing fields now actively used:**
- `githubIssue: text("github_issue")` — stores `owner/repo#123` format

**Projects table — existing field clarified:**
- `githubRepo: text("github_repo")` — stores `owner/repo` format (e.g. `lennons301/lemons`), used to match incoming webhooks to projects

## New Files

```
src/lib/github/
  client.ts          — Octokit instance, JWT auth, token refresh
  webhooks.ts        — Webhook signature verification, event parsing
  issues.ts          — Issue comment helpers
  pull-requests.ts   — PR creation, draft->ready conversion

src/app/api/webhooks/github/route.ts  — Webhook receiver endpoint
```

## Integration Points (Existing Code Changes)

**`src/lib/orchestrator/turn-manager.ts`:**
- After first `runPostTurnCommitAndPush`: create draft PR if none exists
- In `completeTask`: mark PR as ready for review, post issue comments
- On task start: post "agent working" comment on linked issue

**`src/lib/orchestrator/init.ts`:**
- Initialize GitHub client on startup (validate env vars, create JWT)

**`src/components/task-chat.tsx`:**
- Show linked issue number in task header (clickable link to GitHub)
- Show PR link when available (clickable link to GitHub)

**`src/app/api/tasks/[id]/stream/route.ts`:**
- Include `githubIssue`, `pullRequestNumber`, `pullRequestUrl` in `taskStatus` events

## Config Changes

**`src/lib/config.ts`** — new optional fields:
```typescript
githubAppId: string | null
githubAppPrivateKey: string | null
githubWebhookSecret: string | null
githubAppInstallationId: string | null
```

All nullable — GitHub integration is optional. When unconfigured, webhook endpoint returns 404, PR creation is skipped, issue comments are skipped. The platform works exactly as before.

## Queuing Behavior

No changes to the existing queue. Webhook-created tasks enter the queue with status `queued`, same as manually-created tasks. The existing 2-second poll in `queue.ts` picks them up in order. On a single CX22 VPS, one agent runs at a time — additional tasks wait in the queue.

Future phases (Phase 4: notifications, Phase 6: remote compute) will add queue awareness and scaling respectively.

## What This Phase Does NOT Include

- **Comment-to-agent forwarding** — GitHub issue comments are not forwarded as follow-up messages to the running agent. Use the Interlude chat UI for interactive follow-up.
- **Label removal handling** — Removing the `interlude` label does not cancel the task.
- **Multiple GitHub App installations** — Single installation ID, single-user platform.
- **Concurrent agents** — One agent at a time, additional tasks queue (addressed in Phase 6).
- **Notifications** — No Slack/Telegram alerts when tasks complete (addressed in Phase 4).

## Testing Strategy

1. **Webhook verification:** Unit test HMAC signature validation with known payloads
2. **Issue -> task flow:** Create a test issue, label it, verify task appears in Interlude
3. **PR creation:** Run a task, verify draft PR created on GitHub after first push
4. **PR completion:** Complete a task, verify PR marked as ready for review
5. **Issue comments:** Verify comments posted at each lifecycle stage
6. **Edge cases:** Duplicate issues, missing projects, unconfigured GitHub App
7. **E2E on VPS:** Full flow — label an issue on GitHub, watch task appear, agent works, PR created
