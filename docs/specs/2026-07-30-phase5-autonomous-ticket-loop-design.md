# Phase 5 — Autonomous Ticket-Loop + Fleet Observability

> Design spec. Supersedes the previous "Phase 5: Multi-Agent Workflows" roadmap
> entry (multiple agents collaborating on one goal, DAG execution, agent-to-agent
> delegation, coordination layer), which is dropped — see
> [Out of Scope](#out-of-scope) for why.
>
> Depends on: Phase 3 (GitHub App, webhooks, draft PRs), Phase 4 (Discord bot,
> Discord-first lifecycle). Platform contract:
> `~/code/platform/choices/ai-dev-workflow.md` and
> `~/code/platform/standards/review-gates.md`.

## Problem Statement

Work is generated as GitHub Issues (the estate's ticket-loop workflow) but every
ticket still needs me to sit down at a laptop, pick one, and babysit
`scripts/ticket-loop.sh` through it. Interlude already runs agents on a VPS with
Docker, GitHub and Discord wired up — but it only ever runs work I dispatch by
hand, one conversation at a time. So the backlog only moves when I am present,
and the machine that could be working while I sleep is idle.

I also can't tell, at a glance, what my agents are doing. Today the only answers
to "how many agents are running, on what, and what finished recently?" are
scrolling a task list and reading Discord history. If agents start picking up
work unattended, that blindness becomes the main risk: unattended work I can't
see is unattended work I can't trust — and I need to know, specifically, when an
agent is stuck and waiting on me rather than making progress.

Two further constraints are mine and non-negotiable. The VPS is a Hetzner CX22
(2 vCPU / 4 GB) which also hosts the orchestrator and Caddy, so unattended
parallelism without hard resource limits will eventually take the whole platform
down. And interlude's original purpose — lovable-style remote paired development,
where I chat with an agent and watch a live preview without a dev environment —
must stay first-class; autonomy is additive, never a replacement.

## Solution

Interlude becomes a **second executor of the platform's ticket-loop contract**,
running the same loop the laptop runner runs, unattended, on the VPS.

I arm work by applying `ready-for-agent` to an issue — that label is the launch
button, and applying it always requires a human decision — mine directly, or my
yes to an agent that asked. Interlude notices (webhook, backed by a
reconciliation sweep), waits for a free slot, and runs the loop: implement pass
in its own container on `agent/issue-<n>`, draft PR, deterministic review-gate
evaluation, then a review pass with fresh context under the separate reviewer
identity. Ungated PRs auto-merge on the reviewer's approval; gated ones get
`human-signoff` and wait for me. Nothing about the loop's shape is decided by a
model: pickup, gating, arming, attempt accounting and merge policy are ordinary
deterministic code, and the model only ever runs inside a pass.

Because agents now work while I'm away, two communication paths become
first-class. A **fleet dashboard** replaces the task list as interlude's home
page and answers "what is happening right now" — slots in use and by what,
active runs with attempt/turn/spend, a "needs you" section, recent completions,
and today's spend against the cap. **Discord stays push-only** and tells me when
to look: a run was claimed, an agent is blocked and asking a question (which I
answer by replying), a PR hit a gate, a ticket burned its third attempt, the
daily spend cap paused pickup, all slots are busy. Plus one deterministic daily
digest each morning. Routine success doesn't ping me — autonomy I have to
acknowledge constantly isn't autonomy.

Two smaller pieces complete the loop. An agent that hits a decision its ticket
doesn't resolve **stops and asks** rather than guessing, using the existing
idle-and-reply plumbing. And a **triage pass** meets handwritten issues as they
arrive: it either recommends the ticket for arming (I confirm — a label click, or
a yes in Discord that the orchestrator acts on), asks for
the missing information, or tells me this one needs a grilling session before
anyone writes code.

## User Stories

### Arming and picking up work

1. As the estate owner, I want to arm a ticket by applying `ready-for-agent` to a
   GitHub issue, so that starting unattended work is one deliberate click and
   nothing else can start it.
2. As the estate owner, I want interlude to react to the label within seconds via
   webhook, so that armed work starts while I'm still looking at the issue.
3. As the estate owner, I want a reconciliation sweep that finds armed tickets on
   a timer regardless of webhooks, so that a missed or replayed delivery only
   delays work rather than losing it.
4. As the estate owner, I want tickets that were armed before autonomy was
   enabled to be picked up by the same sweep, so that enabling autonomy drains
   the existing backlog without me re-labelling anything.
5. As the estate owner, I want the tracker to remain the queue — with no
   duplicate backlog inside interlude — so that killing or redeploying interlude
   never loses queued work.
6. As the estate owner, I want a per-project autonomy toggle, so that I can stop
   one project's unattended work without unlabelling issues estate-wide.
7. As the estate owner, I want a global autonomy kill switch, so that I can stop
   all unattended pickup instantly and still dispatch interactive tasks myself.
8. As the estate owner, I want a project to be ineligible for autonomy until its
   GitHub App is installed and it has been through `setup-reviewer.sh`, so that
   the loop can never run somewhere its safety rails (branch protection,
   reviewer collaborator) don't exist.
9. As the estate owner, I want to see *why* a project is ineligible, so that
   fixing it is a named action rather than a guess.
10. As the estate owner, I want only issues authored by an allow-listed account
    (me, by default) to be claimable, so that a labelled issue from anyone else
    still can't put agent-written code on a branch.
11. As the estate owner, I want tickets with an unresolved blocker (a native
    GitHub issue dependency or a `Blocked by: #N` line) to be ineligible, so that
    dependency-ordered tickets execute in order without an orchestrator.
12. As the estate owner, I want oldest-armed-first ordering, so that pickup
    ordering is predictable and priority is expressed by *when I arm work*.
13. As the estate owner, I want the `interlude` label to keep meaning "start an
    interactive task", separate from `ready-for-agent`, so that Phase 3's
    behaviour is unchanged.

### Capacity, resource limits and spend

14. As the estate owner, I want the number of concurrent agent slots derived from
    the Docker daemon's actual CPU and memory at boot, so that resizing the VPS
    is understood automatically without a config change.
15. As the estate owner, I want to override the derived slot count, so that I can
    tune it when the derivation is wrong for a particular workload.
16. As the estate owner, I want every agent container to run under a hard memory
    and CPU limit, so that a runaway agent fails its own task instead of taking
    the orchestrator and Caddy down with it.
17. As the estate owner, I want implement, review and triage passes to draw from
    one shared slot pool, so that capacity accounting has no special cases I have
    to reason about.
18. As the estate owner, I want in-flight work (a review, a fix-up after review,
    an answered question) to outrank starting new work, so that the platform
    finishes things rather than accumulating half-done runs.
19. As the estate owner, I want an interactive task I dispatch myself to outrank
    new autonomous claims for the next free slot, so that my own paired-programming
    session is never starved by background work.
20. As the estate owner, I want both slots to be allowed to run autonomous work,
    so that the box is fully used when I'm not around.
21. As the estate owner, I want saturation to be visible on the dashboard and
    announced once in Discord, so that a queued interactive task is explained
    rather than mysterious.
22. As the estate owner, I want to cancel an autonomous run to free a slot, so
    that I can take the machine back immediately without a preemption mechanism.
23. As the estate owner, I want a default per-attempt budget of $20, so that a
    normal ticket has room to finish without me tuning anything.
24. As the estate owner, I want a ticket to be able to raise its own budget via a
    directive in its body, so that a known-big ticket isn't capped at the default.
25. As the estate owner, I want a hard ceiling on that override, so that issue
    text — which is semi-trusted input — can never authorise unlimited spend.
26. As the estate owner, I want the review pass to carry its own small budget
    separate from the implement budget, so that reviewing never eats an attempt's
    allowance.
27. As the estate owner, I want at most three attempts per ticket, so that no
    ticket can be re-spent on forever.
28. As the estate owner, I want an estate-wide daily spend cap that pauses
    autonomous pickup when hit, so that a bad day has a known ceiling.
29. As the estate owner, I want interactive tasks exempt from the daily cap, so
    that a paused fleet doesn't block me working by hand.
30. As the estate owner, I want to see today's spend against the cap on the
    dashboard, so that a pause is never a surprise.

### The loop: implement, gate, review, merge

31. As the estate owner, I want the implement pass to run in its own container on
    `agent/issue-<n>` with a fresh clone, so that runs are isolated from each
    other and from my machine.
32. As the estate owner, I want the ticket body to be the spec, with no second
    planning ceremony, so that generation-time work isn't repeated at execution
    time.
33. As the estate owner, I want a ticket's own Workflow section to drive the pass
    when present and a sensible default workflow otherwise, so that per-ticket
    process overrides work without a workflow-menu build.
34. As the estate owner, I want a draft PR opened on first branch push and marked
    ready when the implement pass finishes, so that review has something to
    review without me touching GitHub.
35. As the estate owner, I want review gates evaluated by the orchestrator from
    the gate config on the **default branch**, so that a PR can never widen its
    own gates.
36. As the estate owner, I want gate evaluation to match the platform's bash glob
    semantics exactly, so that the same PR is gated the same way whether the
    laptop runner or interlude evaluated it.
37. As the estate owner, I want gate evaluation to fail closed on missing or
    unparseable config, so that a config error can never arm an auto-merge.
38. As the estate owner, I want the review pass to run in a separate container
    with fresh context using the canonical `ticket-reviewer` definition, so that
    the agent that wrote the code never grades its own work.
39. As the estate owner, I want the reviewer's GitHub credential to never enter
    any container, so that the implement agent cannot obtain the identity that
    approves its work.
40. As the estate owner, I want the reviewer's verdict returned as structured
    output and the review posted by the orchestrator, so that approval is an act
    of trusted code rather than of a model with a token.
41. As the estate owner, I want the reviewer to be able to approve, request
    changes, **or** escalate to human sign-off, so that it can add human review
    without ever removing it.
42. As the estate owner, I want an unparseable verdict treated as an error that
    blocks merge and pings me, so that ambiguity fails safe.
43. As the estate owner, I want ungated PRs to auto-merge (squash) on the
    reviewer's approval, so that clean work lands without me.
44. As the estate owner, I want gated PRs labelled `human-signoff` with
    auto-merge disarmed, so that consequential changes wait for my eyes with the
    reviewer's assessment already attached.
45. As the estate owner, I want "changes requested" to feed back into the same
    container as a follow-up turn, so that a small fix doesn't cost a whole fresh
    attempt.
46. As the estate owner, I want a bounded number of review cycles per attempt, so
    that implement and review can't ping-pong indefinitely.
47. As the estate owner, I want the third failed attempt to swap the ticket to
    `ready-for-human` with a summary comment and a Discord ping, so that dead
    tickets come back to me instead of looping.
48. As the estate owner, I want issue lifecycle comments for autonomous runs
    (claimed, attempt N, PR opened, verdict, gated, exhausted), so that the issue
    thread is a complete record without the dashboard.
49. As the estate owner, I want the orchestrator to never apply `ready-for-agent`
    itself, so that the arming boundary holds no matter what any agent does.

### Human-in-the-loop

50. As the estate owner, I want a ticket to be markable at generation time as
    decision-heavy via a `checkpoint:` directive, so that agent-doable-but-risky
    work runs supervised rather than landing unseen.
51. As the estate owner, I want a supervised run to open its PR and then stop at
    `human-signoff` regardless of gate matches, so that the checkpoint is
    honoured by the same machinery that handles gates.
52. As the estate owner, I want the checkpoint's question carried into the
    Discord ping, so that I know what decision is waiting for me.
53. As an implementing agent, I want to stop and emit a `BLOCKED:` question when
    the ticket doesn't resolve a decision, so that I ask instead of guessing.
54. As the estate owner, I want a blocked run parked with its container alive and
    its question posted to Discord, so that answering is cheap and the agent
    keeps its context.
55. As the estate owner, I want my Discord reply delivered to the parked agent as
    the next turn, so that unblocking work is a phone message, not a session.
56. As the estate owner, I want blocked questions for projects with no linked
    Discord channel posted to a fleet channel, so that no question is silently
    lost.
57. As the estate owner, I want detection of the blocked marker biased toward
    false negatives, so that a mis-detection means "the run idles and I see it on
    the dashboard" rather than "the run parks for no reason".
58. As the estate owner, I want no AI classifier deciding AFK-versus-HITL at
    pickup time, so that the decision stays where triage already made it.

### Triage of handwritten issues

59. As the estate owner, I want a new issue triaged automatically against the
    repo's context, so that the backlog is shaped without me doing a triage pass.
60. As the estate owner, I want a well-specified issue to receive an assessment
    comment and a Discord recommendation to arm it, so that arming is one click
    with reasoning attached.
61. As the estate owner, I want an underspecified issue labelled `needs-info`
    with the specific questions asked, so that I answer questions rather than
    rewriting the issue.
62. As the estate owner, I want a decision-shaped issue labelled
    `ready-for-human` with a suggested grilling agenda, so that design work is
    routed to a conversation instead of to code.
63. As the estate owner, I want triage to never apply `ready-for-agent`, edit
    issue bodies, or close issues, so that its blast radius is comments and
    advisory labels only.
64. As the estate owner, I want triage to run cheap and short, so that shaping
    the backlog costs a fraction of implementing a ticket.

### Fleet observability

65. As the estate owner, I want a fleet dashboard as interlude's home page, so
    that "what's going on?" is answered by opening the app.
66. As the estate owner, I want slots shown as used-of-total with what occupies
    each one, so that I can see whether the box is busy with autonomous work or
    with me.
67. As the estate owner, I want each active run to show its ticket, project,
    attempt number, turn count, spend against budget, phase and mode, so that I
    can judge progress without reading the transcript.
68. As the estate owner, I want a "needs you" section aggregating blocked
    questions, `human-signoff` PRs, exhausted tickets, a cap pause and failed
    project preflights, so that there is exactly one place that tells me what to
    do next.
69. As the estate owner, I want recent completions with their PR links and cost
    over the last several days, so that "what got done recently?" is a query and
    not archaeology through Discord.
70. As the estate owner, I want the dashboard to update live over the existing SSE
    channel, so that watching the fleet doesn't need refreshing.
71. As the estate owner, I want the dashboard to work on my phone, so that
    checking the fleet from the sofa is the normal case.
72. As the estate owner, I want a durable run ledger behind all of this, so that
    history survives container removal and orchestrator restarts.
73. As the estate owner, I want a deterministic daily digest in Discord —
    completed, running, blocked-on-me, backlog depth, spend — so that I start the
    day with a summary that cannot be hallucinated.
74. As the estate owner, I want Discord to stay push-only for exceptional events
    with no routine-success spam, so that a notification always means something.
75. As the estate owner, I want the dashboard and digest to share one read model,
    so that they can never disagree about the state of the fleet.

### Robustness and rollout

76. As the estate owner, I want a redeploy that restarts the orchestrator during
    active runs to recover deterministically, so that dogfooding interlude on
    itself doesn't corrupt the fleet.
77. As the estate owner, I want a run interrupted by an orchestrator restart to be
    re-claimed **without** consuming one of its three attempts, so that my
    infrastructure's downtime isn't charged to the ticket.
78. As the estate owner, I want re-claims after interruption bounded, so that a
    crash caused by the ticket itself can't loop forever.
79. As the estate owner, I want containers belonging to live runs protected from
    the reaper, so that recovery isn't fighting cleanup.
80. As the estate owner, I want the capacity check expressed as a provider seam,
    so that Phase 7's burst compute plugs in without reworking the scheduler.
81. As the estate owner, I want interactive chat with live preview to behave
    exactly as it does today, so that the platform's original purpose survives
    this phase.
82. As the estate owner, I want to pilot autonomy on interlude, lemons and
    last-person-standing, so that the loop is proven on its own repo and on two
    already-migrated ones.
83. As the estate owner, I want interlude's own UI-upgrade backlog to be the first
    autonomous workload, so that the shakedown bites me rather than a real
    project.

## Implementation Decisions

### Architecture: native executor, not a wrapped script

Interlude implements the ticket-loop contract natively rather than shelling out
to the platform's `scripts/ticket-loop.sh` inside a container. The script remains
the laptop runner; the *contract* (labels, `agent/issue-<n>` branches,
`review-gates.yaml`, PR conventions, reviewer identity) is the interface, and the
platform doc already frames executors as swappable.

Three reasons this is native, all of which failed under the wrap-the-script
approach: the reviewer credential would have had to enter the same container as
the implement agent; structured turn output (already parsed for the chat UI)
would collapse into opaque shell stdout, defeating the observability half of this
phase; and gate evaluation — the owner's mechanical control surface — must be
trusted code, not code an agent's container can influence.

### Seam: a pure decision reducer plus a pure read model

Two seams, both pure functions, and they are where the tests live.

**Write side.** The autonomy loop is `gather snapshot → decide → execute`:

```
decideNext(snapshot) -> Action[]

Action =
  | { type: 'claimIssue',   issue, budgetUsd, maxTurns, attempt, mode }
  | { type: 'startReview',  runId, prNumber }
  | { type: 'postVerdict',  runId, prNumber, verdict, body }
  | { type: 'gatePr',       runId, prNumber, categories }
  | { type: 'armAutoMerge', runId, prNumber }
  | { type: 'deliverFeedback', taskId, body }      // review -> fix-up turn
  | { type: 'escalate',     runId, taskId, question }
  | { type: 'exhaust',      runId, issue, reason } // 3 strikes -> ready-for-human
  | { type: 'startTriage',  issue }
  | { type: 'applyTriage',  issue, labels, comment }
  | { type: 'pausePickup',  reason }               // no slots | daily cap | autonomy off
  | { type: 'notify',       event, payload }
  | { type: 'comment',      issue, body }
```

The snapshot carries everything the decision depends on and nothing else: the
current time (passed in, never read inside), global and per-project autonomy
flags with preflight results, derived slot capacity and what currently occupies
each slot, candidate issues (number, author, labels, body, created-at, blocker
states), active runs with attempt/cost/phase/review-cycle counts, today's
autonomous spend, parsed gate config plus the PR's changed paths, the latest
pass's terminal output markers, and the set of in-flight action keys (the
existing `processingTasks` idempotency pattern, lifted into the snapshot).

Everything model-shaped or I/O-shaped lives outside: dockerode, Octokit,
discord.js, Drizzle, Doppler, and the passes themselves. The executor's only job
is to perform Actions and record results. This is what "appropriately
deterministic" means in practice — the loop's shape is a table-testable function.

**Read side.** `buildFleetView(rows) -> FleetView` produces the slots, active
runs, needs-you buckets, recent completions and spend summary. The dashboard
renders it live; the daily digest renders the same structure over yesterday's
window. One read model, two renderers, so they cannot disagree.

**Reducer priority order** (a decision, not an implementation detail):
in-flight work (deliver an answer, run a review, apply review feedback) → an
interactive task I dispatched → triage of new issues → a new autonomous claim.
Cheap, finishes work before starting more, and never starves the human.

### Schema

Two new concepts, added rather than overloaded:

- **`runs`** — the loop ledger. One row per *attempt* of one ticket: project, the
  issue reference (same `owner/repo#n` convention `tasks.githubIssue` already
  uses), attempt number, mode (`autonomous` | `supervised`), status (`claimed`,
  `implementing`, `reviewing`, `gated`, `blocked`, `merged`, `failed`,
  `exhausted`, `interrupted`, `cancelled`), resolved budget and accumulated cost,
  PR number/URL, gate categories matched (null = ungated), review verdict, review
  cycle count, interruption count, blocked question, and claimed/started/finished
  timestamps. Daily autonomous spend is a sum over this table, which is why
  interactive tasks — having no run — are exempt by construction.
- **`tasks.runId` + `tasks.kind`** — `kind` is `interactive` (default, today's
  behaviour), `implement`, `review` or `triage`. Tasks remain the
  container-and-conversation unit; a run owns one or more of them. This reuses the
  entire existing container/turn/streaming machinery for autonomous passes, so
  every pass is visible in the UI exactly like a chat task.
- **`projects`** gains `autonomyEnabled` plus cached preflight status and reason
  (App installed, branch protection present, reviewer is a collaborator,
  `human-signoff` label exists), refreshed on toggle and periodically so the UI
  can name what's missing.

Migrations follow the repo's Drizzle convention (`drizzle-kit generate`, then
push), noting that migration 0007 already needed reconciling once — the new
columns must be additive with defaults so a drifted DB upgrades cleanly.

