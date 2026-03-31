# Phase 3: GitHub Integration — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect Interlude to GitHub via a GitHub App so labeled issues become agent tasks and agent work produces draft PRs automatically.

**Architecture:** GitHub App receives webhooks at `/api/webhooks/github`. Issue labeled `interlude` → task created. Agent pushes branch → draft PR created. Task completes → PR marked ready for review. Octokit handles auth via installation tokens (JWT → short-lived token, auto-refreshed).

**Tech Stack:** octokit (GitHub SDK), crypto (webhook HMAC verification), jsonwebtoken (JWT for App auth)

**Spec:** `docs/specs/2026-03-27-phase3-github-integration-design.md`

---

## File Structure

```
src/lib/github/
  client.ts              — NEW: Octokit instance, JWT auth, installation token management
  webhooks.ts            — NEW: Webhook signature verification
  issues.ts              — NEW: Post comments on issues
  pull-requests.ts       — NEW: Create draft PR, mark ready for review

src/app/api/webhooks/github/route.ts  — NEW: Webhook receiver endpoint

src/db/schema.ts                      — MODIFY: add pullRequestNumber, pullRequestUrl to tasks
src/lib/config.ts                     — MODIFY: add GitHub App config fields
src/lib/orchestrator/init.ts          — MODIFY: log GitHub App status on startup
src/lib/orchestrator/turn-manager.ts  — MODIFY: create PR after first push, update on complete, post issue comments
src/app/api/tasks/[id]/stream/route.ts — MODIFY: include githubIssue, PR fields in SSE
src/app/tasks/[id]/page.tsx           — MODIFY: pass githubIssue, PR fields to TaskChat
src/components/task-chat.tsx          — MODIFY: show issue + PR links in header
```

---

## Task 1: Install Dependencies + Schema Migration

**Files:**
- Modify: `package.json`
- Modify: `src/db/schema.ts:24-26`

- [ ] **Step 1: Install octokit and jsonwebtoken**

```bash
pnpm add octokit jsonwebtoken
pnpm add -D @types/jsonwebtoken
```

- [ ] **Step 2: Add PR fields to tasks schema**

In `src/db/schema.ts`, add after the `previewSubdomain` field (line ~26):

```typescript
pullRequestNumber: int("pull_request_number"),
pullRequestUrl: text("pull_request_url"),
```

- [ ] **Step 3: Run migration**

```bash
npx drizzle-kit push
```

- [ ] **Step 4: Build to verify**

```bash
pnpm build
```

Expected: Build passes, no type errors.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml src/db/schema.ts
git commit -m "feat: add octokit deps and PR fields to tasks schema"
```

---

## Task 2: GitHub App Config

**Files:**
- Modify: `src/lib/config.ts`
- Modify: `.env.example`

- [ ] **Step 1: Add GitHub App fields to config**

In `src/lib/config.ts`, add to the `AppConfig` interface after `domain`:

```typescript
/** GitHub App ID (from app settings page) */
githubAppId: string | null;
/** GitHub App private key PEM content */
githubAppPrivateKey: string | null;
/** Secret for verifying webhook signatures */
githubWebhookSecret: string | null;
/** Installation ID for the GitHub App on your account */
githubAppInstallationId: string | null;
```

And in the `getConfig()` return object:

```typescript
githubAppId: process.env.GITHUB_APP_ID ?? null,
githubAppPrivateKey: process.env.GITHUB_APP_PRIVATE_KEY ?? null,
githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET ?? null,
githubAppInstallationId: process.env.GITHUB_APP_INSTALLATION_ID ?? null,
```

- [ ] **Step 2: Update .env.example**

Add to `.env.example`:

```
# GitHub App (optional — enables issue sync + auto PR creation)
# GITHUB_APP_ID=123456
# GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n..."
# GITHUB_WEBHOOK_SECRET=whsec_...
# GITHUB_APP_INSTALLATION_ID=12345678
```

- [ ] **Step 3: Build to verify**

```bash
pnpm build
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/config.ts .env.example
git commit -m "feat: add GitHub App configuration fields"
```

---

## Task 3: GitHub Client (Octokit + Auth)

**Files:**
- Create: `src/lib/github/client.ts`

- [ ] **Step 1: Create the GitHub client module**

Create `src/lib/github/client.ts`:

```typescript
import { Octokit } from "octokit";
import jwt from "jsonwebtoken";
import { getConfig } from "../config";

