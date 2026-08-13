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

1. **Global kill switch** — `AUTONOMY_ENABLED` (env, from Doppler `interlude/prd`).
2. **Per-project toggle** — `projects.autonomyEnabled` (off by default; enabled
   deliberately, per project, never in bulk).

A project is only claimable when both are on **and** its preflight passes.

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
passes, so a half-configured repo can never be run against by accident.

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
  stale queue heartbeat), each with a link where one applies.
- **running** — each active run's ticket, attempt (n/3), turn, spend vs budget,
  and phase (implement ▸ review ▸ merge).
- **recent** — the last 7 days of completions.
- **spend** — today's autonomous spend vs the $500/day cap.

Discord is **push-only**: it tells you *when to look* (claimed, blocked question,
sign-off needed, attempts exhausted, cap pause, slots saturated, a fleet-health
stall — owed review / wedged pickup / stale queue, issue #126 — daily digest).
Each stall pings once per occurrence, not every sweep. Autonomous success is
deliberately silent — it shows on the dashboard. There is no `!status` command;
the dashboard answers "what's happening".

### 3. Pause pickup

Pausing only stops autonomous **pickup**. In-flight runs finish, and interactive
chat/preview is never affected.

- **Globally (kill switch):** set `AUTONOMY_ENABLED=false` in Doppler
  `interlude/prd` and restart. The sweep stops; no new claims anywhere.
- **Per project:** disable the toggle —

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
- **$500/day** estate-wide autonomous cap pauses pickup (announced once, shown on
  the dashboard, resets at local midnight). Interactive work is exempt by
  construction (it has no run).

### Pushing to a PR the loop has already reviewed

If you click *Update branch*, push a commit, or merge `main` into an agent PR
after its review was posted, the loop notices the head moved past the commit it
reviewed and treats the verdict as void:

- auto-merge is disarmed first, so nothing lands on a head nobody read;
- the reviewer account's own approval is **dismissed** (a standing approval keeps
  counting for branch protection, and it is the artefact you read before merging);
- gate evaluation and one fresh review pass re-run against the new head, and the
  issue records the old and new SHAs.

That costs one of the attempt's review cycles. If none are left — or the stale
review can't be withdrawn — the PR is labelled `human-signoff` and pinged to
Discord instead: review and merge it yourself. Red checks are repaired before any
of this, so a re-review never runs against a branch that doesn't build.

### Supervised runs (`checkpoint:`)

A `checkpoint: <text>` directive in a ticket's Workflow section runs the implement
pass normally but then forces `human-signoff` regardless of gate matches, carrying
`<text>` as the note for what needs your decision. Use it for
agent-doable-but-risky work you want to eyeball before merge.

### Model tier (`model:`)

A `model: <alias>` directive in a ticket's Workflow section picks the tier the
implement (and repair) pass runs on — `opus`, `sonnet` or `haiku`. Use it to
match spend to the work: a mechanical rename doesn't need Opus; a gnarly
refactor can ask for it explicitly. The set is a fixed allowlist (issue text is
semi-trusted, so it may only select a tier, never name an arbitrary model); an
unrecognised value is ignored — the run keeps its default model and the claim
comment notes that it was dropped. Review and triage passes keep their own
(cheaper) tier regardless. The chosen tier is recorded on the run.

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
| `AUTONOMY_ENABLED` | Global kill switch. Must equal `true`. Read once at boot — restart to change. |
| `AUTONOMY_ALLOWED_AUTHORS` | Extra logins (comma-separated) allowed to author claimable issues. The repo owner is always allowed. |
| `REVIEWER_GH_TOKEN` | Reviewer machine account PAT. Orchestrator-only — **never** enters a container. Canonical home is `platform/prd`, mirrored into `interlude/prd`; rotation updates both. |
| `DISCORD_FLEET_CHANNEL_ID` | Channel for fleet events + fallback for blocked questions when a project has no linked channel. |
| `MAX_BUDGET_USD` | Per-attempt default budget ($20). |
| `CAPACITY_SLOTS`, `AGENT_MEMORY_MB` | Override derived capacity — only when the derivation is wrong. |
| `OWED_REVIEW_STALL_MINUTES`, `PICKUP_WEDGED_MINUTES`, `QUEUE_HEARTBEAT_STALE_MINUTES` | Fleet-health watchdog thresholds in minutes (issue #126). Defaults 30 / 3 / 2. |

### Labels

`ready-for-agent` (arm — human only) · `ready-for-human` (needs a human /
attempts exhausted) · `needs-triage` (triage queue) · `needs-info` · `wontfix` ·
`human-signoff` (PR gated, awaits sign-off) · `interlude` (interactive-task
trigger) · `workflow:<skill>` (per-ticket workflow selector).

---

## When something's off

- **Nothing is being claimed.** Check, in order: `AUTONOMY_ENABLED=true` and the
  orchestrator restarted; the project's `autonomyEnabled` is true; its
  `preflightStatus` is `passing` (a failing/never-run preflight blocks pickup —
  read `preflightReason`); the issue has `ready-for-agent`, no open blocker, no
  active run, and an allow-listed author; the daily cap isn't paused; a slot is free.
- **Preflight won't pass.** Read `preflightReason` — it names the missing piece.
  "no branch protection" can also mean the App lacks *Administration: read*; "not a
  collaborator" can mean `REVIEWER_GH_TOKEN` is unset or its account isn't on the repo.
- **A gated PR never merges.** That's by design — `human-signoff` means it waits
  for you. Merge it yourself.
