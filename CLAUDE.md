# Interlude — Agent Development Platform

## What This Is

Interlude is a self-hosted, agent-first development platform. You dispatch tasks to AI agents via a mobile-friendly web UI, monitor their progress in real-time, and receive results as PRs.

## Architecture

- **Next.js 16** App Router with TypeScript
- **SQLite** via Drizzle ORM + better-sqlite3 (WAL mode, foreign keys on)
- **Tailwind CSS** + shadcn/ui for styling (dark theme default)
- **SSE** (Server-Sent Events) for real-time streaming
- **pnpm** as package manager

## Key Conventions

- IDs use ULIDs (via `ulidx` package, helper at `src/lib/ulid.ts`)
- Database timestamps use `timestamp_ms` mode (JavaScript Date objects)
- API routes return JSON, validate input, return appropriate status codes
- Components are client components (`"use client"`) when they need interactivity
- File structure: pages in `src/app/`, components in `src/components/`, utilities in `src/lib/`, database in `src/db/`

## Database

Schema at `src/db/schema.ts`. Three tables: `projects`, `tasks`, `messages`.

- Run migrations: `npx drizzle-kit push`
- Generate migrations: `npx drizzle-kit generate`
- DB client: `import { db } from "@/db"`

## Development

```bash
pnpm dev          # Start dev server
pnpm build        # Production build
pnpm lint         # Run ESLint
```

## Current Status: Phase 1 (Chat UI + API)

Building the web UI and API layer. No agent execution yet — uses a mock agent for development.

## Roadmap

### Phase 1: Chat UI + API (current)
- Task/chat interface with expandable feed layout
- SQLite database for tasks, messages, logs
- SSE streaming infrastructure
- Mock agent for UI development
- Mobile-friendly PWA

### Phase 2: Agent Orchestrator + Local Docker
- Docker container provisioning for agent workspaces
- Claude Code CLI execution inside containers
- Output capture and streaming back to UI
- Task lifecycle management

### Phase 3: GitHub Integration
- GitHub App setup and auth
- Issue <-> task sync (bidirectional)
- Agent branch/commit/PR workflow

### Phase 4: Notification Bot
- Slack or Telegram bot for bidirectional messaging
- Task dispatch from chat

### Phase 5: Deploy to VPS
- Dockerise the stack
- Deploy to Hetzner/DO VPS (~€5/mo idle)
- SSL, domain, push notifications

### Phase 6: On-Demand Remote Compute
- Cloud provider API for machine provisioning
- Orchestrator decides local vs remote
- Auto-teardown after task completion

## Specs and Plans

- Design spec: `docs/specs/2026-03-10-phase1-chat-ui-api-design.md`
- Implementation plan: `docs/plans/2026-03-10-phase1-chat-ui-api.md`
- Overall design: see `docs/plans/2026-03-10-remote-agent-dev-environment-design.md` (external)
