# Phase 2b: Interactive Chat — Design Spec

## Overview

Add bidirectional communication between users and running agents. Users can send messages to agents mid-task for course corrections, follow-up instructions, or questions. Agents default to autonomous operation — user messages are optional, not required.

This phase also replaces the raw terminal-style output with a chat-first UI featuring structured message rendering and collapsible tool-use cards.

## Design Principles

- **Autonomous by default** — agents work to completion without requiring user input. User messages are course corrections, not required steps.
- **One process at a time** — only one Claude process runs per container. Messages queue while the agent is mid-turn, delivered at the next natural break.
- **`--resume` as universal messaging** — the same mechanism (session resume) works for user→agent and future supervisor→sub-agent communication.
- **Persistent workspaces** — containers stay alive between turns, preserving git state and session data. Foundation for future multi-agent patterns.

## Container Lifecycle

### Current (Phase 2a)

Container runs a monolithic bash chain (clone → checkout → claude -p → commit → push) and exits.

### New (Phase 2b)

```
Container created:
  → Workspace setup: git clone, checkout branch, configure git
  → Entrypoint: sleep infinity (container idles)
  → containerStatus: setup → idle

Initial turn:
  → docker exec: claude -p "$PROMPT" --output-format stream-json --verbose --dangerously-skip-permissions
  → Stream output to DB via output parser
  → Capture session_id from result event, store on task record
  → containerStatus: running → idle

User sends message (while idle):
  → docker exec: claude -p "$MESSAGE" --resume $SESSION_ID --output-format stream-json --verbose --dangerously-skip-permissions
  → Stream output, back to idle when done

User sends message (while running):
  → Message saved to DB, queued
  → When current turn ends, orchestrator checks queue
  → If queued messages: start next --resume turn with oldest message
  → If no messages: stay idle

Task completion:
  → Fallback commit: git add -A && git diff --cached --quiet || git commit -m "agent changes"
  → git push origin $BRANCH
  → Container removed (unless KEEP_CONTAINERS=true)
  → containerStatus: completing → done
```

### Container State Machine

```
setup → idle → running → idle → running → ... → completing → done
                  ↑         |
                  └─────────┘
                (queued messages)
```

States:
- `setup` — container created, workspace being prepared
- `idle` — Claude finished a turn, waiting for input or task completion
- `running` — Claude actively processing
- `completing` — final commit/push in progress
- `null` — container does not exist (task completed, failed, or cancelled)

**Failure handling:** If any state transitions fail (clone fails, Claude crashes, push fails), `containerStatus` is set to `null` and `task.status` is set to `failed`. The UI derives display state from the combination of both fields.

**Task completion trigger:** The user explicitly marks a task complete via a "Complete task" action in the UI (or the task hits its budget/turn limit). This triggers the `idle → completing` transition. An agent turn finishing with no queued messages does NOT auto-complete — it stays idle, allowing the user to send follow-up messages at any time.

**Budget tracking:** The orchestrator tracks cumulative cost across turns by summing `total_cost_usd` from each turn's `result` event. When cumulative cost exceeds `MAX_BUDGET_USD`, the task auto-completes rather than allowing more turns.

## Message Flow

### Sending a Message

```
User types message in UI
  → POST /api/tasks/:id/messages {role: "user", content: "..."}
  → Message saved to DB
  → If task.containerStatus === "idle":
      → Trigger next turn immediately (notify orchestrator)
  → If task.containerStatus === "running":
      → Message stays in DB as queued (picked up when turn ends)
  → SSE stream delivers message to UI immediately (user sees their own message)
```

### Turn Loop (Orchestrator)

```
After each Claude turn completes:
  1. Parse result event → store session_id
  2. Set containerStatus = "idle"
  3. Query DB for undelivered user messages: messages with role="user" and deliveredAt IS NULL
  4. If found (mark them as delivered with deliveredAt = now):
     → Set containerStatus = "running"
     → docker exec claude -p "$MESSAGE" --resume $SESSION_ID ...
     → Stream output
     → Go to step 1
  5. If not found:
     → Stay idle
     → Run fallback commit (stage any uncommitted changes)
```