### Discovery and eligibility

Pickup is driven by the `issues.labeled` webhook for `ready-for-agent` (fast
path) plus a reconciliation sweep on its own interval — default 30s, distinct
from the existing 2s task-queue poll — and on boot. The sweep is the backbone;
the webhook is latency. Both feed the same reducer, so there is one decision
path, not two.

An issue is claimable only if: its project is registered with a GitHub `gitUrl`
and passing preflight; project autonomy and global autonomy are both on; the
issue author is allow-listed (default: the repo owner) — defence in depth behind
the human-only labelling rule; the issue has no open blocker (native GitHub issue
dependency, or a `Blocked by: #N` line in the body); and no active run exists for
it. Ordering is oldest-armed-first, globally. No priority field exists anywhere:
priority is expressed by when I arm work.

`ready-for-agent` and `interlude` remain separate triggers; if both are present,
`ready-for-agent` wins and no duplicate interactive task is created. The claim
does **not** strip the label — arming lives in the tracker, execution state lives
in `runs`, and the merge closes the issue via the PR's `Closes #n`.

### Capacity and resource limits

Slots are derived at boot from the Docker daemon's reported CPU count and total
memory: `floor((memTotal - orchestratorReserveMb) / perAgentMb)`, capped by CPU,
minimum 1, with an explicit env override. On the CX22 (4 GB, ~1.5 GB reserve,
~1.2 GB per agent) that yields 2 — matching today's practical ceiling — and a VPS
resize is understood after a reboot with no config change.

