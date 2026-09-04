# Roadmap

Phase history and what is next. This used to live in the agent context file; it moved here because it is a development log, and `AGENTS.md` describes the project as it is now. Update the status paragraph and the phase list here when a phase lands.

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
- **Sandbox hardening (security, not just ops).** The autonomous loop is where
  untrusted input first reaches an unattended agent (triage on `issues.opened`,
  webhook-delivered ticket/PR text), so "hardening" here means security too.
  Agent containers today run on Docker defaults — non-root uid 1000 and no
  mounted docker socket are the only real controls; no dropped caps, no egress
  limits, `--dangerously-skip-permissions` always on, live secrets in scope.
  - Cheap wins on the existing local Docker path: `--cap-drop=ALL`,
    `--security-opt=no-new-privileges`, `--pids-limit`; exec-scope `DOPPLER_TOKEN`
    like the git token so it isn't sitting in PID 1's environ all run
  - Egress control: flip the agent network to `internal: true` + an allowlist
    proxy (Doppler / GitHub / Anthropic) — the highest-leverage single change
    against exfiltration and agent-to-agent reachability
  - Deferred out of Phase 5 deliberately: Phase 5 ships/tests in place with the
    current posture (single-tenant, self-authored tickets), which the threat
    model tolerates

### Phase 7: On-Demand Remote Compute
- Cloud provider API for machine provisioning
- Orchestrator decides local vs remote — plugs into Phase 5's capacity-provider
  seam
- Auto-teardown after task completion
- **Kernel / tenant isolation rides this seam.** A real kernel boundary
  (gVisor `runsc`, or microVMs à la Firecracker / Kata) belongs here, not
  retrofitted onto the local Docker path: ephemeral per-task remote machines
  with auto-teardown give strong isolation nearly for free, whereas hardening
  the local runtime is pure cost the remote path then obsoletes
- Forcing function: **multi-tenancy** (someone else's tickets on the box) would
  pull this tier forward from Phase 7 into a blocker. Not on the roadmap today,
  so the phasing holds — but it's the one event that reorders everything
- **Shape and economics settled 2026-08-05** (after the OOM incidents proved
  2 concurrent agents + orchestrator UI don't fit on a 4GB box): the design is
  **hybrid overflow**, not all-remote. The local box keeps 1 serial slot
  (`CAPACITY_SLOTS=1`, `AGENT_MEMORY_MB=2048` in Doppler `interlude/prd`) and
  hosts all interactive sessions + live preview (preview rides the local
  Docker network); overflow slots provision per-task/per-burst cloud VMs via
  provider API, driven over remote Docker (`dockerode` ssh://), image from a
  registry, auto-torn-down when idle. Remote slots are autonomous
  implement/review only — explicitly preview-less. Economics: agent work is
  bursty (10–60 min attempts, a few hours/day), so hourly-billed overflow at
  ~3–6p/container-hour ≈ £2–8/mo beats a permanent resize (+£32/mo standing at
  2026 pricing, rejected on cost) by ~5× while scaling elastically. A resize
  only wins if zero-engineering parallelism is needed immediately.

### Separate initiative: general UI upgrade
Navigation, task-detail polish, project management screens, mobile ergonomics.
Grilled and ticketed on its own; becomes the first autonomous workload for
Phase 5's loop. Phase 5 itself ships only the fleet dashboard.