### Notification Mechanism

When a user message arrives during idle, the orchestrator needs to wake up. Options:

- **Polling** — orchestrator checks for new messages every 2 seconds (simple, matches current queue polling pattern)
- **In-process event** — POST handler emits an event that the turn loop listens for (lower latency)

Start with polling for simplicity. The 2-second latency is imperceptible in a chat context.

## CLI Integration

### Initial Turn

```bash
claude -p "$TASK_PROMPT" \
  --output-format stream-json \
  --verbose \
  --dangerously-skip-permissions \
  --max-turns "$MAX_TURNS" \
  --max-budget-usd "$MAX_BUDGET_USD"
```

### Subsequent Turns (Resume)

```bash
claude -p "$USER_MESSAGE" \
  --resume "$SESSION_ID" \
  --output-format stream-json \
  --verbose \
  --dangerously-skip-permissions \
  --max-turns "$MAX_TURNS" \
  --max-budget-usd "$MAX_BUDGET_USD"
```

### Key Flags

- `--output-format stream-json` + `--verbose` — structured JSON events per line
- `--resume $SESSION_ID` — continues existing conversation with full context
- `--dangerously-skip-permissions` — headless operation (no permission prompts)
- `--max-turns` / `--max-budget-usd` — resource limits per turn

**Critical: Remove `--no-session-persistence`.** The current Phase 2a code passes this flag (container-manager.ts line 57). It must be removed — `--resume` requires session data to persist between turns on disk inside the container.

Session ID is extracted from the `result` event at the end of each turn:
```json
{"type":"result","session_id":"9690bce9-...","result":"Done.","duration_ms":6871}
```

## Output Parsing

### Current

Raw text from container stdout, inserted as plain-text messages.

### New

Parse stream-json events (one JSON object per line) and map to structured messages:

| Stream Event Type | Message Type | Rendering |
|---|---|---|
| `assistant` (text content) | `text` | Chat bubble (agent) |
| `tool_use` | `tool_use` | Collapsible card |
| `tool_result` | `tool_result` | Stored but not rendered standalone (attached to tool_use) |
| `system` | `system` | Centered system text |
| `result` | `system` | Session complete indicator |

### Message Content Format

The `messages.content` column stores JSON for structured types:

**Text message:**
```json
{"text": "Found the bug — using <= instead of <"}
```

**Tool use:**
```json
{
  "tool": "Edit",
  "file_path": "src/components/calendar.tsx",
  "input": {"old_string": "end <= rangeEnd", "new_string": "end < rangeEnd"},
  "output": "File edited successfully"
}
```

**System message:**
```json
{"text": "Agent started"}
```

## Schema Changes

### tasks table

Add columns:
- `sessionId` — TEXT, nullable. Claude Code session UUID for --resume.
- `containerStatus` — TEXT, nullable. One of: `setup`, `running`, `idle`, `completing`. Null when no container exists (task done/failed/cancelled).
- `totalCostUsd` — REAL, default 0. Cumulative API cost across all turns, summed from each turn's `result` event `total_cost_usd`.

### messages table

Add columns:
- `type` — TEXT, not null, default `"text"`. One of: `text`, `tool_use`, `tool_result`, `system`.
- `deliveredAt` — INTEGER (timestamp_ms), nullable. Set when a user message is sent to the agent via --resume. Used to distinguish queued vs delivered messages.

The existing `role` column (user | agent | system) is preserved. `type` describes the content format, `role` describes who sent it.

**Content format migration:** Existing plain-text content from Phase 2a remains as-is. The UI renderer checks: if `type` is `"text"` and content is not valid JSON, treat it as `{"text": content}`. No data migration needed.

**Tool result handling:** `tool_result` events update the preceding `tool_use` message's JSON (adding the `output` field) rather than creating a separate row. This keeps tool cards self-contained.

## Chat UI

### Layout

Full-height chat view (chat-first design):