Every agent container — interactive, implement, review and triage alike — is
created with hard memory and CPU limits via dockerode `HostConfig` (Phase 6's
resource-caps item, pulled forward because unattended parallelism makes it a
prerequisite rather than hardening). Hitting the memory cap fails that task, not
the platform.

The capacity check is expressed as a **provider seam** — "is a slot available,
and where?" — rather than a direct local-Docker query, so Phase 7's on-demand
remote compute can answer the same question differently without touching the
scheduler.

### Budgets and attempt accounting

Resolved per attempt, all deterministic: default $20, raisable by a ticket
directive up to a hard $75 ceiling that issue text cannot exceed, review passes
on a separate ~$5 allowance, triage on a small allowance with a low turn cap, and
a $500/day estate-wide autonomous cap that pauses pickup (announced once in
Discord, shown on the dashboard, reset at local midnight) while leaving
interactive work untouched.

An **attempt** is one claim: fresh container, fresh clone. Within an attempt, up
to two implement↔review cycles are allowed — "changes requested" is delivered to
the still-live container as a follow-up user message via the existing message
queue, which is both cheaper and closer to how a human PR works than starting
over. An attempt fails on budget/turn exhaustion, container error, or review
cycles exhausted. Three failed attempts swap `ready-for-agent` for
`ready-for-human`, comment a summary, and ping Discord. Because the enterprise
subscription rather than API billing may back agent auth, these numbers act as
runaway counters as much as dollar caps — the mechanism is identical either way.

