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

## Current Status: Phase 2c complete, tested on VPS

Phases 1, 2a, 2.5, 2b, and 2c are done and tested end-to-end on VPS. The full flow works: create task → agent runs in Docker → output streams to chat UI → branch pushed to GitHub after each turn → interactive follow-up messages → live preview of dev server in iframe → complete task.

## Roadmap

### Phase 1: Chat UI + API (done)
- Task/chat interface with expandable feed layout
- SQLite database for tasks, messages, logs
- SSE streaming infrastructure
- Mock agent for UI development
- Mobile-friendly PWA

### Phase 2a: Agent Orchestrator + Local Docker (done)
- Docker container provisioning for agent workspaces
- Claude Code CLI execution inside containers
- Output capture and streaming back to UI
- Task lifecycle management (queue, run, complete, fail)

### Phase 2.5: Deploy to VPS (done)
- Dockerise the Next.js app (multi-stage build)
- Docker Compose stack: Caddy (reverse proxy + auto-SSL) + app
- Deploy to Hetzner CX22 (~EUR4.50/mo), domain interludes.co.uk
- GitHub Actions CI/CD (push to main -> auto-deploy)
- End-to-end testing of Phase 2a on real infrastructure

### Phase 2b: Interactive Chat (done)
- Multi-turn agent conversations via persistent Docker containers + `--resume`
- Chat-first task detail page with message queue
- Turn manager, output parser with structured message types
- Branch pushed after every turn for immediate PR creation

### Phase 2c: Live Preview (done)
- Proxy container dev server through orchestrator
- Embed as iframe in task detail view
- Real-time hot reload as agent writes code
- Mobile-friendly preview pane (tabs on mobile, split on desktop)

### Phase 3: GitHub Integration
- GitHub App setup and auth
- Issue <-> task sync (bidirectional)
- Agent branch/commit/PR workflow

### Phase 4: Notification Bot
- Slack or Telegram bot for bidirectional messaging
- Task dispatch from chat

### Phase 5: Production Hardening (was Phase 5, deployment moved to 2.5)
- Container resource limits (CPU/memory caps per agent container)
- Automated backups
- Monitoring and alerting
- Push notifications

### Phase 6: On-Demand Remote Compute
- Cloud provider API for machine provisioning
- Orchestrator decides local vs remote
- Auto-teardown after task completion

## Specs and Plans

- Design spec: `docs/specs/2026-03-10-phase1-chat-ui-api-design.md`
- Implementation plan: `docs/plans/2026-03-10-phase1-chat-ui-api.md`
- Phase 2a spec: `docs/specs/2026-03-11-phase2a-agent-orchestrator-design.md`
- Phase 2a plan: `docs/plans/2026-03-11-phase2a-agent-orchestrator.md`
- VPS deployment spec: `docs/specs/2026-03-12-vps-deployment-design.md`
- Overall design: see `docs/plans/2026-03-10-remote-agent-dev-environment-design.md` (external)
