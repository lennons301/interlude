# Autonomy runbook

How to live with Interlude's autonomous ticket-loop (Phase 5). This is the
operator's guide — the handful of things the owner actually does once the loop
is on. It is deliberately short; the full design is in
[`docs/specs/2026-07-30-phase5-autonomous-ticket-loop-design.md`](specs/2026-07-30-phase5-autonomous-ticket-loop-design.md).

Autonomy is **additive**. Interactive chat + live preview (dispatch a task, watch
it, follow up) is unchanged and is never gated by anything in this document.

---

## The one rule

**Applying the `ready-for-agent` label is the launch button.** It means "an agent
may implement this and merge it unattended." **Only a human ever applies it.**

The orchestrator never applies `ready-for-agent` itself — not from triage, not
from anywhere. Triage can only *recommend* it (it applies advisory labels like
`needs-info` / `ready-for-human` and pings you); arming is your click. As defence
in depth, the loop also ignores an armed issue unless its author is the repo owner
or on the `AUTONOMY_ALLOWED_AUTHORS` allow-list. Priority is expressed purely by
*when* you arm work — oldest-armed-first, no priority field anywhere.

---

## Turning it on (pilot enablement)

Autonomy is off by default at two levels, and **both** must be on for pickup:

1. **Boot master** — `AUTONOMY_ENABLED` (env, from Doppler `interlude/prd`).
   False and no sweep ever starts; read once, so changing it means a restart.
2. **Per-project toggle** — `projects.autonomyEnabled` (off by default; enabled
   deliberately, per project, never in bulk). Arm and disarm it on `/settings`,
   where each project also shows its preflight verdict.

A project is only claimable when both are on, the runtime kill switch is lifted
(*Pause pickup* below), **and** its preflight passes.

### Preflight: is a repo safe to run unattended?

Before any of a repo's tickets can be claimed, its preflight must pass. Preflight
checks four things and, on failure, names exactly what is missing:

