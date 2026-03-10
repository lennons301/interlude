# Phase 1: Chat UI + API — Design Spec

## Overview

The first phase of Interlude: a mobile-friendly web UI for creating, viewing, and monitoring agent tasks. No agent execution yet — tasks are created and displayed, with mock streaming for UI development.

## Tech Stack

| Component | Choice |
|-----------|--------|
| Framework | Next.js 15 (App Router) |
| Package manager | pnpm |
| Database | SQLite via Drizzle + better-sqlite3 |
| Styling | Tailwind CSS + shadcn/ui |
| Real-time | SSE (Server-Sent Events) |
| PWA | next-pwa |

## Data Model

### projects

| Column | Type | Notes |
|--------|------|-------|
| id | text PK | ulid |
| name | text | |
| github_repo | text | nullable — Phase 3 |
| created_at | integer | unix ms |

### tasks

| Column | Type | Notes |
|--------|------|-------|
| id | text PK | ulid |
| project_id | text FK | -> projects |
| title | text | |
| description | text | |
| status | text | queued, running, blocked, completed, failed, cancelled |
| github_issue | text | nullable — Phase 3 |
| created_at | integer | unix ms |
| updated_at | integer | unix ms |

### messages

| Column | Type | Notes |
|--------|------|-------|
| id | text PK | ulid |
| task_id | text FK | -> tasks |
| role | text | user, agent, system |
| content | text | |
| created_at | integer | unix ms |

No auth tables — single-user, localhost only in Phase 1.

## API Routes

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/api/tasks` | List tasks (filterable by status, project) |
| POST | `/api/tasks` | Create a new task |
| GET | `/api/tasks/[id]` | Get task detail |
| PATCH | `/api/tasks/[id]` | Update task (status, title) |
| GET | `/api/tasks/[id]/messages` | Get messages for a task |
| POST | `/api/tasks/[id]/messages` | Send a message (user reply to agent) |
| GET | `/api/tasks/[id]/stream` | SSE endpoint — streams new messages |
| GET | `/api/projects` | List projects |
| POST | `/api/projects` | Create project |

## UI Layout: Hybrid Expandable Feed

Single-column feed where active tasks auto-expand to show live output inline. Collapsed tasks show last status line. No sidebar navigation — mobile-first, works well on desktop too.

### Screens

1. **Main feed** (`/`) — task list with expandable cards, "New task" button at top.
2. **Task detail** (`/tasks/[id]`) — full message history, live stream, reply input. Reached by tapping a collapsed task.
3. **New task** (`/tasks/new`) — form: select project, title, description.
4. **Settings** (`/settings`) — project management (add/edit projects).

### Task Card States

- **Queued** — collapsed, shows title + "Queued" badge
- **Running** — auto-expanded, shows live streaming output with cursor, reply input visible
- **Blocked** — expanded, shows agent's question, prominent reply input
- **Completed** — collapsed, shows summary + "PR #N created" if applicable
- **Failed** — collapsed, shows error summary, red badge
- **Cancelled** — collapsed, greyed out

## PWA

- Web app manifest + service worker for installability
- Offline shell with "no connection" state
- Push notifications deferred to Phase 5

## Mock Agent Mode

For Phase 1 development, a mock agent simulates streaming output so the UI can be built and tested without Docker or Claude Code. The mock:

- Accepts a task and emits fake agent messages over SSE at realistic intervals
- Transitions task through statuses (queued -> running -> completed)
- Can simulate a "blocked" state to test the reply flow

## Out of Scope

- Agent execution (Phase 2)
- GitHub integration (Phase 3)
- Authentication
- Notifications (Phase 4)
