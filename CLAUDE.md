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
- `DOMAIN`'s production source of truth is Doppler (`interlude/prd`): the app reads it via `doppler run`; the deploy renders `caddy.env` from the same config for Caddy. Never hand-set `DOMAIN` in the VPS `.env` (issue #25)
- Container network aliases match subdomain prefixes for Docker DNS resolution
- Caddy `on_demand_tls` provisions certs per-subdomain; validated via `/api/internal/validate-subdomain`
- GitHub App provides webhook-driven issue→task creation (label `interlude` triggers task)
- Draft PRs auto-created on first branch push, marked ready for review on completion
- GitHub App is REQUIRED for git auth — agent containers clone/push using short-lived App installation tokens (no PAT). Issue sync + PR features still degrade gracefully if webhook/installation are partially configured.
- Reviewer identity: the review pass returns a structured verdict and the **orchestrator** posts the PR review using `REVIEWER_GH_TOKEN`; the PAT never enters an agent container (issue #17). Its canonical home is Doppler `platform/prd`, and it is **mirrored** into `interlude/prd` because the orchestrator's service token is scoped to one config — **rotation must update both places**.
- Git credential helper in agent containers reads a per-exec `GIT_AUTH_TOKEN` (minted fresh from the App); no token is persisted in `.git/config`.
- Agent containers get **no host bind mount** (issue #28): everything they need is granted deliberately and exec-scoped — the `interlude` Docker network, a fresh `GIT_AUTH_TOKEN`, and Claude auth via `CLAUDE_CODE_OAUTH_TOKEN`. There is no host `~/.claude` mount, so a container cannot read or write the host user's Claude config/history/credentials, and the image's own `/home/node/.claude` (plugins, etc.) survives unshadowed. The rationale lives at the mount site in `src/lib/docker/container-manager.ts` — read it before adding any `Bind`.
- Webhook endpoint: `POST /api/webhooks/github`
- GitHub library: `src/lib/github/` (client, webhooks, issues, pull-requests)
- Discord bot (optional; degrades gracefully when unconfigured) maps each project to one channel via `!link <project>` / `!unlink`; new channel messages create tasks, replies deliver follow-ups
- Discord lifecycle embeds: queued / completed / failed, plus an idle "agent finished a turn" notification (react ✅ to complete the task, reply to continue)
- Triage (issue #23): `issues.opened` on a registered project marks the issue `needs-triage` (the label is the queue); a short read-only pass (`kind: triage`, no run, ~$2 + hard turn cap) returns `TRIAGE: recommend | needs-info | ready-for-human` and the orchestrator applies fixed consequences. Triage can never apply `ready-for-agent`, edit bodies, or close issues — arming needs a human label click or an explicit Discord "yes" (reply to the recommendation embed), and the route is recorded on the issue
- Draft PR is auto-created on first branch push for **any** task origin (issue, Discord, or UI) — not only issue-linked tasks — and marked ready for review on completion
- Discord library: `src/lib/discord/` (client = gateway + message/reaction routing, notifications = embeds)

## Database

Schema at `src/db/schema.ts`. Four tables: `projects`, `tasks`, `messages`, `runs`.

- `runs` is the Phase 5 autonomy ledger — one row per attempt at one ticket; a run owns one or more tasks (its implement pass plus any review passes). Interactive tasks have no run, which exempts them from the daily autonomous spend cap by construction (`src/lib/orchestrator/spend.ts`)
- Budgets (issue #18): `MAX_BUDGET_USD` is the **$20 per-attempt** default — it was $5 per *task* before Phase 5, and interactive tasks deliberately inherit the new, more generous default. A ticket's `budget:` directive (Workflow section) may raise one attempt to at most $75; review passes carry their own ~$5; the $500/day autonomous cap and all ceilings live in `src/lib/orchestrator/autonomy/budgets.ts`
- `runs.reviewResult` holds a finished review pass's parsed verdict until the orchestrator has acted on it; `runs.reviewVerdict` is the last verdict actually posted to GitHub
- `tasks.kind` distinguishes interactive (default) / implement / review / triage; `tasks.runId` links a task to its run; `tasks.triageResult` holds a finished triage pass's parsed exit until the sweep applies it (triage owns no run, so its spend is counted into the daily cap by kind in `spend.ts`)
- `projects` carries `autonomyEnabled` (default off) plus cached `preflightStatus`/`preflightReason`
- Restart recovery (issue #24): boot marks claimed/implementing/reviewing runs that own a `running` task as `interrupted` (a run holding a stored review verdict is left for the verdict path instead; gated/blocked runs wait on a human, not a lost turn). The sweep then re-claims the ticket **without** consuming an attempt — interruptions are counted from `interrupted` ledger rows, separately from failed attempts, and bounded by `MAX_INTERRUPTIONS_PER_TICKET` (5, in `budgets.ts`); past the bound the ticket is routed `ready-for-human` like exhaustion. The reaper never removes a container whose task belongs to a live run. Boot also **finalizes dangling runs** (issue #106): a run left non-terminal with no PR, no stored verdict, and all tasks terminal is driven to `failed` so a pre-fix ghost `running` card self-heals on the next restart — the durable fix drives such runs terminal at pass completion in `decideNext` (`finalizeEmptyPass`), this only backfills runs stranded before it landed

- Run migrations: `npx drizzle-kit push`
- Generate migrations: `npx drizzle-kit generate`
- DB client: `import { db } from "@/db"`

## Development

```bash
pnpm dev          # Start dev server
pnpm build        # Production build
pnpm lint         # Run ESLint
```

### Running locally (outside Docker Compose)

Local dev runs the orchestrator via `doppler run -- pnpm dev` — orchestrator secrets live in the Doppler `interlude/dev` config, not a `.env`. Two things Compose provides on the VPS that you must set up by hand locally:

- **Agent-container network:** run `docker network create interlude` once. Agent containers attach to the `interlude` network, which Compose creates on the VPS but `pnpm dev` does not — without it, task runs fail with "network interlude not found".
- **Claude auth for agent containers:** set `CLAUDE_CODE_OAUTH_TOKEN` (in `interlude/dev`) to a token minted with `claude setup-token` — otherwise the agent errors with "Not logged in". This env token (or `ANTHROPIC_API_KEY`) is the only way Claude auth reaches an agent container; the legacy `CLAUDE_CREDENTIALS_PATH` credentials-file mount was removed in issue #28 (see the "no host mount" convention below).

## Current Status: Phase 4 done and verified on VPS; Phase 5 next

Phases 1, 2a, 2.5, 2b, 2c, 2d, and 3 are done and tested end-to-end on VPS. The full flow works: create task → agent runs in Docker → output streams to chat UI → branch pushed to GitHub after each turn → interactive follow-up messages → live preview of dev server via subdomain → complete task. GitHub issues labeled `interlude` auto-create tasks, and agent work auto-produces draft PRs.

Phase 4 (Discord bot + Discord-first task lifecycle) is merged (#8, plus backlog polish in #10), deployed to the VPS, and verified end to end there — link a channel, dispatch, idle notification, ✅ complete.

Phase 5 (autonomous ticket-loop + fleet observability) is specced —
`docs/specs/2026-07-30-phase5-autonomous-ticket-loop-design.md` — and awaiting
decomposition into tickets. It depends on Phase 4 being live on the VPS.

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

### Phase 4: Discord Bot + Discord-First Lifecycle (done)
- Discord bot via discord.js Gateway for bidirectional messaging (chose Discord over Slack/Telegram)
- Channel-per-project mapping via `!link` / `!unlink`; messages create tasks, replies deliver follow-ups, `cancel` cancels
- Outbound lifecycle embeds: queued / completed / failed
- Discord-first loop: idle "agent finished a turn" notification with summary; react ✅ to complete from Discord; auto-PR for any task origin; completion marks the PR ready
- Spec: `docs/specs/2026-04-09-phase4-discord-bot-design.md`; enhancement spec: `docs/specs/2026-07-24-discord-first-lifecycle-design.md`
- Plans: `docs/superpowers/plans/2026-04-09-phase4-discord-bot.md`, `docs/superpowers/plans/2026-07-24-discord-first-lifecycle.md`

### Phase 5: Autonomous Ticket-Loop + Fleet Observability (next)

Interlude becomes a second executor of the estate's ticket-loop contract
(`~/code/platform/choices/ai-dev-workflow.md`) — many independent per-ticket
loops running unattended, with the tracker as the coordinator and no
orchestrating agent. Autonomy is **additive**: interactive chat + live preview
(the original lovable-style use case) stays first-class.

- Pickup: `ready-for-agent` label webhook + reconciliation sweep; the tracker is
  the queue. Only a human ever applies `ready-for-agent`
- Per-project autonomy toggle + global kill switch; per-project preflight
  (GitHub App, branch protection, reviewer collaborator) with a stated reason
- Loop per ticket: implement pass in its own container on `agent/issue-<n>` →
  draft PR marked ready → deterministic review-gate evaluation → review pass
  (fresh context, `ticket-reviewer`) → auto-merge armed, or `human-signoff`
- Reviewer identity: PAT never enters a container; the pass returns a structured
  verdict (approve / request-changes / escalate) and the **orchestrator** posts
  the review via Octokit
- Deterministic skeleton: one pure reducer `decideNext(snapshot) → Action[]`
  covers pickup, gating, arming, escalation, attempt accounting and pausing;
  Docker/GitHub/Discord/DB work is a thin executor of Actions
- Budgets: $20 per attempt (ticket-directive override capped at $75), ~$5 per
  review, 3 attempts then `ready-for-human`, $500/day estate cap (interactive
  work exempt)
- Capacity: slots derived from the Docker daemon's CPU/memory at boot (VPS
  resize understood automatically); hard per-container memory/CPU limits
  (pulled forward from Phase 6); capacity expressed as a provider seam for
  Phase 7
- HITL: `checkpoint:` directive → supervised run (forced `human-signoff`);
  mid-run `BLOCKED:` marker parks the run and asks the question in Discord,
  where a reply becomes the next turn
- Triage pass on `issues.opened`: recommend (human clicks the label) /
  `needs-info` / `ready-for-human` + suggested grilling agenda. Never applies
  `ready-for-agent`, never edits or closes issues
- Observability: fleet dashboard as the home page (slots, active runs with
  attempt/turn/spend, "needs you", recent completions, spend vs cap) over a new
  `runs` ledger, via one pure `buildFleetView` read model shared with a
  deterministic daily Discord digest. Discord stays push-only — no routine
  success pings, no `!status` in v1
- Schema: new `runs` table; `tasks` gains `runId` + `kind`
  (interactive/implement/review/triage); `projects` gains autonomy + preflight
- Restart safety: a run interrupted by an orchestrator restart is re-claimed
  without consuming an attempt (bounded); live-run containers are reaper-exempt
- Rollout: flip `products/interlude.yaml` to `ai_workflow: ticket-loop`, run the
  repo's ticket-loop migration (triage labels, `docs/agents/`, review-gates
  extension, `setup-reviewer.sh`); pilot on interlude (its own UI backlog),
  lemons and last-person-standing
- Spec: `docs/specs/2026-07-30-phase5-autonomous-ticket-loop-design.md`

**Dropped from the original Phase 5** (contradicts the ratified estate
workflow): agents collaborating on one goal, DAG/pipeline execution,
agent-to-agent delegation, execution-time task decomposition, coordination
layer. Parallelism is independent loops; dependency ordering happens at
generation time.

### Phase 5.5: Chief of Staff (candidate)
- An agent that reads the fleet and tells me what matters / proposes priorities
- Deliberately deferred: needs fleet volume to synthesise, and Phase 5's
  deterministic digest + dashboard should suffice on a 2-slot box
- If the digest reads too raw, prose-ifying it is a one-ticket upgrade first

### Phase 6: Production Hardening
- Automated backups
- Monitoring and alerting
- Push notifications
- Deploy drain mode (pause a redeploy until active runs finish — Phase 5 handles
  restarts by interrupting and re-claiming)
- (Container resource limits moved into Phase 5 — a prerequisite for unattended
  parallelism, not hardening)

### Phase 7: On-Demand Remote Compute
- Cloud provider API for machine provisioning
- Orchestrator decides local vs remote — plugs into Phase 5's capacity-provider
  seam
- Auto-teardown after task completion

### Separate initiative: general UI upgrade
Navigation, task-detail polish, project management screens, mobile ergonomics.
Grilled and ticketed on its own; becomes the first autonomous workload for
Phase 5's loop. Phase 5 itself ships only the fleet dashboard.

## Specs and Plans

- Design spec: `docs/specs/2026-03-10-phase1-chat-ui-api-design.md`
- Implementation plan: `docs/plans/2026-03-10-phase1-chat-ui-api.md`
- Phase 2a spec: `docs/specs/2026-03-11-phase2a-agent-orchestrator-design.md`
- Phase 2a plan: `docs/plans/2026-03-11-phase2a-agent-orchestrator.md`
- VPS deployment spec: `docs/specs/2026-03-12-vps-deployment-design.md`
- Phase 5 spec: `docs/specs/2026-07-30-phase5-autonomous-ticket-loop-design.md`
- Operator runbook (Phase 5 autonomy): `docs/runbook.md`
- Overall design: see `docs/plans/2026-03-10-remote-agent-dev-environment-design.md` (external)

## Platform Context

Platform standards and choices: see /workspace/platform/ (in agent containers)
or ~/code/platform/ (on local machines).
This project's registry entry: products/interlude.yaml

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues, operated via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary — the five canonical role names used as-is (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Review gates

Repo-specific human-sign-off gates extend the estate defaults additively in `docs/agents/review-gates.yaml`. A PR touching a gated path is never auto-merged — it gets `human-signoff` and waits for a human. See `~/code/platform/standards/review-gates.md`.