| Check | What it verifies | Fix if it fails |
| --- | --- | --- |
| GitHub App installed | the App installation can see the repo (clone/push + API) | install the Interlude GitHub App on the repo |
| Branch protection | the default branch has branch protection | add branch protection (also needs the App's *Administration: read* permission to verify) |
| Reviewer is a collaborator | the `REVIEWER_GH_TOKEN` machine account can review PRs | add the reviewer account as a collaborator (`scripts/setup-reviewer.sh` in the migration) |
| `human-signoff` label exists | gated PRs can be labelled for sign-off | `gh label create human-signoff -R <owner>/<repo>` |

The reducer **fails closed**: a repo whose preflight has never run, or is failing,
is as ineligible as one with autonomy off. Nothing is claimed until preflight
passes, so a half-configured repo can never be run against by accident. The
dashboard and the digest say so **per project**, not fleet-wide (issue #148):
the repo gets a *needs you* card naming what's missing and stating that none of
its tickets are being picked up, and if it has armed tickets waiting, its line in
the digest's Backlog reads `moontide: 3 — not picked up: preflight is failing`.
One repo failing preflight is not a held fleet, so it is never reported as one.

Preflight is recomputed (a) immediately when you enable autonomy on a project,
and (b) periodically (every few minutes) for enabled projects, so drift — e.g.
branch protection being removed — is caught without a manual step.

### Enable a project (deliberate, one at a time)

Find the project's id, then flip the toggle. Enabling runs preflight
synchronously and returns the result:

```bash
# List projects to get the id (ULID) and current preflight status
curl -s http://localhost:3000/api/projects | jq '.[] | {id, name, githubRepo, autonomyEnabled, preflightStatus, preflightReason}'

# Enable autonomy on one project — this runs preflight now
curl -s -X PATCH http://localhost:3000/api/projects/<id> \
  -H 'content-type: application/json' \
  -d '{"autonomyEnabled": true}' \
  | jq '{autonomyEnabled, preflightStatus, preflightReason}'
```

If the response shows `"preflightStatus": "failing"`, `preflightReason` names what
to fix. Fix it, then re-run the PATCH (or wait for the periodic refresh) until it
reads `"passing"`. A failing preflight on an enabled project also shows up in the
dashboard's **needs you** panel.

### Flip the global switch

Set `AUTONOMY_ENABLED=true` in Doppler `interlude/prd` and restart the
orchestrator (config is read once at boot). On boot you'll see
`[autonomy] Reconciliation sweep every 30s`; if it's off you'll see
`Autonomous pickup disabled (AUTONOMY_ENABLED != true)`.

That is the boot master. Check the runtime kill switch is lifted too — it is
durable, so one engaged before a restart is still engaged after it, and boot
says so: `Global kill switch engaged -- sweeps run, but nothing new is claimed`.
See *Pause pickup* below for how to lift it.

### Pilot repos and the first workload

The pilots are **interlude**, **lemons** and **last-person-standing**. Verify
preflight passes for all three before arming anything.

The **first autonomous workload is interlude's own UI-upgrade backlog** — the
shakedown bites the platform, not a real project. Arm those UI tickets one at a
time (they are natural `checkpoint:` candidates — see *Supervised runs* below).
lemons and last-person-standing are already on the ticket-loop and validate the
"existing ticket-loop repo, zero changes" path.

---

## The handful of things you do

### 1. Arm a ticket

Apply the **`ready-for-agent`** label to a fully-specified issue. That's it — see
*The one rule* above.

- **Fast path:** the `issues.labeled` webhook (`POST /api/webhooks/github`) kicks
  a sweep immediately.
- **Backbone:** a reconciliation sweep runs every 30s (and on boot) and lists
  open `ready-for-agent` issues per enabled project, so a missed webhook is at
  most 30s of latency.
- Claiming does **not** strip the label; the merge closes the issue via the PR's
  `Closes #n`. An issue with an open blocker (`Blocked by: #N` in the body, or a
  native GitHub dependency) is skipped until the blocker closes.

An armed ticket needs no further action from you unless the agent gets blocked,
the PR is gated, or all three attempts fail (you'll hear about each — below).

### 2. Watch the fleet

The **dashboard is the home page** (`/`). It streams live over SSE and shows:

- **slots** — total vs used, and what occupies each (autonomous / interactive).
- **needs you** — blocked questions, `human-signoff` PRs, exhausted tickets, a
  daily-cap pause, failing preflights, and the fleet-health watchdog's stall
  signals (issue #126: an owed review that never started, a wedged pickup, a
  stale queue heartbeat; issue #152: a slot count no real container
  corroborates), each with a link where one applies.
- **running** — each active run's ticket, attempt (n/3), turn, spend vs budget,
  and phase (implement ▸ review ▸ merge). A run the account's quota refused sits
  here too, labelled **paused** with when its window resets (issue #168) — it is
  deliberately *not* in **needs you**, because a quota window asks nothing of you:
  the sweep resumes it by itself once the clock runs out (issue #169).
  A run the tier ladder stepped down (issue #170) also sits here, working
  normally, with a line saying which tier it is running at and which it was
  asked for — the result came from a cheaper model than you chose, and that is
  worth knowing when you read it.
- **recent** — the last 7 days of completions.
- **spend** — today's autonomous spend vs the $500/day cap.

Discord is **push-only**: it tells you *when to look* (claimed, blocked question,
sign-off needed, attempts exhausted, cap pause, slots saturated, a fleet-health
stall — owed review / wedged pickup / stale queue / phantom slot — daily
digest).
Each stall pings once per occurrence, not every sweep. Autonomous success is
deliberately silent — it shows on the dashboard. There is no `!status` command;
the dashboard answers "what's happening".

### 3. Pause pickup

Pausing only stops autonomous **pickup**. In-flight runs finish, and interactive
chat/preview is never affected.

- **Globally, right now (kill switch):** press **stop the fleet** on `/settings`,
  or flip the durable runtime switch by hand — either way no restart, effective
  at the next sweep tick (≤30s).

  ```bash
  # Engage: nothing new is claimed anywhere (implement or triage)
  curl -s -X PATCH http://localhost:3000/api/settings/autonomy \
    -H 'content-type: application/json' -d '{"paused": true}'

  # Lift it again
  curl -s -X PATCH http://localhost:3000/api/settings/autonomy \
    -H 'content-type: application/json' -d '{"paused": false}'

  # Current state (plus `envMaster`, the AUTONOMY_ENABLED boot master)
  curl -s http://localhost:3000/api/settings/autonomy
  ```

  The flag lives in the `settings` table, so an engaged switch survives a
  restart.

  **Confirm it took** from the row itself, not from the log: the dashboard's
  live dot turns amber and reads `held` (`paused` covers every self-lifting or
  money hold — the daily cap, the quota gate, the real-money cap, and a metered
  lane whose day is unconfirmed — and `off` is the boot master: deliberately
  different words for deliberately different states, because none of them is
  lifted the same way), with a *Kill switch engaged* banner above the panels,
  and `GET /api/settings/autonomy` answers
  the same row headless. The sweep's `Pickup paused (kill-switch)` line
  is **not** the confirmation: the hold is evaluated only on a tick that found
  an eligible ticket it would otherwise have claimed, so engaging the switch
  over an empty queue logs nothing at all — and if the daily cap is breached
  too, that gate returns first and logs `Pickup paused (daily-cap)` instead.
  (Logging it every tick regardless would mean a line every 30s for as long as
  the fleet is held.) The next
  morning's Discord digest leads with the hold too, so a fleet you held and
  forgot never reads there as a quiet day.
- **Automatically, when quota runs out (quota gate):** nothing to press. Above
  the **Settings → Quota** threshold (default 90% of the account's quota
  window), or once the account is already being *rejected*, the fleet stops
  claiming new tickets and starting triage passes — it will not start work it
  cannot finish. In-flight runs, parked runs resuming, and interactive chat are
  all unaffected.

  The dot reads `paused` with a banner naming both numbers (what the window is
  at, and the threshold it crossed), and Discord gets **one** ping per closed
  spell — fleet-level, saying how many armed tickets are being held, never one
  per run. It re-arms only when the gate opens again.

  The gate **lifts itself**: an observation stops holding pickup once its stated
  reset has passed (or, for one that reported no reset, once it is more than
  five hours old). That expiry is load-bearing, not tidiness — only a pass
  making an API call produces a fresh quota observation, so a gate held forever
  by a stale rejection would suppress the very traffic that would lift it. When
  the window reopens the fleet claims one ticket, observes the quota again, and
  re-closes the gate within seconds if the wall is still there.

  A fleet on API-key auth is **never** gated: the unified-window telemetry is
  subscription-only, so such an install reports no quota at all, and silence it
  cannot break must not read as a wall.

  Raise or lower the threshold in **Settings → Quota** (100 = only ever gate on
  an outright rejection), or set `QUOTA_PICKUP_THRESHOLD_PERCENT`. There is
  deliberately **no headroom reserved** for your own Claude Code sessions: the
  fleet and you draw on one pool and the fleet takes what it takes.
- **Globally, hard off (boot master):** set `AUTONOMY_ENABLED=false` in Doppler
  `interlude/prd` and restart. Sweeps never start at all. Use this to stand the
  fleet down for a while; use the kill switch to stop it now.

  The dashboard's dot reads `off` with a banner naming `AUTONOMY_ENABLED`, and
  the digest leads with it (issue #148) — neither offers the kill switch as the
  remedy, because lifting it under a boot master that's off changes nothing.
  It outranks both runtime holds on those surfaces for the same reason: it is
  the one you have to act on first. Turning it back on takes a config change
  and a restart.
- **Per project:** press **disarm** on the project's card in `/settings`, or
  disable the toggle by hand —

  ```bash
  curl -s -X PATCH http://localhost:3000/api/projects/<id> \
    -H 'content-type: application/json' -d '{"autonomyEnabled": false}'
  ```

  Other projects keep running. The sweep logs `Pickup paused (autonomy-off-project)`
  for that repo.

### 4. Answer a blocked agent from Discord

When an agent hits a decision the ticket doesn't settle, it emits
`BLOCKED: <question>` on its own line (a short lead-in above it is fine — the
detector scans every line, not just the first). The orchestrator parks the
run (status `blocked`, container kept alive but **holding no slot**) and posts the
question to the project's linked Discord channel — or, if the project has none, to
the fleet channel (`DISCORD_FLEET_CHANNEL_ID`).

**Reply to that Discord message.** Your reply becomes the run's next turn (the
Phase 4 idle-and-reply plumbing carries it): the run un-parks and continues. If
the project has no Discord channel and no fleet channel is configured, the
question still appears on the task's chat page in the UI, where you can answer it.

### 5. Find PRs waiting for sign-off

A PR gets the **`human-signoff`** label (and auto-merge is left disarmed) when it
touches a gated path, when the ticket carried a `checkpoint:` directive, or when
the reviewer escalated. It then waits for you.

- **Dashboard:** the *needs you* panel's sign-off items link straight to each PR.
- **From the CLI:** `gh pr list --label human-signoff --state open -R <owner>/<repo>`
  (or search `is:pr is:open label:human-signoff`).

Review it and merge (or push changes) yourself. What trips a gate for this repo is
in [`docs/agents/review-gates.yaml`](agents/review-gates.yaml) (additive on top of
the estate defaults): infrastructure, the agent sandbox, credentials, the DB
schema/migrations, and the autonomy control surface itself.

### 6. Cancel a run to free a slot

To reclaim a slot from a running task:

- **API:** `POST /api/tasks/<taskId>/cancel` (only accepts a task in `running`).
- **Discord:** reply `cancel` to the task's message (the bot reacts 🛑).

Cancelling stops and removes the container and frees the slot on the next poll.
An owner-cancelled run does **not** consume one of the ticket's three attempts.
(A *blocked* run is parked and holds no slot, so it isn't occupying capacity —
answer it, or leave it; it doesn't need cancelling to free a slot.)

---

## Reference

### Budgets, attempts, caps

- **$20** per attempt (default). A ticket's `budget:` directive can raise a single
  attempt to at most **$75**; issue text can't exceed that ceiling.
- Review passes carry their own **~$5**; triage a small allowance with a low turn cap.
- **3 attempts**, then the loop swaps `ready-for-agent` for **`ready-for-human`**,
  comments a summary and pings Discord.
- **Interruptions don't count as attempts.** A run lost to an orchestrator restart
  *or* to a container that died before finishing (OOM / exit 137 / docker error, i.e.
  no terminal agent result) is marked `interrupted`, not `failed`: the sweep re-claims
  the ticket without consuming an attempt. Re-claims are still bounded
  (`MAX_INTERRUPTIONS_PER_TICKET`, 5), so a ticket that reliably kills its container
  eventually routes to `ready-for-human` like an exhausted one. A review pass that
  dies the same way re-queues a fresh replacement instead of burning its one
  format-retry.
- **A quota wall is neither an attempt nor an interruption** (issues #168, #170).
  What a refusal costs depends on *which window* refused it, which the limit
  event names:
  - A **tier-scoped** window (`seven_day_opus`, `seven_day_sonnet`) means the
    account still has quota, just not for that tier. The run steps down the
    ladder `heavy → standard → light` and retries in place: a fresh pass is
    queued under the same run, the new tier is recorded on `runs.model`, and the
    tier it was asked for on `runs.degraded_from`. Nothing to do — the issue
    gets a comment saying which tier it dropped to. The retry continues the
    attempt's *budget* rather than being handed a fresh one, so a degrade costs
    no more money than the attempt was already allowed. A run can step down at
    most twice before it is at the bottom, and the step is **one-way**: nothing
    puts the tier back, so the rest of that run stays a rung down even after the
    window resets. A *later* attempt at the same ticket is a fresh run and
    starts at the configured tier again.
  - An **account-wide** window (`five_hour`, `seven_day`, `overage`), or a wall
    at the bottom of the ladder, pauses instead: the run goes `rate_limited`
    with a `resumeAfter` taken from the limit event's own reset time, and its
    container is torn down. The issue gets a comment saying so, and because a
    `rate_limited` run still holds its ticket, the sweep will not claim a fresh
    run over it.
  Either way both counters stay where they were. An **account-wide** rejection
  whose event carried *no* reset time is not paused at all: with no clock to wait
  on, the pass takes its ordinary path and spends the attempt, as before. A
  tier-scoped one still steps down — a degrade waits on no clock.
- **A paused run resumes itself** (issue #169). Once the window resets — plus up to
  five minutes of jitter, so a fleet-wide pause does not stampede — the ordinary
  30-second sweep queues the pass again in a fresh container on the same branch,
  ahead of any new claim when slots are scarce. Where the paused pass's session
  transcript was copied out before its container went, the resumed pass continues
  the *same conversation*; where it could not be, the pass starts again on the same
  branch with the work already pushed, and the issue comment says which happened.
  Nothing to do either way — but two things worth knowing:
    - the resume is **not** held by the kill switch, the daily cap or the quota
      admission gate. All three gate *pickup*, and a paused run is the middle of
      an attempt already started. To stop one, cancel the run (below);
    - one attempt gets **3 resumes** by default (`MAX_RESUMES_PER_ATTEMPT`,
      settable under **Settings ▸ Quota** without a restart; `0` sends a quota pause
      straight to a human). Past the bound the ticket is labelled
      `ready-for-human` — and because the pauses spent no attempts, re-arming it
      once there is quota picks the work back up with the attempts it never used.
- **$500/day** estate-wide autonomous cap pauses pickup (announced once, shown on
  the dashboard, resets at local midnight). Interactive work is exempt by
  construction (it has no run).
- **Real money is capped separately** — see *Spending real money* below. The
  $500 cap measures quota-funded autonomous work; the cash cap measures a card
  being charged, so it applies whenever the lane in force bills per token and it
  counts interactive work too.

### Pushing to a PR the loop has already reviewed

If you click *Update branch*, push a commit, or merge `main` into an agent PR
after its review was posted, the loop notices the head moved past the commit it
reviewed and treats the verdict as void:

- auto-merge is disarmed first, so nothing lands on a head nobody read;
- the reviewer account's own approval is **dismissed** (a standing approval keeps
  counting for branch protection, and it is the artefact you read before merging);
- gate evaluation and one fresh review pass re-run against the new head, and the
  issue records the old and new SHAs.

That costs one of the attempt's review cycles. If none are left, the PR is
labelled `human-signoff` and pinged to Discord instead: review and merge it
yourself. A red rollup on the new head is repaired first, so the re-review never
runs against a branch that doesn't build.

**If the dismissal is refused**, the loop stops there and hands the PR over
rather than re-arming over a review GitHub still counts — the issue comment says
so. GitHub only lets an administrator, or an account on the branch's dismissal
allow-list, dismiss a review on a protected branch, so the reviewer account needs
one of those. The alternative is to turn on *Dismiss stale pull request approvals
when new commits are pushed* on the protected branch: GitHub then withdraws the
approval itself on every push, and the loop finds nothing left to dismiss.

### Supervised runs (`checkpoint:`)

A `checkpoint: <text>` directive in a ticket's Workflow section runs the implement
pass normally but then forces `human-signoff` regardless of gate matches, carrying
`<text>` as the note for what needs your decision. Use it for
agent-doable-but-risky work you want to eyeball before merge.

### Model tier (`model:`, and the Models settings section)

Model choice is a **tier** — `heavy`, `standard` or `light` — not a vendor model
id, so the choice survives a change of provider. The old names still work as
aliases: `opus` = heavy, `sonnet` = standard, `haiku` = light.

**Settings → Quota** holds the quota admission threshold (issue #171) on the
same layer: an unset row follows `QUOTA_PICKUP_THRESHOLD_PERCENT`, a set one
wins, a value outside the offered set is refused with the list rather than
clamped, and the change takes effect at the next sweep with no restart. See
*Pause pickup → the quota gate* above for what the threshold actually does.

**The standing default** for each kind of pass — implement, review, triage,
interactive — is set in **Settings → Models**. Each row shows the tier in force,
whether that came from the UI or from the environment, and which variable it
falls back to; picking `environment` clears the override. A change is written to
the durable settings row and read fresh when the next pass starts, so it takes
effect at the next sweep with **no restart** and survives one. An unset row
follows the environment exactly as before the screen existed
(`AGENT_MODEL`, with `AGENT_MODEL_REVIEW` / `AGENT_MODEL_TRIAGE` for the
read-heavy passes). A run already in flight keeps the tier it recorded.

The screen only takes a tier: a raw model id is rejected with a message rather
than clamped, and a safety ceiling (the per-attempt budget maximum, the estate
daily cap, the attempt count) is refused by name — those stay in code and
environment.

**Per ticket**, a `model: <tier>` directive in a ticket's Workflow section
outranks the configured default for the implement (and repair) pass. Use it to
match spend to the work: a mechanical rename doesn't need the heavy tier; a
gnarly refactor can ask for it explicitly. The set is a fixed allowlist (issue
text is semi-trusted, so it may only select a tier, never name an arbitrary
model); an unrecognised value is ignored — the run keeps its configured default
and the claim comment notes that it was dropped. Review and triage passes keep
their own (cheaper) tier regardless. The honoured tier is recorded on the run.

### Spending real money (metered lanes)

An execution lane declares who pays. `claude-subscription` draws on the plan;
`anthropic-api` and `openrouter` bill per token — real money. Everything below
applies whenever the lane **in force** is metered, whether you made it primary,
it was reached as overflow, or it was failed over to. Autonomous work on a
metered lane is allowed on purpose: it is bounded, not forbidden.

**Settings → Real money** is the control room for it, and it says the same
things the dashboard does:

- **Confirm once a day.** The first cash spend of each local day is held until
  you confirm, at fleet level — nobody is at the keyboard when an autonomous
  pass crosses into billing. After one press the fleet runs unattended for the
  rest of the day. The confirmation lapses on its own at local midnight, and
  survives a restart. Withdrawing it is one press.
- **The cash cap.** `METERED_DAILY_CAP_USD` ($20 by default), overridable on
  that screen up to a hard **$100** code ceiling — and bound down further by
  whatever the lane itself declares in `lanes.yaml` (`caps.daily_budget_usd`).
  The lower of the two always wins, and the panel says which one is binding.
  Reaching it pauses autonomous pickup until local midnight, exactly like the
  $500 cap, with one Discord announcement.
- **What counts.** Every dollar spent on a metered lane today — implement,
  review, repair, triage *and* interactive. A chat session on a metered lane
  charges the same card an implement pass does, so it counts; the $500
  autonomous cap's "interactive is exempt" rule deliberately does not apply
  here. Each turn's cost is booked to the day it landed on, so a session left
  open across days is split across them rather than heaped onto one. The two
  figures overlap and are shown separately (the dashboard's second gauge, the
  digest's second Spend line); never add them.
- **What is never held.** In-flight runs, follow-up turns and interactive
  sessions. Both guards hold *new autonomous pickup* only — a claim or a triage
  pass — which is the same thing the daily cap and the kill switch hold.

Switching the primary lane between billing kinds takes effect at the next sweep,
with no restart: the guards read the lane and the settings row fresh every tick.

### Reasoning effort (`effort:`)

`AGENT_EFFORT` pins the CLI's reasoning depth (the `--effort` flag) for the
implement/repair/interactive passes, the other half of the cost/quality dial
alongside `AGENT_MODEL`; `AGENT_EFFORT_REVIEW` / `AGENT_EFFORT_TRIAGE` give the
read-heavy passes a lower level. Valid levels: `low`, `medium`, `high`, `xhigh`,
`max`. Leave them unset and the CLI keeps its own default (no `--effort`).

A ticket's `effort: <level>` directive in the Workflow section raises (or lowers)
a single run's work-pass effort — a hard ticket can ask for `max`, a trivial one
for `low`. It is clamped to the levels above (an unrecognised value is ignored
and noted on the issue, never fatal) and changes only the depth the ticket's
*work* runs at — the reviewer's effort is unaffected. The honoured level is
recorded on the run row so spend reads against the depth it was earned at.

### Capacity / slots

Slots derive at boot from the Docker daemon's CPU and memory
(`floor((memTotal − reserve) / perAgentMB)`, capped by CPU, min 1). A CX22 (4 GB,
2 vCPU) yields **2**. A VPS resize is picked up on restart with no config change.
Override with `CAPACITY_SLOTS`; per-agent memory with `AGENT_MEMORY_MB` (default
1200 MiB, also the slot divisor). Every container has hard memory/CPU limits.

### Key environment variables (Doppler `interlude/prd`)

| Var | Meaning |
| --- | --- |
| `AUTONOMY_ENABLED` | Boot master for autonomy. Must equal `true` or sweeps never start. Read once at boot — restart to change. The runtime kill switch (`PATCH /api/settings/autonomy`) pauses pickup on top of it, with no restart. |
| `AUTONOMY_ALLOWED_AUTHORS` | Extra logins (comma-separated) allowed to author claimable issues. The repo owner is always allowed. |
| `REVIEWER_GH_TOKEN` | Reviewer machine account PAT. Orchestrator-only — **never** enters a container. Canonical home is `platform/prd`, mirrored into `interlude/prd`; rotation updates both. |
| `DISCORD_FLEET_CHANNEL_ID` | Channel for fleet events + fallback for blocked questions when a project has no linked channel. |
| `MAX_BUDGET_USD` | Per-attempt default budget ($20). |
| `METERED_DAILY_CAP_USD` | Real money the fleet may spend in one local day through a metered lane ($20). Overridable in Settings → Real money up to a hard $100 ceiling, and bound down by the lane's own declared cap. Subscription work never counts against it. |
| `AGENT_LANE` | The deployment's default execution lane (an id from `lanes.yaml`). Unset, the file's own preference order decides; a lane picked on the settings screen outranks both. |
| `AGENT_MODEL`, `AGENT_MODEL_REVIEW`, `AGENT_MODEL_TRIAGE` | Default model per pass kind, as a tier (`heavy`/`standard`/`light`, or the `opus`/`sonnet`/`haiku` aliases) or a raw model id. The fall-through for a Settings → Models row left on `environment`; unset means no `--model` and the CLI resolves the account default. |
| `CAPACITY_SLOTS`, `AGENT_MEMORY_MB` | Override derived capacity — only when the derivation is wrong. |
| `OWED_REVIEW_STALL_MINUTES`, `PICKUP_WEDGED_MINUTES`, `QUEUE_HEARTBEAT_STALE_MINUTES` | Fleet-health watchdog thresholds in minutes (issue #126). Defaults 30 / 3 / 2. |
| `QUOTA_PICKUP_THRESHOLD_PERCENT` | Quota utilization at or above which no new ticket is claimed (issue #171). One of 50/70/80/85/90/95/100; default 90. The fall-through for Settings → Quota when that row is left on `environment`. |
| `OCCUPANCY_DIVERGED_MINUTES` | How long occupancy may go uncorroborated by real agent containers before it reads as a phantom slot (issue #152). Default 20 — far longer than the pickup debounce because a task provisioning its container is legitimately uncorroborated until the container exists, and a cold agent-image build happens inside that window. The card's remedy is a restart, so a false positive is expensive. |

### Labels

`ready-for-agent` (arm — human only) · `ready-for-human` (needs a human /
attempts exhausted) · `needs-triage` (triage queue) · `needs-info` · `wontfix` ·
`human-signoff` (PR gated, awaits sign-off) · `interlude` (interactive-task
trigger) · `workflow:<skill>` (per-ticket workflow selector).

---

## When something's off

- **Nothing is being claimed.** Read the dashboard first: since issue #148 it
  names every hold it can see — the dot and banner for the fleet-wide ones
  (`off` = boot master, `held` = kill switch, `paused` = daily cap), a *needs
  you* card per project for preflight. If it says nothing, check the rest in
  order: `AUTONOMY_ENABLED=true` and the orchestrator restarted; the project's
  `autonomyEnabled` is true; its `preflightStatus` is `passing` (a
  failing/never-run preflight blocks pickup — read `preflightReason`); the issue
  has `ready-for-agent`, no open blocker, no active run, and an allow-listed
  author; the daily cap isn't paused; a slot is free.
- **Preflight won't pass.** Read `preflightReason` — it names the missing piece.
  "no branch protection" can also mean the App lacks *Administration: read*; "not a
  collaborator" can mean `REVIEWER_GH_TOKEN` is unset or its account isn't on the repo.
- **A gated PR never merges.** That's by design — `human-signoff` means it waits
  for you. Merge it yourself.