### Ticket directives (semi-trusted input)

The orchestrator parses a bounded directive set from the ticket's Workflow
section: `budget:` (clamped to ceiling), `max-turns:` (clamped), `checkpoint:`
(→ supervised mode, carrying its text as the question), and `workflow:`
(informational in v1 — no workflow-menu files exist in the platform repo yet, so
a ticket's own Workflow prose drives the pass, with a default
implement-test-lint-commit-push workflow otherwise). Unknown keys are ignored.
Directives may only adjust bounded numbers or *add* human oversight; no directive
can disable a gate, change the reviewer, arm auto-merge, or touch the daily cap.
Issue content is framed as data in the pass prompt, never as instructions to the
orchestrator.

### Review: gates, identity, verdict

Gate evaluation is a TypeScript port of `scripts/review-gates-lib.sh`, matching
its bash glob semantics exactly (`*` crosses `/`; a leading `**/` also matches at
the repo root), reading `standards/review-gates.yaml` from the platform repo plus
the target repo's `docs/agents/review-gates.yaml` extension **from the default
branch**, and additive-only. Missing or unparseable config fails closed: no
arming, escalate to me. The PR's changed paths come from the GitHub API.

The review pass runs in a separate container with a fresh clone and fresh
context, using the canonical `ticket-reviewer` definition from the platform repo
(already cloned into containers). It receives the ticket, the PR diff and the
repo's standards — and no credentials beyond the ordinary short-lived App
installation token used for cloning.

