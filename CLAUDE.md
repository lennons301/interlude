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
- Preview uses subdomain routing: `task-{shortId}.interludes.co.uk` (controlled by `DOMAIN` env var, path-based fallback when unset)
- Container network aliases match subdomain prefixes for Docker DNS resolution
- Caddy `on_demand_tls` provisions certs per-subdomain; validated via `/api/internal/validate-subdomain`
- GitHub App provides webhook-driven issue→task creation (label `interlude` triggers task)
- Draft PRs auto-created on first branch push, marked ready for review on completion
- GitHub config is optional — all features degrade gracefully when unconfigured
- Webhook endpoint: `POST /api/webhooks/github`
- GitHub library: `src/lib/github/` (client, webhooks, issues, pull-requests)

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

## Current Status: Phase 3 complete, tested on VPS

Phases 1, 2a, 2.5, 2b, 2c, 2d, and 3 are done and tested end-to-end on VPS. The full flow works: create task → agent runs in Docker → output streams to chat UI → branch pushed to GitHub after each turn → interactive follow-up messages → live preview of dev server via subdomain → complete task. GitHub issues labeled `interlude` auto-create tasks, and agent work auto-produces draft PRs.

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

### Phase 2d: Subdomain Preview (done)
- Each task gets `task-{shortId}.interludes.co.uk` — real browser origin
- Caddy `on_demand_tls` for wildcard subdomain certs (TLS-ALPN-01)
- Custom server routes by Host header, proxies HTTP + WebSocket to container via Docker network alias
- Auth, cookies, client-side routing, assets all work without rewriting
- Preview pane pre-warms TLS cert before loading iframe (avoids mobile error during provisioning)
- Container reaper cleans up orphaned containers on restart + every 5 minutes
- Plan: `docs/plans/2026-03-27-phase2d-subdomain-preview.md`

### Phase 3: GitHub Integration (done)
- GitHub App auth (JWT → installation token, auto-refreshed)
- Webhook receiver: issue labeled `interlude` → task created (queued)
- Issue lifecycle comments (queued, working, PR opened, complete, failed)
- Draft PR auto-created on first branch push, marked ready on task completion
- Issue + PR links displayed in task UI header
- Spec: `docs/specs/2026-03-27-phase3-github-integration-design.md`
- Plan: `docs/plans/2026-03-27-phase3-github-integration.md`

### Phase 4: Notification Bot
- Slack or Telegram bot for bidirectional messaging
- Task dispatch from chat

### Phase 5: Multi-Agent Workflows
- Multiple agents collaborating on a single goal
- Agent roles and specialisation (e.g. architect, implementer, reviewer)
- Task decomposition — break a high-level objective into subtasks assigned to different agents
- Coordination layer: shared context, dependency ordering, merge conflict resolution
- Pipeline/DAG execution — agent A's output feeds agent B's input
- Agent-to-agent delegation (one agent spawning work for another)
- Parallel agents working branches of the same repo with automated integration
- Human-in-the-loop checkpoints for multi-agent plans before execution

### Phase 6: Production Hardening
- Container resource limits (CPU/memory caps per agent container)
- Automated backups
- Monitoring and alerting
- Push notifications

### Phase 7: On-Demand Remote Compute
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

## Platform Context

Platform standards and choices: see /workspace/platform/ (in agent containers)
or ~/code/platform/ (on local machines).
This project's registry entry: products/interlude.yaml