let cachedOctokit: Octokit | null = null;
let tokenExpiresAt = 0;

function createAppJwt(): string {
  const config = getConfig();
  if (!config.githubAppId || !config.githubAppPrivateKey) {
    throw new Error("GitHub App not configured");
  }

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iat: now - 60, // 60s clock drift tolerance
    exp: now + 600, // 10 minute expiry
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

export async function getOctokit(): Promise<Octokit> {
  const config = getConfig();
  if (!config.githubAppInstallationId) {
    throw new Error("GitHub App installation ID not configured");
  }

  // Return cached client if token is still valid (with 5 min buffer)
  if (cachedOctokit && Date.now() < tokenExpiresAt - 5 * 60 * 1000) {
    return cachedOctokit;
  }

  // Create a temporary App-level Octokit to get an installation token
  const appJwt = createAppJwt();
  const appOctokit = new Octokit({ auth: appJwt });

  const { data: installation } = await appOctokit.rest.apps.createInstallationAccessToken({
    installation_id: parseInt(config.githubAppInstallationId, 10),
  });

  cachedOctokit = new Octokit({ auth: installation.token });
  tokenExpiresAt = new Date(installation.expires_at).getTime();

  return cachedOctokit;
}
```

- [ ] **Step 2: Build to verify**

```bash
pnpm build
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/github/client.ts
git commit -m "feat: GitHub App client with JWT auth and token caching"
```

---

## Task 4: Webhook Signature Verification

**Files:**
- Create: `src/lib/github/webhooks.ts`

- [ ] **Step 1: Create webhook verification module**

Create `src/lib/github/webhooks.ts`:

```typescript
import { createHmac, timingSafeEqual } from "crypto";
import { getConfig } from "../config";

export function verifyWebhookSignature(
  payload: string,
  signature: string | null
): boolean {
  const secret = getConfig().githubWebhookSecret;
  if (!secret || !signature) return false;

  const expected = "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");

  if (expected.length !== signature.length) return false;

  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
```

- [ ] **Step 2: Build to verify**

```bash
pnpm build
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/github/webhooks.ts
git commit -m "feat: webhook HMAC-SHA256 signature verification"
```

---

## Task 5: Issue Comment Helpers

**Files:**
- Create: `src/lib/github/issues.ts`

- [ ] **Step 1: Create issue comment module**

Create `src/lib/github/issues.ts`:

```typescript
import { getOctokit, isGitHubConfigured } from "./client";

/**
 * Parse "owner/repo#123" into parts. Returns null if format doesn't match.
 */
export function parseIssueRef(ref: string): { owner: string; repo: string; number: number } | null {
  const match = ref.match(/^([^/]+)\/([^#]+)#(\d+)$/);
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: parseInt(match[3], 10) };
}

/**
 * Post a comment on a GitHub issue. No-op if GitHub is not configured.
 */
export async function commentOnIssue(
  issueRef: string,
  body: string
): Promise<void> {
  if (!isGitHubConfigured()) return;

  const parsed = parseIssueRef(issueRef);
  if (!parsed) return;

  try {
    const octokit = await getOctokit();
    await octokit.rest.issues.createComment({
      owner: parsed.owner,
      repo: parsed.repo,
      issue_number: parsed.number,
      body,
    });
  } catch (err) {
    console.error(`[github] Failed to comment on ${issueRef}:`, err);
  }
}
```

- [ ] **Step 2: Build to verify**

```bash
pnpm build
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/github/issues.ts
git commit -m "feat: GitHub issue comment helpers"
```

---

## Task 6: Pull Request Helpers

**Files:**
- Create: `src/lib/github/pull-requests.ts`

- [ ] **Step 1: Create PR module**

Create `src/lib/github/pull-requests.ts`:

```typescript
import { getOctokit, isGitHubConfigured } from "./client";

interface CreatePrOptions {
  owner: string;
  repo: string;
  title: string;
  body: string;
  head: string; // branch name
  base?: string; // defaults to repo default branch
}

interface PrResult {
  number: number;
  url: string;
}

/**
 * Create a draft PR. Returns the PR number and URL.
 */
export async function createDraftPr(options: CreatePrOptions): Promise<PrResult | null> {
  if (!isGitHubConfigured()) return null;

  try {
    const octokit = await getOctokit();

    // Get default branch if base not specified
    let base = options.base;
    if (!base) {
      const { data: repo } = await octokit.rest.repos.get({
        owner: options.owner,
        repo: options.repo,
      });
      base = repo.default_branch;
    }

    const { data: pr } = await octokit.rest.pulls.create({
      owner: options.owner,
      repo: options.repo,
      title: options.title,
      body: options.body,
      head: options.head,
      base,
      draft: true,
    });

    return { number: pr.number, url: pr.html_url };
  } catch (err) {
    console.error(`[github] Failed to create draft PR:`, err);
    return null;
  }
}

/**
 * Mark a draft PR as ready for review.
 */
export async function markPrReady(
  owner: string,
  repo: string,
  prNumber: number
): Promise<void> {
  if (!isGitHubConfigured()) return;

  try {
    const octokit = await getOctokit();

    // The REST API doesn't support marking ready — use GraphQL
    const { data: pr } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });

    if (!pr.draft) return; // Already not a draft

    await octokit.graphql(`
      mutation($id: ID!) {
        markPullRequestReadyForReview(input: { pullRequestId: $id }) {
          pullRequest { id }
        }
      }
    `, { id: pr.node_id });
  } catch (err) {
    console.error(`[github] Failed to mark PR #${prNumber} ready:`, err);
  }
}
```

- [ ] **Step 2: Build to verify**

```bash
pnpm build
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/github/pull-requests.ts
git commit -m "feat: GitHub PR creation and draft-to-ready helpers"
```

---

## Task 7: Webhook Receiver Endpoint

**Files:**
- Create: `src/app/api/webhooks/github/route.ts`

- [ ] **Step 1: Create the webhook route**

Create `src/app/api/webhooks/github/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { db } from "@/db";
import { tasks, projects } from "@/db/schema";
import { eq } from "drizzle-orm";
import { newId } from "@/lib/ulid";
import { verifyWebhookSignature } from "@/lib/github/webhooks";
import { commentOnIssue } from "@/lib/github/issues";
import { isGitHubConfigured } from "@/lib/github/client";

export const dynamic = "force-dynamic";

const TRIGGER_LABEL = "interlude";

export async function POST(request: Request) {
  if (!isGitHubConfigured()) {
    return NextResponse.json({ error: "GitHub App not configured" }, { status: 404 });
  }

  const body = await request.text();
  const signature = request.headers.get("x-hub-signature-256");

  if (!verifyWebhookSignature(body, signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const event = request.headers.get("x-github-event");
  const payload = JSON.parse(body);

  if (event === "issues" && payload.action === "labeled") {
    const label = payload.label?.name;
    if (label !== TRIGGER_LABEL) {
      return NextResponse.json({ ok: true, skipped: "wrong label" });
    }

    const issue = payload.issue;
    const repo = payload.repository;
    const repoFullName = repo.full_name; // "owner/repo"
    const issueRef = `${repoFullName}#${issue.number}`;

    // Check for duplicate
    const existing = db
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.githubIssue, issueRef))
      .get();

    if (existing) {
      return NextResponse.json({ ok: true, skipped: "duplicate" });
    }

    // Find matching project
    const project = db
      .select()
      .from(projects)
      .where(eq(projects.githubRepo, repoFullName))
      .get();

    if (!project) {
      await commentOnIssue(
        issueRef,
        `This repo (\`${repoFullName}\`) is not connected to an Interlude project. Add it at [Interlude](https://interludes.co.uk) first.`
      );
      return NextResponse.json({ ok: true, skipped: "no project" });
    }

    // Extract prompt: use ## Prompt section if present, otherwise title + body
    let description = issue.body || "";
    const promptMatch = description.match(/## Prompt\s*\n([\s\S]*?)(?=\n## |\n$|$)/);
    if (promptMatch) {
      description = promptMatch[1].trim();
    }

    const domain = process.env.DOMAIN ?? "interludes.co.uk";
    const taskId = newId();
    const now = new Date();

    db.insert(tasks)
      .values({
        id: taskId,
        projectId: project.id,
        title: issue.title,
        description,
        status: "queued",
        githubIssue: issueRef,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    await commentOnIssue(
      issueRef,
      `Task queued — agent will pick this up shortly.\n\n[View in Interlude](https://${domain}/tasks/${taskId})`
    );

    console.log(`[github] Issue ${issueRef} → task ${taskId} (queued)`);
    return NextResponse.json({ ok: true, taskId });
  }

  return NextResponse.json({ ok: true, skipped: "unhandled event" });
}
```

- [ ] **Step 2: Build to verify**

```bash
pnpm build
```

- [ ] **Step 3: Commit**

```bash
git add src/app/api/webhooks/github/route.ts
git commit -m "feat: GitHub webhook receiver — issue labeled creates task"
```

---

## Task 8: Integrate PR Creation into Turn Manager

**Files:**
- Modify: `src/lib/orchestrator/turn-manager.ts:332-344` (runPostTurnCommitAndPush)
- Modify: `src/lib/orchestrator/turn-manager.ts:235-279` (completeTask)
- Modify: `src/lib/orchestrator/turn-manager.ts:396-414` (updateTask)

- [ ] **Step 1: Add PR fields to updateTask**

In `src/lib/orchestrator/turn-manager.ts`, add to the `updateTask` fields type (around line 398-408):

```typescript
pullRequestNumber: number | null;
pullRequestUrl: string | null;
```

- [ ] **Step 2: Add imports at top of turn-manager.ts**

Add after the existing imports:

```typescript
import { commentOnIssue, parseIssueRef } from "../github/issues";
import { createDraftPr, markPrReady } from "../github/pull-requests";
```

- [ ] **Step 3: Create draft PR after first push**

In `runPostTurnCommitAndPush` (around line 332), after the existing `execFallbackCommitAndPush` call, add PR creation logic. Replace the function:

```typescript
async function runPostTurnCommitAndPush(
  taskId: string,
  running: RunningContainer
): Promise<void> {
  await execFallbackCommitAndPush(running);

  // Create draft PR on first push if none exists yet
  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (task && !task.pullRequestNumber && task.branch && task.githubIssue) {
    const parsed = parseIssueRef(task.githubIssue);
    if (parsed) {
      const domain = process.env.DOMAIN ?? "interludes.co.uk";
      const issueClause = `Closes #${parsed.number}`;
      const body = `${issueClause}\n\n[View in Interlude](https://${domain}/tasks/${taskId})`;

      const pr = await createDraftPr({
        owner: parsed.owner,
        repo: parsed.repo,
        title: task.title,
        head: task.branch,
        body,
      });

      if (pr) {
        updateTask(taskId, {
          pullRequestNumber: pr.number,
          pullRequestUrl: pr.url,
        });
        await commentOnIssue(task.githubIssue, `Draft PR opened: #${pr.number}`);
        console.log(`[github] Draft PR #${pr.number} created for task ${taskId}`);
      }
    }
  }
}
```

- [ ] **Step 4: Mark PR ready on task completion and post issue comments**

In `completeTask` (around line 235), after the existing `execFallbackCommitAndPush` call and before `removeContainer`, add:

```typescript
    // Mark PR ready for review and post completion comment
    if (task.pullRequestNumber && task.githubIssue) {
      const parsed = parseIssueRef(task.githubIssue);
      if (parsed) {
        await markPrReady(parsed.owner, parsed.repo, task.pullRequestNumber);
        const cost = (task.totalCostUsd ?? 0).toFixed(2);
        await commentOnIssue(
          task.githubIssue,
          `Complete — PR #${task.pullRequestNumber} ready for review ($${cost})`
        );
      }
    }
```

- [ ] **Step 5: Post "agent working" comment when task starts**

In `startTask` (around line 40), after the task status is set to "running" and before the first Claude turn, add:

```typescript
    // Notify GitHub issue that agent has started
    if (proj && task.githubIssue) {
      const domain = process.env.DOMAIN ?? "interludes.co.uk";
      commentOnIssue(
        task.githubIssue,
        `Agent working\n\n[View in Interlude](https://${domain}/tasks/${taskId})`
      ).catch(console.error);
    }
```

- [ ] **Step 6: Build to verify**

```bash
pnpm build
```

- [ ] **Step 7: Commit**

```bash
git add src/lib/orchestrator/turn-manager.ts
git commit -m "feat: auto-create draft PR on first push, mark ready on completion"
```

---

## Task 9: SSE Stream + Frontend Updates

**Files:**
- Modify: `src/app/api/tasks/[id]/stream/route.ts`
- Modify: `src/app/tasks/[id]/page.tsx`
- Modify: `src/components/task-chat.tsx`

- [ ] **Step 1: Include GitHub fields in SSE taskStatus**

In `src/app/api/tasks/[id]/stream/route.ts`, add to the `send` call in the taskStatus block (around line 80):

```typescript
githubIssue: task.githubIssue ?? null,
pullRequestNumber: task.pullRequestNumber ?? null,
pullRequestUrl: task.pullRequestUrl ?? null,
```

- [ ] **Step 2: Pass GitHub fields from task page**

In `src/app/tasks/[id]/page.tsx`, add to the task prop object:

```typescript
githubIssue: task.githubIssue,
pullRequestNumber: task.pullRequestNumber,
pullRequestUrl: task.pullRequestUrl,
```

- [ ] **Step 3: Add TaskStatusUpdate fields in task-chat.tsx**

In `src/components/task-chat.tsx`, add to the `TaskStatusUpdate` type:

```typescript
githubIssue?: string | null;
pullRequestNumber?: number | null;
pullRequestUrl?: string | null;
```

Add to the `TaskData` interface:

```typescript
githubIssue: string | null;
pullRequestNumber: number | null;
pullRequestUrl: string | null;
```

- [ ] **Step 4: Track GitHub fields in TaskChat state**

Add state variables and update them from SSE:

```typescript
const [githubIssue, setGithubIssue] = useState<string | null>(initialTask.githubIssue);
const [pullRequestUrl, setPullRequestUrl] = useState<string | null>(initialTask.pullRequestUrl);
const [pullRequestNumber, setPullRequestNumber] = useState<number | null>(initialTask.pullRequestNumber);
```

In `handleStatusChange`:

```typescript
if (status.githubIssue !== undefined) setGithubIssue(status.githubIssue);
if (status.pullRequestUrl !== undefined) setPullRequestUrl(status.pullRequestUrl);
if (status.pullRequestNumber !== undefined) setPullRequestNumber(status.pullRequestNumber);
```

- [ ] **Step 5: Show issue and PR links in task header**

In the task header area of `task-chat.tsx` (where branch is shown), add after the branch display:

```tsx
{githubIssue && (
  <a
    href={`https://github.com/${githubIssue.replace("#", "/issues/")}`}
    target="_blank"
    rel="noopener noreferrer"
    className="text-xs text-blue-400 hover:text-blue-300"
  >
    {githubIssue}
  </a>
)}
{pullRequestUrl && (
  <a
    href={pullRequestUrl}
    target="_blank"
    rel="noopener noreferrer"
    className="text-xs text-blue-400 hover:text-blue-300"
  >
    PR #{pullRequestNumber}
  </a>
)}
```

- [ ] **Step 6: Build to verify**

```bash
pnpm build
```

- [ ] **Step 7: Commit**

```bash
git add src/app/api/tasks/[id]/stream/route.ts src/app/tasks/[id]/page.tsx src/components/task-chat.tsx
git commit -m "feat: show GitHub issue and PR links in task UI"
```

---

## Task 10: Startup Logging + Init

**Files:**
- Modify: `src/lib/orchestrator/init.ts`

- [ ] **Step 1: Log GitHub App status on startup**

In `src/lib/orchestrator/init.ts`, add import at top:

```typescript
import { isGitHubConfigured } from "../github/client";
```

In `initOrchestrator`, after the Docker available log (line 108), add:

```typescript
    if (isGitHubConfigured()) {
      console.log("[orchestrator] GitHub App configured — webhooks and PR creation enabled");
    } else {
      console.log("[orchestrator] GitHub App not configured — running without GitHub integration");
    }
```

- [ ] **Step 2: Build to verify**

```bash
pnpm build
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/orchestrator/init.ts
git commit -m "feat: log GitHub App status on startup"
```

---

## Task 11: GitHub App Registration + VPS Deploy

This task is manual setup — no code changes.

- [ ] **Step 1: Register GitHub App**

Go to https://github.com/settings/apps/new:
- **App name:** Interlude Agent
- **Homepage URL:** https://interludes.co.uk
- **Webhook URL:** https://interludes.co.uk/api/webhooks/github
- **Webhook secret:** Generate a random secret, save it
- **Permissions:**
  - Issues: Read & write
  - Pull requests: Read & write
  - Contents: Read & write
- **Subscribe to events:** Issues
- **Where can this app be installed:** Only on this account

- [ ] **Step 2: Generate and download private key**

On the App settings page, click "Generate a private key". Save the `.pem` file.

- [ ] **Step 3: Install the App on your repos**

Go to the App's install page, install on the repos you want (e.g. `lennons301/lemons`).

Note the installation ID from the URL (e.g. `https://github.com/settings/installations/12345678` → ID is `12345678`).

- [ ] **Step 4: Add env vars to VPS**

SSH to VPS and add to `/opt/interlude/.env`:

```bash
GITHUB_APP_ID=<your-app-id>
GITHUB_APP_PRIVATE_KEY="<contents-of-pem-file-with-newlines-as-\n>"
GITHUB_WEBHOOK_SECRET=<your-webhook-secret>
GITHUB_APP_INSTALLATION_ID=<your-installation-id>
```

- [ ] **Step 5: Run DB migration on VPS**

```bash
ssh deploy@178.104.72.109 "docker exec interlude-app-1 node -e \"const D=require('better-sqlite3');const db=new D('/data/interlude.db');db.exec('ALTER TABLE tasks ADD COLUMN pull_request_number INTEGER; ALTER TABLE tasks ADD COLUMN pull_request_url TEXT;');console.log('done')\""
```

- [ ] **Step 6: Push code and deploy**

```bash
git push origin main
```

Wait for CI/CD to deploy. Then restart to pick up new env vars:

```bash
ssh deploy@178.104.72.109 "cd /opt/interlude && docker compose up -d --force-recreate app"
```

- [ ] **Step 7: Verify startup logs**

```bash
ssh deploy@178.104.72.109 "cd /opt/interlude && docker compose logs app --tail=10"
```

Expected: `[orchestrator] GitHub App configured — webhooks and PR creation enabled`

---

## Task 12: End-to-End Verification

- [ ] **Step 1: Ensure lemons project has githubRepo set**

```bash
curl -s -X PATCH "https://interludes.co.uk/api/projects/01KKW50ZW5QSCACG7WSV3QKEVY" \
  -H "Content-Type: application/json" \
  -d '{"githubRepo": "lennons301/lemons"}'
```

- [ ] **Step 2: Create a test issue on GitHub**

On `lennons301/lemons`, create an issue:
- Title: "Add a health check endpoint"
- Body: "Create `/api/health` that returns `{status: 'ok', timestamp: new Date().toISOString()}`"
- Add label: `interlude`

- [ ] **Step 3: Verify task created**

```bash
curl -s "https://interludes.co.uk/api/tasks" | python3 -c "import json,sys; [print(f'{t[\"id\"]} {t[\"status\"]} {t[\"githubIssue\"]}') for t in json.load(sys.stdin)]"
```

Expected: New task with status `queued` and `githubIssue` set to `lennons301/lemons#N`.

- [ ] **Step 4: Verify issue comment posted**

Check the GitHub issue — should have a comment: "Task queued — agent will pick this up shortly" with Interlude link.

- [ ] **Step 5: Wait for agent to work**

Monitor the task. After the agent pushes the first branch, verify:
- Draft PR created on GitHub
- Issue comment: "Draft PR opened: #N"
- PR fields visible in Interlude UI

- [ ] **Step 6: Complete the task**

Complete the task from the Interlude UI. Verify:
- PR marked as ready for review on GitHub
- Issue comment: "Complete — PR #N ready for review ($X.XX)"

---

## Task 13: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update status and roadmap**

Change "Phase 2d complete" to "Phase 3 complete" and mark Phase 3 as done in the roadmap.

Add to Key Conventions:
- GitHub App provides webhook-driven issue→task creation (label `interlude` triggers task)
- Draft PRs auto-created on first branch push, marked ready on completion
- GitHub config is optional — all features degrade gracefully when unconfigured

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: mark Phase 3 complete, update conventions"
```