**The reviewer's GitHub PAT never enters a container.** This is a deliberate
strengthening of the laptop runner's approach: the pass returns a structured
verdict (`approve` | `request-changes` | `escalate`, plus a body), and the
orchestrator posts the review through Octokit using `REVIEWER_GH_TOKEN` fetched
from Doppler at review time. Approval therefore becomes an act of trusted code
reading a parsed verdict, and no agent process ever holds the identity that can
approve agent work. An unparseable verdict is an error: no merge, ping me. The
third verdict, `escalate`, exists because the review-gates standard requires the
reviewer to be able to add human sign-off (disarm, label, comment-only review)
while never being able to remove it.

Sequencing per attempt: implement pass ends → branch pushed → draft PR marked
ready → gates evaluated → ungated: auto-merge armed (squash) then review posted,
so the approval lands it; gated or supervised: `human-signoff` applied,
auto-merge left disarmed, review posted as a comment or approval per verdict.
Arming happens after the final push, since branch protection dismisses stale
approvals.

Review is a separately queued unit of work drawing a slot like any other pass —
short and cheap, but memory is memory on a 4 GB box. A consequence worth noting:
because review is decoupled from implement, reviewing a manually opened PR later
becomes a small addition rather than a redesign.

**Doppler note:** the orchestrator boots under `doppler run --project interlude
--config prd`, and a service token is scoped to one config, so
`REVIEWER_GH_TOKEN` is mirrored into `interlude/prd` rather than read from
`platform/prd`. Rotation must update both places — recorded here because the
platform doc names `platform/prd` as the canonical home.

