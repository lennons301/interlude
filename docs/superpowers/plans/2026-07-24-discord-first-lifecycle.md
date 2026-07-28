# Discord-First Task Lifecycle — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Discord-dispatched task be finished from Discord — notify when the agent goes idle, complete via a ✅ reaction, and auto-open a PR for any task origin.

**Architecture:** Extends the existing Discord bot. Idle notifications and the completion embed post via the shared `notifications.ts` helpers (globalThis-backed client). Completion is triggered by a `messageReactionAdd` handler in `client.ts`. Auto-PR broadens the existing draft-PR block in `turn-manager.ts` to derive owner/repo from the project's `gitUrl` when there is no linked issue.

**Tech Stack:** discord.js 14, Next.js App Router, Drizzle ORM (SQLite), Octokit, vitest.

**Spec:** `docs/specs/2026-07-24-discord-first-lifecycle-design.md`

## Global Constraints

- All Discord posts are fire-and-forget with `.catch(console.error)`; a notification failure MUST NOT affect task lifecycle.
- The bot client is resolved via `getBotClient()` (globalThis-backed) inside every notification helper — never a module-level variable.
- No schema changes. `task.discordMessageId` is the task's *current interactive message id*: set at queue time, overwritten by each idle notification.
- Completion from Discord uses the ✅ emoji only (`reaction.emoji.name === "✅"`). Cancel stays a reply keyword (unchanged).
- Auto-PR only when owner/repo is resolvable (linked issue via `parseIssueRef`, else GitHub `gitUrl` via `parseRepoFromGitUrl`); otherwise skip PR (task still completes). `commentOnIssue` calls stay gated on `task.githubIssue`.
- Commit message trailer (required): end every commit message with
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

## File Structure

```
src/lib/github/repo.ts                    — NEW: parseRepoFromGitUrl helper
src/lib/github/__tests__/repo.test.ts     — NEW: unit tests for the helper
src/lib/discord/notifications.ts          — MODIFY: add notifyTaskIdle
src/lib/discord/client.ts                 — MODIFY: reaction intent + partials + messageReactionAdd handler
src/lib/orchestrator/turn-manager.ts      — MODIFY: broaden auto-PR + markPrReady; post idle notification on idle
```

---

## Task 1: `parseRepoFromGitUrl` helper

Pure function to extract `{ owner, repo }` from a GitHub git URL. Unit-tested with vitest (the repo has a working vitest setup).

**Files:**
- Create: `src/lib/github/repo.ts`
- Test: `src/lib/github/__tests__/repo.test.ts`

**Interfaces:**
- Produces: `parseRepoFromGitUrl(gitUrl: string): { owner: string; repo: string } | null`

- [ ] **Step 1: Write the failing test**

Create `src/lib/github/__tests__/repo.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseRepoFromGitUrl } from "../repo";

describe("parseRepoFromGitUrl", () => {
  it("parses https URL with .git suffix", () => {
    expect(parseRepoFromGitUrl("https://github.com/lennons301/test-repo.git")).toEqual({
      owner: "lennons301",
      repo: "test-repo",
    });
  });

  it("parses https URL without .git suffix", () => {
    expect(parseRepoFromGitUrl("https://github.com/lennons301/test-repo")).toEqual({
      owner: "lennons301",
      repo: "test-repo",
    });
  });

  it("parses https URL with trailing slash", () => {
    expect(parseRepoFromGitUrl("https://github.com/lennons301/test-repo/")).toEqual({
      owner: "lennons301",
      repo: "test-repo",
    });
  });

  it("parses ssh scp-style URL", () => {
    expect(parseRepoFromGitUrl("git@github.com:lennons301/test-repo.git")).toEqual({
      owner: "lennons301",
      repo: "test-repo",
    });
  });

  it("returns null for non-github hosts", () => {
    expect(parseRepoFromGitUrl("https://gitlab.com/lennons301/test-repo.git")).toBeNull();
  });

  it("returns null for unparseable input", () => {
    expect(parseRepoFromGitUrl("not a url")).toBeNull();
    expect(parseRepoFromGitUrl("")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/github/__tests__/repo.test.ts`
Expected: FAIL — cannot resolve `../repo` / `parseRepoFromGitUrl is not a function`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/github/repo.ts`:

```typescript
/**
 * Extract { owner, repo } from a GitHub git URL (https or scp-style ssh).
 * Returns null for non-GitHub hosts or unparseable input.
 */
