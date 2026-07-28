# Discord-First Task Lifecycle — Design Spec

> Phase 4 enhancement. Builds on the Discord bot (`docs/specs/2026-04-09-phase4-discord-bot-design.md`).

## Goal

Let a task be driven end-to-end from Discord. Today Discord can *start* a task (message → queued task) and send follow-ups, but you must switch to the web UI to see the agent is waiting, to complete the task, and there is no PR for Discord-dispatched work. This closes that loop.

## Gaps being closed

1. **Silent idle.** When the agent finishes a turn and goes idle, Discord says nothing — you only learn it is waiting by opening the web UI.
2. **Can't complete from Discord.** "Complete" is a web-UI-only action; the green completion embed can only be triggered from the app.
3. **No auto-PR for Discord/UI tasks.** `turn-manager.ts` only auto-creates a draft PR for tasks that originated from a GitHub issue (gated on `task.githubIssue`).

## Design

### 1. Idle notification

When a task finishes a turn and returns to idle (agent done, no queued user messages), the bot posts to the project's linked channel:

```
Agent finished a turn — {task title}
{agent's final assistant message this turn, truncated to ~500 chars}
Branch: agent/{taskId}
React ✅ to complete · reply to continue
```

- Fires only when the project has a `discordChannelId` (Discord-linked). Fire-and-forget with `.catch(console.error)`, matching existing notification calls.
- Once per idle transition (a "your move" moment), **not** turn-by-turn. A follow-up that triggers another turn ending idle produces one further notification.
- New helper `notifyTaskIdle(channelId, { id, title, summary, branch })` in `src/lib/discord/notifications.ts`, returning the posted message's ID (same shape as `notifyTaskQueued`).

### 2. Complete via ✅ reaction

The idle notification is the interaction hub: **react ✅ to complete**, **reply to continue** (continue already works via the existing reply handler).

- Add gateway intent `GuildMessageReactions` and `Partials` (`Message`, `Reaction`, `Channel`) to the client in `src/lib/discord/client.ts`, so reaction events fire even on messages not cached after a restart.
- Add a `messageReactionAdd` handler:
  - Ignore bot reactions.
  - Only act on the ✅ emoji (`reaction.emoji.name === "✅"`).
  - Fetch the reaction/message if partial.
  - Resolve the task by `tasks.discordMessageId === reaction.message.id`. If none, ignore.
  - If the task is `running`/idle: dynamically import and call `completeTask(task.id)` (dynamic import avoids the turn-manager circular dependency, same pattern as `cancelTask`). React back / no-op on success.
  - If the task is terminal (`completed`/`failed`/`cancelled`): ignore.

`completeTask()` already posts the green "complete" embed (fixed via the globalThis botClient share) and will now also mark the PR ready (see §3).

### 3. Auto-PR for all origins

- **Create:** broaden the draft-PR block in `turn-manager.ts` (currently `if (task && !task.pullRequestNumber && task.branch && task.githubIssue)`) to fire on first branch push for **any** task whose project has a GitHub `gitUrl`. Owner/repo come from `task.githubIssue` (`parseIssueRef`) when present, otherwise from the project's `gitUrl` via a new `parseRepoFromGitUrl(gitUrl)` helper.
- **Ready:** broaden the `markPrReady` block in `completeTask()` (currently gated on `task.pullRequestNumber && task.githubIssue`). Mark ready whenever `task.pullRequestNumber` is set, deriving owner/repo the same way as creation (`parseIssueRef` if `githubIssue`, else `parseRepoFromGitUrl(gitUrl)`). The **`commentOnIssue`** call in that block stays gated on `task.githubIssue` — Discord/UI tasks have no issue to comment on, so only the PR-ready step runs for them.
- **PR content:** title = task title; body = task description plus a link back to the Interlude task page. Base = repo default branch; head = `task.branch`.
- **Result:** the green completion embed's PR link is now populated for Discord-dispatched tasks.

### Message mapping

`task.discordMessageId` becomes "the task's current interactive message id." It is set at queue time (queued embed) and **overwritten** with each idle notification's message id. Consequence: replies/reactions act on the *latest* "your move" message; interacting with an older (queued or superseded) message no longer maps. This keeps the existing single-column mapping — **no schema change**.

The existing double-post guard (`startTask` only posts a queued embed when `!task.discordMessageId`) is unaffected: it runs at queue time, before any idle overwrite.

## Files touched

- `src/lib/discord/notifications.ts` — add `notifyTaskIdle`.
- `src/lib/discord/client.ts` — add `GuildMessageReactions` intent + `Partials`; add `messageReactionAdd` handler.
- `src/lib/orchestrator/turn-manager.ts` — post idle notification on idle transition (store returned message id via `updateTask`); broaden draft-PR create and `markPrReady` gates.
- `src/lib/github/pull-requests.ts` (or a small `src/lib/github/repo.ts`) — add `parseRepoFromGitUrl(gitUrl): { owner, repo } | null`.

## Schema changes

None. `task.discordMessageId` is reused as the current-interactive-message pointer.

## Error handling / edge cases

- All Discord posts are fire-and-forget; a notification failure never affects task lifecycle.
- `parseRepoFromGitUrl` returns null for non-GitHub or unparseable URLs → no PR created (logged), task still completes; completion embed simply carries no PR link.
- ✅ reaction on a message with no task mapping → ignored.
- ✅ reaction on a terminal task → ignored (no double-complete).
- Reaction added by the bot itself (e.g. its own acknowledgements) → ignored via the bot check.

## What this does NOT include (YAGNI)

- Converting `cancel` to a reaction — stays a reply keyword.
- Reactions other than ✅.
- Editing/deleting superseded notification messages.
- Per-turn progress notifications (only idle "your move" moments notify).
- Multi-message mapping / interaction history — latest-message-wins is sufficient.

## Testing

- **Unit:** `parseRepoFromGitUrl` (pure function) — GitHub https/ssh/.git-suffix variants and non-GitHub/invalid inputs.
- **Live (gateway-style):** post a task from Discord → agent turn → idle notification with summary appears → ✅ completes → green embed **with PR link** → draft PR on the repo marked ready. Also verify reply-to-continue still works, and that a non-Discord-linked project produces no idle notification.