### Escalation and supervised mode

An implement pass's prompt carries an explicit contract: on hitting a decision
the ticket doesn't resolve, stop and make `BLOCKED: <question>` the first line of
the turn's final message. The orchestrator detects that marker deterministically
(first line only, to bias toward false negatives — a missed detection merely
idles the task where the dashboard shows it, whereas a false positive parks
healthy work), sets the run `blocked`, keeps the container alive, and posts the
question to the project's linked Discord channel or, absent one, a configured
fleet channel. My reply becomes a queued user message on the task and the
existing queue delivers it as the next turn — the Phase 4 idle-and-reply plumbing
carries this whole feature.

Supervised mode (from a `checkpoint:` directive) runs the implement pass
normally, then forces `human-signoff` regardless of gate matches and pings me
with the checkpoint text. It reuses the gate machinery rather than adding a
lifecycle state.

### Triage

On `issues.opened` for a registered project (plus sweep pickup of stray
`needs-triage`), a triage pass runs as a short, cheap container (`kind: triage`)
with read-oriented context: the issue, the repo's `CONTEXT.md`/ADRs where they
exist, and open issues. It returns one of three structured exits, which the
orchestrator applies: **recommend** (assessment comment + Discord ping suggesting
I arm it — *I* apply the label), **needs-info** (label + the specific questions),
or **ready-for-human** (label + a suggested grilling agenda). It may not apply
`ready-for-agent`, edit issue bodies, or close issues; those are enforced
orchestrator-side, not by prompt.