export function parseRepoFromGitUrl(
  gitUrl: string
): { owner: string; repo: string } | null {
  if (!gitUrl) return null;

  // scp-style: git@github.com:owner/repo(.git)
  const scp = gitUrl.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?\/?$/);
  if (scp) return { owner: scp[1], repo: scp[2] };

  // https: https://github.com/owner/repo(.git)(/)
  const https = gitUrl.match(/^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/);
  if (https) return { owner: https[1], repo: https[2] };

  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/github/__tests__/repo.test.ts`
Expected: PASS (6/6).

- [ ] **Step 5: Commit**

```bash
git add src/lib/github/repo.ts src/lib/github/__tests__/repo.test.ts
git commit -m "feat: parseRepoFromGitUrl helper for deriving owner/repo from a git URL

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `notifyTaskIdle` notification helper

Add the idle-notification embed helper alongside the others. No unit test (live Discord I/O, no harness) — verified via `pnpm build` and the Task 6 gateway, consistent with the other notification helpers.

**Files:**
- Modify: `src/lib/discord/notifications.ts`

**Interfaces:**
- Consumes: `getBotClient()` (existing, globalThis-backed).
- Produces: `notifyTaskIdle(channelId: string, task: { id: string; title: string; summary: string; branch: string }): Promise<string | null>` — posts the embed, returns the Discord message id (or null).

- [ ] **Step 1: Add the helper**

Append to `src/lib/discord/notifications.ts` (after `notifyTaskFailed`):

```typescript
/**
 * Post an "agent finished a turn — your move" idle notification.
 * Returns the Discord message ID so it can become the task's current
 * interactive message (for ✅-to-complete and reply-to-continue).
 */
export async function notifyTaskIdle(
  channelId: string,
  task: { id: string; title: string; summary: string; branch: string }
): Promise<string | null> {
  const botClient = getBotClient();
  if (!botClient) return null;

  try {
    const channel = await botClient.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) return null;

    const domain = process.env.DOMAIN ?? "interludes.co.uk";
    const summary = task.summary.trim()
      ? task.summary.trim().slice(0, 500)
      : "(no summary)";

    const embed = new EmbedBuilder()
      .setTitle(`Agent finished a turn: ${task.title}`)
      .setDescription(
        `${summary}\n\nBranch: \`${task.branch}\`\n\nReact ✅ to complete · reply to continue`
      )
      .setURL(`https://${domain}/tasks/${task.id}`)
      .setColor(0xf59e0b);

    const msg = await (channel as TextChannel).send({ embeds: [embed] });
    return msg.id;
  } catch (err) {
    console.error(`[discord] Failed to send idle notification:`, err);
    return null;
  }
}
```

- [ ] **Step 2: Build to verify**

Run: `pnpm build`
Expected: exit 0, no type errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/discord/notifications.ts
git commit -m "feat: notifyTaskIdle Discord embed (agent finished a turn)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Auto-PR for all task origins

Broaden the draft-PR creation (on first push) and the mark-ready-on-complete step so Discord/UI tasks — not just issue-origin tasks — get a PR. Verified via `pnpm build` + Task 6 gateway.

**Files:**
- Modify: `src/lib/orchestrator/turn-manager.ts`

**Interfaces:**
- Consumes: `parseRepoFromGitUrl` (Task 1); existing `createDraftPr`, `markPrReady`, `parseIssueRef`, `commentOnIssue`.

- [ ] **Step 1: Import the helper**

In `src/lib/orchestrator/turn-manager.ts`, after the existing GitHub imports (the `import { commentOnIssue, parseIssueRef } from "../github/issues";` line, ~line 18), add:

```typescript
import { parseRepoFromGitUrl } from "../github/repo";
```

- [ ] **Step 2: Broaden draft-PR creation in `runPostTurnCommitAndPush`**

Replace the existing draft-PR block (currently `if (task && !task.pullRequestNumber && task.branch && task.githubIssue) { ... }`) with the following. It fetches the project to reach `gitUrl`, resolves owner/repo from the issue when present else the gitUrl, and only comments on the issue when there is one:

```typescript
    // Create draft PR on first push if none exists yet (any task origin)
    if (task && !task.pullRequestNumber && task.branch) {
      const proj = db.select().from(projects).where(eq(projects.id, task.projectId)).get();
      const repoRef = task.githubIssue
        ? parseIssueRef(task.githubIssue)
        : proj?.gitUrl
          ? parseRepoFromGitUrl(proj.gitUrl)
          : null;

      if (repoRef) {
        const domain = process.env.DOMAIN ?? "interludes.co.uk";
        const issueLine = task.githubIssue ? `Closes #${(repoRef as { number?: number }).number}\n\n` : "";
        const body = `${issueLine}[View in Interlude](https://${domain}/tasks/${taskId})`;

        const pr = await createDraftPr({
          owner: repoRef.owner,
          repo: repoRef.repo,
          title: task.title,
          head: task.branch,
          body,
        });

        if (pr) {
          updateTask(taskId, {
            pullRequestNumber: pr.number,
            pullRequestUrl: pr.url,
          });
          if (task.githubIssue) {
            await commentOnIssue(task.githubIssue, `Draft PR opened: #${pr.number}`);
          }
          console.log(`[github] Draft PR #${pr.number} created for task ${taskId}`);
        }
      }
    }