```
┌──────────────────────────────────┐
│ Task Title              ● Status │  ← Compact header
│ agent/01KKX...                   │  ← Branch name
├──────────────────────────────────┤
│                                  │
│  [system] Agent started          │
│                                  │
│  🤖 Looking at the calendar...   │  ← Agent bubble (left)
│                                  │
│  ▶ Read calendar.tsx             │  ← Collapsible tool card
│  ▼ Edit calendar.tsx             │  ← Expanded tool card
│    - end <= rangeEnd             │    (shows diff)
│    + end < rangeEnd              │
│                                  │
│  🤖 Fixed the off-by-one bug.   │
│                                  │
│         Also check weekly view 👤│  ← User bubble (right)
│                                  │
│  🤖 Checking now...              │
│                                  │
├──────────────────────────────────┤
│ [Message input...        ] [Send]│  ← Always visible
└──────────────────────────────────┘
```

### Message Rendering

- **User messages** — right-aligned bubbles, purple accent
- **Agent text** — left-aligned bubbles with agent avatar, dark background
- **Tool use cards** — left-aligned, colour-coded collapsible cards:
  - Blue border: Read
  - Green border: Edit
  - Amber border: Bash
  - Purple border: Commit/git operations
- **System messages** — centered, muted text
- **Auto-scroll** — scroll to bottom on new messages, unless user has scrolled up

### Container Status Indicator

Show in the header:
- `setup` — "Setting up workspace..."
- `running` — "Agent working..." (with subtle animation)
- `idle` — "Waiting for input" / "Agent idle"
- `completing` — "Pushing changes..."

### Message Input

- Always visible when task has an active container (status: running or idle)
- Placeholder text: "Message the agent..." when idle, "Agent is working... your message will be queued" when running
- Send on Enter, Shift+Enter for newline
- Disabled when task is completed/failed/cancelled

## File Changes

### Modified Files

1. **`src/db/schema.ts`** — Add `sessionId`, `containerStatus` to tasks; add `type` to messages
2. **`src/lib/docker/container-manager.ts`** — Split into setup + exec pattern. New functions: `createWorkspaceContainer()`, `execTurn()`, `execSetup()`
3. **`src/lib/orchestrator/task-runner.ts`** — Refactor to turn-based loop with idle state and message queue checking
4. **`src/lib/orchestrator/output-parser.ts`** — Rewrite for stream-json event parsing
5. **`src/lib/orchestrator/queue.ts`** — Refactor from blocking single-task to non-blocking multi-task. The queue must handle: (a) picking up new queued tasks, (b) polling for user messages on idle tasks, (c) managing multiple concurrent idle containers. The current `running` boolean gate becomes a map of active task states.
6. **`src/app/api/tasks/[id]/messages/route.ts`** — Trigger orchestrator notification on POST when task is idle
7. **`src/app/tasks/[id]/page.tsx`** — New chat-first layout
8. **`src/components/task-stream.tsx`** — Rewrite as chat message list with structured rendering
9. **`src/components/message-input.tsx`** — Update placeholder/disabled states based on containerStatus

### New Files

10. **`src/components/chat-message.tsx`** — Individual message renderer (text bubble, tool card, system message)
11. **`src/components/tool-card.tsx`** — Collapsible tool-use card component

### Migration

12. **`drizzle/`** — New migration for schema changes

## Future Considerations (Not in Scope)

- **Supervisor agents** — the `--resume` pattern and persistent containers are the foundation. A supervisor would be a special agent type that can `docker exec` into sub-agent containers.
- **Multi-agent teams** — each sub-agent gets its own container with its own session. The supervisor coordinates via `--resume` calls to each.
- **Live preview** (Phase 2c) — the persistent container naturally supports running a dev server alongside Claude.
- **Typing indicators** — could parse `stream_event` partial messages to show "Agent is typing..."
- **Message editing/retry** — re-send a modified message to the agent.

## Testing Plan

1. **Container lifecycle** — create container, verify it stays alive, exec turns, verify cleanup
2. **Session resume** — confirm multi-turn context preservation across `--resume` calls
3. **Message queuing** — send message while agent is running, verify it's delivered when turn ends
4. **Output parsing** — verify stream-json events map to correct message types
5. **UI rendering** — verify chat bubbles, tool cards, status indicators render correctly
6. **Edge cases** — container crash recovery, expired OAuth token mid-session, budget/turn limits hit