### Notifications and the dashboard

Discord gains fleet events, all push-only: run claimed, blocked question
(reply-able), gate/checkpoint → `human-signoff`, attempts exhausted, daily cap
pause, slots saturated (once per transition), triage recommendation, and the
daily digest. Autonomous success is deliberately silent — it appears on the
dashboard and in the digest. Phase 4's interactive embeds (queued, idle, complete,
failed, ✅-to-complete) are unchanged. No `!status` command in v1: the dashboard
answers "what's happening", Discord answers "when to look".

The dashboard becomes the home page, rendering `FleetView` over SSE, mobile-first
per the repo's existing conventions. Its visual design is reviewed with me before
implementation, per estate design-review practice; UI tickets arising from it are
natural `checkpoint:` candidates rather than full-AFK. The broader UI upgrade is a
separate initiative (see Out of Scope) — this phase ships the dashboard only.

The daily digest is assembled by querying the ledger and rendering `FleetView` —
no LLM involved, so it cannot hallucinate a summary and costs nothing.

### Restart and recovery

Boot reconciliation extends today's orphan recovery: runs in `implementing` or
`reviewing` whose container is gone, or whose exec stream was lost to a restart,
are marked `interrupted`, their container stopped, and the ticket re-claimed
**without** consuming an attempt (work already pushed to the branch survives;
only the in-flight turn is lost). Interruptions are counted separately and
bounded, so a ticket that crashes the orchestrator can't loop forever. The
container reaper must skip containers belonging to live runs.

This matters because merging an interlude PR auto-deploys interlude: restarting
mid-fleet is a routine event here, not an edge case, and is an explicitly tested
scenario in this phase.

### Rollout

Built on interlude under the current supervised flow. Interlude's platform
registry entry flips `ai_workflow: superpowers` → `ticket-loop`, and the repo
gets the migration it hasn't had yet: canonical triage labels,
`/setup-matt-pocock-skills` output (`docs/agents/`, `CONTEXT.md`, issue-tracker
and label configuration), `docs/agents/review-gates.yaml`, and
`scripts/setup-reviewer.sh`. Pilot repos are interlude (its own UI backlog as the
first workload), lemons and last-person-standing — both already on ticket-loop in
the registry, validating the "existing ticket-loop repo, zero changes" path.

## Testing Decisions

A good test here asserts externally observable behaviour: given a snapshot of the
world, which Actions does the loop decide on — not which private helper ran. The
two seams were chosen precisely so that the phase's entire decision surface is
testable as pure functions with no mocks, which is also why no test in this phase
needs Docker, GitHub, Discord or a database.

**Prior art in this repo** (style to follow): `src/lib/orchestrator/__tests__/output-parser.test.ts`
with its `stream-fixture.ndjson` (fixture-driven parsing of agent output),
`src/lib/docker/__tests__/container-manager.test.ts` (asserting generated script
content, including negative assertions that no token is embedded), and
`src/lib/github/__tests__/repo.test.ts` (exhaustive input-shape coverage of a
pure parser). Runner is vitest via `pnpm test`; no new test infrastructure.

**`decideNext` — table-driven, one case per rule.** Coverage must include: claim
when a slot is free and everything is eligible; refuse to claim on each
individual eligibility failure (autonomy off globally, off per project, preflight
failing, App missing, non-allow-listed author, open blocker, existing active run);
oldest-first ordering; the full priority order, especially interactive-outranks-new-claim
and in-flight-outranks-everything; pause reasons distinguished (no slots vs daily
cap vs autonomy off); budget resolution including clamping an over-ceiling
directive; `checkpoint:` forcing supervised mode and therefore `human-signoff`
even with no gate match; gated versus ungated PRs producing `gatePr` versus
`armAutoMerge`; each verdict mapping to its action, with unparseable verdicts
never producing `armAutoMerge`; review-feedback delivery inside an attempt versus
exhausting review cycles; attempt accounting to `exhaust` at three; interruptions
not consuming an attempt while remaining bounded; blocked-marker detection
producing `escalate`, with negative cases proving a mid-message or quoted
`BLOCKED:` does not park a run; and triage exits never yielding a
`ready-for-agent` label.

**Fail-closed assertions get their own cases**, since they are the safety
properties rather than features: missing gate config, unparseable gate config,
unparseable verdict, and missing preflight must each produce no arming and an
escalation.