```

Note: `parseIssueRef` returns `{ owner, repo, number }`; `parseRepoFromGitUrl` returns `{ owner, repo }`. The `number` is only read on the issue path, guarded by `task.githubIssue`.

- [ ] **Step 3: Broaden mark-ready in `completeTask`**

Locate the mark-ready block in `completeTask()` (currently `if (task.pullRequestNumber && task.githubIssue) { const parsed = parseIssueRef(...); await markPrReady(...); await commentOnIssue(...); }`). Replace it with:

```typescript
    // Mark PR ready for review (any origin); comment on the issue only if there is one
    if (task.pullRequestNumber) {
      const proj = db.select().from(projects).where(eq(projects.id, task.projectId)).get();
      const repoRef = task.githubIssue
        ? parseIssueRef(task.githubIssue)
        : proj?.gitUrl
          ? parseRepoFromGitUrl(proj.gitUrl)
          : null;
      if (repoRef) {
        await markPrReady(repoRef.owner, repoRef.repo, task.pullRequestNumber);
        if (task.githubIssue) {
          const cost = (task.totalCostUsd ?? 0).toFixed(2);
          await commentOnIssue(
            task.githubIssue,
            `Complete -- PR #${task.pullRequestNumber} ready for review ($${cost})`
          );
        }
      }
    }
```

- [ ] **Step 4: Build to verify**

Run: `pnpm build`
Expected: exit 0, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/orchestrator/turn-manager.ts
git commit -m "feat: auto-create + ready draft PR for any task origin (not just issues)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Post idle notification on idle transition

Post the idle notification after the first turn (`startTask`) and after follow-up turns (`processQueuedMessages`), and record the message id as the task's current interactive message.

**Files:**
- Modify: `src/lib/orchestrator/turn-manager.ts`

**Interfaces:**
- Consumes: `notifyTaskIdle` (Task 2).

- [ ] **Step 1: Import `notifyTaskIdle` and `desc`**

Update the discord import (currently `import { notifyTaskQueued, notifyTaskCompleted, notifyTaskFailed } from "../discord/notifications";`) to:

```typescript
import { notifyTaskQueued, notifyTaskCompleted, notifyTaskFailed, notifyTaskIdle } from "../discord/notifications";
```

Ensure `desc` is imported from drizzle-orm (the file already imports `and, asc, eq, isNull` from `"drizzle-orm"`). Add `desc` to that import.

- [ ] **Step 2: Add a private `postIdleNotification` helper**

Add near the other private helpers in `src/lib/orchestrator/turn-manager.ts` (e.g. just above `runPostTurnCommitAndPush`):

```typescript
/**
 * Post an "agent finished a turn" idle notification to the project's Discord
 * channel (if linked) and store the message id as the task's current
 * interactive message. Fire-and-forget safe: never throws to the caller.
 */
async function postIdleNotification(taskId: string): Promise<void> {
  try {
    const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    if (!task) return;
    const proj = db.select().from(projects).where(eq(projects.id, task.projectId)).get();
    if (!proj?.discordChannelId) return;

    // Most recent agent text message = the turn's summary
    const lastAgent = db
      .select()
      .from(messages)
      .where(and(eq(messages.taskId, taskId), eq(messages.role, "agent"), eq(messages.type, "text")))
      .orderBy(desc(messages.createdAt))
      .get();

    let summary = "";
    if (lastAgent) {
      try {
        const parsed = JSON.parse(lastAgent.content);
        summary = typeof parsed.text === "string" ? parsed.text : lastAgent.content;
      } catch {
        summary = lastAgent.content;
      }
    }

    const msgId = await notifyTaskIdle(proj.discordChannelId, {
      id: taskId,
      title: task.title,
      summary,
      branch: task.branch ?? "",
    });
    if (msgId) updateTask(taskId, { discordMessageId: msgId });
  } catch (err) {
    console.error(`[discord] postIdleNotification failed:`, err);
  }
}
```

- [ ] **Step 3: Call it after the first turn in `startTask`**

In `startTask()`, immediately after `await scanForDevServer(taskId, running);` (the last statement in the try block, ~line 127), add:

```typescript
    await postIdleNotification(taskId);
```

- [ ] **Step 4: Call it when `processQueuedMessages` goes idle**

In `processQueuedMessages()`, change the no-more-messages break to post first. Replace:

```typescript
    if (!queued) break; // No queued messages — stay idle