**Gate matcher — parity tests against the platform's bash semantics.** Cases
drawn directly from `standards/review-gates.yaml`: `**/components/**`,
`**/app/**/page.*`, a leading `**/` matching at the repo root, `*` crossing `/`,
additive repo extensions, and the self-gating `**/review-gates.yaml` glob. These
are the tests that keep the two executors agreeing.

**Directive parser** — table-driven over budget/max-turns/checkpoint/workflow,
unknown keys ignored, clamping enforced, and adversarial bodies (a directive-like
line inside a code fence or prose, attempts to raise the daily cap or disable
gates) proving issue text cannot widen its own authority.

**`buildFleetView`** — slot accounting including saturation attribution,
needs-you bucket population for each cause, recent-completion windowing, spend
totals excluding interactive tasks, and the digest rendering the same structure
over a shifted window.

**Pass-output parsing** reuses the fixture approach: NDJSON fixtures for a turn
ending in a blocked question, a turn ending normally, and each reviewer verdict
shape including a malformed one.

Deliberately not tested (unchanged repo convention): dockerode container
creation, Octokit calls, discord.js gateway behaviour, and Drizzle queries. Those
are exercised by the end-to-end VPS verification that has closed every previous
phase, plus one explicit manual scenario for this phase — restarting the
orchestrator (via a real deploy) while autonomous runs are active, confirming
interrupted runs re-claim without consuming attempts and no live container is
reaped.

## Out of Scope

**The original Phase 5 vision.** Multiple agents collaborating on one goal, agent
roles beyond implement/review/triage, task decomposition at execution time,
pipeline/DAG execution, agent-to-agent delegation, and a coordination layer for
shared context and merge-conflict resolution are all dropped. They contradict the
estate's ratified workflow — parallelism is several *independent* loops with the
tracker as coordinator and explicitly no orchestrating agent — and dependency
ordering is already resolved at generation time by `/to-tickets`. "Multi-agent"
in this phase means many agents at once, not agents talking to each other.

**Priority ordering.** No priority field, no queue reordering. Priority is
expressed by when I arm work; if oldest-first ever grates, adding a label to the
sweep's sort is a one-line change not worth building speculatively.

**A chief-of-staff agent** — one that reads everything, tells me what matters and
proposes priorities — is parked as a Phase 5.5 candidate. It needs fleet volume to
synthesise, and a deterministic digest plus the dashboard should cover a two-slot
box. If the digest starts feeling too raw, prose-ifying it is a one-ticket
upgrade.

**Prioritisation and synthesis agents generally.** Ordering is mine; aggregation
is a SQL query.

**The general UI upgrade.** Navigation, task-detail polish, project management
screens and mobile ergonomics become their own grilled-and-ticketed initiative —
and the pilot workload for this phase's autonomy.

**Discord query commands** (`!status` and friends), and notifications on routine
success.

**Burst compute** (Phase 7) — this phase only leaves the provider seam.
**Backups, monitoring/alerting and push notifications** (Phase 6).

**Deploy drain mode** — pausing a redeploy until active runs finish. v1 handles
restarts by interrupting and re-claiming; drain is a later refinement.

**LLM-based HITL classification at pickup time**, and any path by which an agent
could apply `ready-for-agent`.

**Changes to interactive chat, live preview, or Phase 4's Discord lifecycle.**
They keep working exactly as they do today; this phase only adds beside them.

## Further Notes

The security model reduces to one sentence: *arming always traces to a human
decision, and only trusted code can land it.* An unattended pass may recommend
but never arm, because it reads untrusted input; a human's yes — by label click
or in Discord — is a decision and may be acted on. Everything else — the author
allow-list, directive
clamping, gate config read from the default branch, the reviewer PAT never
entering a container, orchestrator-posted approvals, triage's inability to apply
`ready-for-agent` — is defence in depth behind that sentence. Autonomous agents
read issue bodies as input, so the estate rule that only I may create and label
issues on autonomous repos is a hard requirement, not advice.

The two executors (laptop `ticket-loop.sh`, VPS interlude) will drift unless the
shared contract stays thin and lives in the platform repo. The gate matcher is
the one piece of genuinely duplicated logic, which is why parity tests against
the bash semantics are called out explicitly rather than left implied. If drift
becomes a nuisance, the answer is to narrow the contract, not to merge the
executors.

Interlude is now both the platform under construction and a pilot workload for
its own automation. The pleasing part is that the loop's first job is improving
interlude's UI; the hazard is that merging its PRs restarts the machine running
the fleet. That is why restart recovery is a first-class requirement here rather
than a Phase 6 hardening item.

`MAX_BUDGET_USD` changes meaning slightly in this phase: today's $5 per-task
default becomes a $20 per-*attempt* default for autonomous runs. Interactive
tasks inherit the same default, which is a deliberate, and generous, change to
existing behaviour.