```

with:

```typescript
    if (!queued) {
      // No more queued messages — agent is idle, notify Discord ("your move")
      await postIdleNotification(taskId);
      break;
    }
```

(Because `queue.ts` only calls `processQueuedMessages` when an undelivered message exists, at least one turn always runs before this break — so this fires only after real work, never spuriously.)

- [ ] **Step 5: Build to verify**

Run: `pnpm build`
Expected: exit 0, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/orchestrator/turn-manager.ts
git commit -m "feat: post Discord idle notification when agent finishes a turn

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Complete via ✅ reaction

Add the reaction intent + partials and a `messageReactionAdd` handler that completes a task when a user reacts ✅ on its current interactive message.

**Files:**
- Modify: `src/lib/discord/client.ts`

**Interfaces:**
- Consumes: `completeTask` from `../orchestrator/turn-manager` (dynamic import, to avoid the circular dependency — same pattern as `cancelTask`).

- [ ] **Step 1: Add the reaction intent and partials**

In `src/lib/discord/client.ts`, update the discord.js import to include `Partials`, and add a type-only import for the reaction handler's parameter types (both at the top of the file with the existing imports):

```typescript
import { Client, GatewayIntentBits, Message, Partials } from "discord.js";
import type { MessageReaction, PartialMessageReaction, User, PartialUser } from "discord.js";
```

Update the `new Client({...})` construction to add the reactions intent and partials:

```typescript
  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
    ],
    partials: [Partials.Message, Partials.Reaction, Partials.Channel],
  });
```

- [ ] **Step 2: Register the reaction handler**

After the existing `client.on("messageCreate", ...)` block, add:

```typescript
  client.on("messageReactionAdd", (reaction, user) => {
    handleReactionAdd(reaction, user).catch((err) =>
      console.error("[discord] Reaction handler error:", err)
    );
  });
```

- [ ] **Step 3: Implement `handleReactionAdd`**

Add this function to `src/lib/discord/client.ts` (near `handleReply`); its parameter types were imported at the top in Step 1:

```typescript
async function handleReactionAdd(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser
): Promise<void> {
  if (user.bot) return;

  // Resolve partials (message/reaction may be uncached, e.g. after a restart)
  if (reaction.partial) {
    try {
      await reaction.fetch();
    } catch {
      return;
    }
  }

  if (reaction.emoji.name !== "✅") return;

  const messageId = reaction.message.id;
  const task = db.select().from(tasks).where(eq(tasks.discordMessageId, messageId)).get();
  if (!task) return; // Reaction not on a task's interactive message

  if (task.status !== "running") return; // Only running/idle tasks can be completed

  // Dynamic import to avoid circular dependency with turn-manager
  const { completeTask } = await import("../orchestrator/turn-manager");
  await completeTask(task.id);
  console.log(`[discord] Task ${task.id} completed via ✅ reaction`);
}
```

- [ ] **Step 4: Build to verify**

Run: `pnpm build`
Expected: exit 0, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/discord/client.ts
git commit -m "feat: complete a task from Discord via ✅ reaction on its idle message

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Gateway — live end-to-end verification

Human-driven (local, `doppler run -- pnpm dev`, Docker up, `#interlude-dev` linked to the `lemons` project → `test-repo`). No code.

- [ ] **Step 1: Idle notification**

Post a task from Discord. After the agent finishes its turn, expect an amber **"Agent finished a turn"** embed with the agent's summary, the branch, and `React ✅ to complete · reply to continue`.

- [ ] **Step 2: Reply-to-continue still works**

Reply to that idle embed with a follow-up instruction. Expect 👍 and a new turn, then a fresh idle embed.

- [ ] **Step 3: Auto-PR on push**

Confirm a **draft PR** now exists on `lennons301/test-repo` for the task's branch (Discord-origin, no issue).

- [ ] **Step 4: Complete via ✅**

React ✅ on the latest idle embed. Expect: the task completes in Interlude, the green **"Task complete"** embed posts **with a PR link**, and the draft PR is **marked ready for review** on GitHub.

- [ ] **Step 5: Negative check**

Confirm a task in a project with NO `discordChannelId` produces no idle notification (create a second project without linking a channel, run a task via the UI).

---

## Notes for the executor

- Verification is `pnpm build` (exit 0) for Tasks 2–5 and `pnpm vitest run` for Task 1; there is no unit harness for the live Discord/Docker paths (consistent with prior Phase 4 work) — those are covered by the Task 6 gateway.
- Pre-existing failing tests in `src/lib/orchestrator/__tests__/output-parser.test.ts` (6, migration drift — `preview_subdomain` absent from migrations) are unrelated to this work; do not attempt to fix them here and do not treat them as regressions.
- Restarting `doppler run -- pnpm dev` is required for the reaction-intent change (new gateway intent) to take effect.
