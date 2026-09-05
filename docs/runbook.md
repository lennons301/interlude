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
  corroborates; issue #136: an answer you gave that never reached the agent),
  each with a link where one applies.
- **running** — each active run's ticket, attempt (n/3), turn, spend vs budget,
  and phase (implement ▸ review ▸ merge). A run the account's quota refused sits
  here too, labelled **paused** with when its window resets (issue #168) — it is
  deliberately *not* in **needs you**, because a quota window asks nothing of you:
  the sweep resumes it by itself once the clock runs out (issue #169), or earlier
  on another lane the moment one can serve it (issue #199) — confirming the day's
  real-money spend is how you make that happen for a run that is blocking the
  frontier. The paused card also carries **move to paid lane…** (issue #202),
  which does that move now, at your press, and tells you why not when it cannot.
  A run the tier ladder stepped down (issue #170) also sits here, working
  normally, with a line saying which tier it is running at and which it was
  asked for — the result came from a cheaper model than you chose, and that is
  worth knowing when you read it.
- **recent** — the last 7 days of completions.
- **tiers** — the last 7 days' tier routing (issue #198): coverage (how many
  attempts carried a declared tier, and how many ran on the default), then one
  row per tier the work ran at — attempts on how many tickets, attempts burned,
  review verdicts and spend. A restart's re-claim is the same attempt, not a
  second one. Routing work down that costs more than it saves
  shows here as attempts per ticket and failures beside the dollar figure. A run
  the ladder stepped down counts once, under the tier it ended on, and is noted
  as *stepped down*. The daily digest prints the same figures.
- **spend** — today's autonomous spend vs the $500/day cap.

Discord is **push-only**: it tells you *when to look* (claimed, blocked question,
sign-off needed, attempts exhausted, cap pause, slots saturated, a fleet-health
stall — owed review / wedged pickup / stale queue / phantom slot / an answer
that never got through — daily digest).
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
run (status `blocked`, its container stopped to free memory but preserved, and
**holding no slot**) and posts the question to the project's linked Discord
channel — or, if the project has none, to the fleet channel
(`DISCORD_FLEET_CHANNEL_ID`).

**Reply to that Discord message.** Your reply becomes the run's next turn (the
Phase 4 idle-and-reply plumbing carries it): the container restarts in ~1s and
the run continues on the same attempt, with its own conversation. If the project
has no Discord channel and no fleet channel is configured, the question still
appears on the task's chat page in the UI, where you can answer it.

A blocked run **survives a restart, and a deploy** (issues #136, #190): boot
re-adopts its parked container, so an answer given before or after the restart is
delivered on the next poll. The agent network is external to the compose stack,
so a deploy's `down`/`up` no longer recreates it underneath a parked container —
and a container whose network *was* recreated under it is reattached (aliases
intact) on its next start rather than failing forever. If the container did not survive (a host OOM, a manual `docker rm`),
the run is marked `interrupted` instead — the ticket is re-claimed without
consuming an attempt, and the question plus anything you had already said is
posted to the issue so the next attempt reads it. Either way, an answer left
undelivered for 10 minutes **by an idle session** raises an **answer stuck** card
and one Discord ping, so a stuck answer is never silent. A follow-up queued
behind a turn that is actually running is ordinary queueing and says nothing —
which is what you leave behind whenever you answer twice.

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
    at the bottom of the ladder, gets one more chance before the clock: the run
    **moves to another lane** if one is available and permitted (issue #176) —
    a fresh pass under the same run, on the same branch, continuing the same
    conversation where the transcript survived and the new lane runs the same
    harness adapter (a move across two adapters starts again on the branch and
    says so on the pass's feed, issue #217). The issue gets a comment naming
    the lane it moved to. Only with nowhere to go does it pause: the run goes
    `rate_limited` with a `resumeAfter` taken from the limit event's own reset
    time, and its container is torn down. The issue gets a comment saying so,
    and because a `rate_limited` run still holds its ticket, the sweep will not
    claim a fresh run over it.

    "Nowhere to go" is worth knowing precisely, because it is what you would be
    looking at on a paused run: every other lane is missing a credential, is
    below that pass kind's **minimum lane** (**Settings ▸ Execution lane**), is
    walled itself, or bills per token on a day whose real money is unconfirmed
    or capped. A lane move onto a paid lane is *allowed* for autonomous work but
    never exempt from those guards, so the most common reason a run pauses
    instead of moving is that nobody has confirmed the day's spend. A lane move
    counts against the same **resume bound** as a resume, so a run walks its
    lanes and then waits rather than thrashing.
  Either way the attempt and interruption counters stay where they were. An
  **account-wide** rejection whose event carried *no* reset time cannot pause —
  there is no clock to wait on — so it either moves lanes or takes its ordinary
  path and spends the attempt, as before. A tier-scoped one still steps down;
  a degrade waits on no clock either.
  An **interactive** session on either kind of wall does not pause or step down
  — it crosses onto a paid lane instead, because you are sitting there waiting;
  see *When the subscription window walls* below.
- **A paused run resumes itself** (issue #169). Once the window resets — plus up to
  five minutes of jitter, so a fleet-wide pause does not stampede — the ordinary
  30-second sweep queues the pass again in a fresh container on the same branch,
  ahead of any new claim when slots are scarce. **It also re-checks lanes on
  every sweep** (issue #199): while the window still stands, a paused run whose
  work another lane can serve *now* resumes there instead of waiting the clock
  out. So if a run is parked and you would rather pay than wait — a one-slot box
  with a dependency chain behind it is the shape this exists for — press
  **Confirm real-money spend** (or raise the cap, or lift the pass kind's minimum
  lane) and the run moves at the next tick, with an issue comment naming the lane
  and what it costs per million tokens. The same guards that hold a lane move
  hold this one: nothing moves onto an unconfirmed or capped lane, nothing moves
  onto a lane missing a credential, and the move counts against the resume bound
  below. Once the window *has* reset the run resumes on its own (free) lane as
  before, even if a paid one is on offer. Where the paused pass's session
  transcript was copied out before its container went, the resumed pass continues
  the *same conversation*; where it could not be, the pass starts again on the same
  branch with the work already pushed, and the issue comment says which happened.
  A move onto a lane running a *different harness adapter* never carries it
  (issue #217): the pass starts again on the branch, and its own feed says which
  two lanes and why — the cost is the conversation, never the attempt.
- **Move a parked run yourself** (issue #202). When the sweep would *not* move a
  parked run — the day's spend unconfirmed, most often — and that run is gating
  everything behind it, press **move to paid lane…** on its card under
  **running**. The card first asks the fleet what the move would be and puts it
  in front of you before anything is spent: the lane, what it costs per million
  tokens, and which continuation (n/bound) of the attempt it is. **Move now**
  makes it; the issue gets a comment saying the operator moved it, naming the
  lane and its cost exactly as the sweep's own move would. It answers to the
  same guards as any crossing: with the day's real money unconfirmed it is
  refused naming the press, and offers that press right there — **confirm
  real-money spend…** is the fleet's once-a-day confirmation, the same one as
  under **Settings ▸ Real money**, and the strip says what it authorises; the
  card then asks again and offers the move for a second press. (Once confirmed,
  the sweep would also move the run itself at its next tick.) At the cap it is
  refused naming the cap, and with nowhere to go it names why — each other
  lane's missing credential, the pass kind's minimum lane, a pin. It counts
  against the same resume bound, and a run with none left is refused rather
  than moved, because the sweep is about to hand its ticket to a human. And it
  is only for a wall that still stands: once the card reads *quota window has
  reset* the run is minutes from resuming free on its own lane, so a press is
  refused saying so rather than spending a continuation to be routed straight
  back there. Headless:

  ```bash
  curl -s https://interludes.co.uk/api/runs/<run-id>/lane-move            # what a press would do
  curl -s -X POST https://interludes.co.uk/api/runs/<run-id>/lane-move    # do it (409 + reason when refused)
  ```
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

**Review is derived, not chosen** (issue #201) — and it is the only pass that
is (issue #211). A review runs **one rung above the tier the run's implement
pass ran at** — `light` work gets a `standard` review, `standard` work gets
`heavy`, and `heavy` stays `heavy` — so a misclassified ticket is caught by its
gate rather than waved through by an equally weak reviewer. The Review row is
therefore a **ceiling** on that derivation rather than a fixed tier: set (from
the screen, or by a tier named in `AGENT_MODEL_REVIEW`, the row's *own*
variable), it caps the derivation there — set the review tier low as a cost
measure and a heavy ticket's review is capped at it, which is the accepted
trade; left unset, the derivation runs free. The base `AGENT_MODEL` standing in
for an unset `AGENT_MODEL_REVIEW` is what a review with nothing to derive from
falls back to, **not** a ceiling on the review — read as one it would cap every
review at the implement tier. A Review row pinning a raw model id rather than a
tier cannot bound one: the pin is run as pinned and nothing derives. A run
whose implement pass resolved no tier (a pinned id, or the harness default)
derives nothing, and its review resolves exactly as before. Triage and
interactive are never derived: triage is standalone and armed by a human, and
an interactive session has a human present who can ask for something else.

**Repair runs at the run's own tier** (issue #211). A repair pass — merging the
default branch into a conflicting PR, or making a red rollup green after `main`
moved under it — is the same attempt continuing, not work that was judged
wrong, so it is not stepped up: it runs at the tier the implement pass ran at,
and on a run that recorded none it reads the Implement row exactly as an
implement pass with no ticket tier does (a raw model id pinned in `AGENT_MODEL`
passes through). The Implement row is a chosen tier for both, and a ceiling on
nothing. The fix-up a review's request-changes verdict triggers is a follow-up
turn in the same implement container, never a repair pass, and its tier is
unchanged.

The screen only takes a tier: a raw model id is rejected with a message rather
than clamped, and a safety ceiling (the per-attempt budget maximum, the estate
daily cap, the attempt count) is refused by name — those stay in code and
environment.

**Per ticket**, a `model: <tier>` directive in a ticket's Workflow section
outranks the configured default for the implement pass — its repair runs at the
same tier, and, through the derivation above, it sets the rung the review
steps up from. Use it to
match spend to the work: a mechanical rename doesn't need the heavy tier; a
gnarly refactor can ask for it explicitly. The set is a fixed allowlist (issue
text is semi-trusted, so it may only select a tier, never name an arbitrary
model); an unrecognised value is ignored — the run keeps its configured default
and the claim comment notes that it was dropped. Review and triage passes keep
their own (cheaper) tier regardless. The honoured tier is recorded on the run.
Since issue #197 every published ticket is expected to name its tier, chosen
against the three-way rubric in the ticket contract in
`docs/agents/issue-tracker.md` — the contract binds the producer (`/to-tickets`,
a human, a generation session), not the executor: a ticket that arrives
without one still runs at triage's suggestion where there is one (next
paragraph), and otherwise at the configured default exactly as above.

**Raw issues get their tier from triage** (issue #200). The triage pass judges
every opened issue against that same rubric and returns the tier on a `TIER:`
line of its structured exit; the orchestrator stores it on the triage task and
the claim applies it — but only where the body states no `model:` directive. A
tier you write in the Workflow section always outranks the suggestion, and an
exit whose tier line is missing or mistyped keeps its verdict and simply
suggests nothing. Because the suggestion reaches the run without appearing in
the body, the recommendation embed in Discord and the assessment comment on
the issue both state the tier the run will use, so you see the routing
decision at the moment you arm the work (when neither named one, the embed
names the configured default and the comment says so without naming it); the
claim comment then records which of the two the run actually took. Triage still cannot arm, edit or close
anything — the tier is advice about the work, never authority over the
ticket, and there is no line it could write that names a lane.

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
- **What is never held.** In-flight runs and follow-up turns of a run. Both
  guards hold *new autonomous pickup* — a claim or a triage pass — which is the
  same thing the daily cap and the kill switch hold, plus an interactive
  session's own crossing (below).

Switching the primary lane between billing kinds takes effect at the next sweep,
with no restart: the guards read the lane and the settings row fresh every tick.

### Cost routing and the minimum lane (Settings → Execution lane)

Which lane a pass runs on is not a fixed setting: with no lane explicitly
chosen, each pass runs on the **cheapest lane that can serve it** (issue #176).
Three practical consequences:

- **While the subscription window is open, nothing changes.** Its quota is
  already bought, so it is cheaper than everything and wins every comparison.
  Cost routing only starts choosing when the window walls, when an overage
  starts charging the card, or when the primary lane bills per token anyway.
- **A minimum lane is a floor, not a choice.** Set one per pass kind on
  **Settings → Execution lane** (or deployment-wide with `AGENT_MIN_LANE`), and
  routing may pick anything *at or above* it. Naming a paid Anthropic-direct
  lane therefore reads as "first-party Claude only" for that kind, while
  leaving it unset lets triage and review run on the cheapest lane declared.
  Each row also reports the lane it would be routed onto right now and what
  that lane charges per million tokens, so a surprising choice is readable
  rather than guessable.
- **Pinning turns routing off.** Pick a primary lane on the settings screen (or
  set `AGENT_LANE`) and every pass runs there, however cheap another lane is.
  A **walled** pinned lane still fails over rather than waiting the window out:
  the pin is honoured right up to the point where the lane cannot serve the
  request at all, which is a different thing from one you would rather not use.
- **A minimum lane never excludes the lane you are on.** It bounds where
  routing may *send* a pass. So a floor the deployment's own lane cannot meet
  does not stop work — the pass runs there, and the settings row says which
  lane it would run on rather than claiming none.

Routing never spends money the fleet is not permitted: a paid lane is only a
candidate inside the day's real-money cap and its confirm-once press, judged
per lane against that lane's own declared cap. And it never routes around a
lane that is merely **unavailable** — a missing credential still fails the pass
naming the variable, rather than being papered over by spending at another
provider.

### When the subscription window walls (interactive overflow)

A walled subscription window used to stop autonomous work dead — the run parked
on the window's clock and resumed itself when it reset. It now **moves lanes
first** if one is available and permitted (above), and only pauses when none
is. An **interactive** session has always crossed rather than waited, because
you are sitting there waiting: it crosses onto the cheapest available metered
lane and carries on, under the guards above.

What you will see, on the session's own screen and in its transcript:

- **"Confirm real-money spend to continue"** — the day's first cash spend,
  asked for where you are rather than on the settings screen. One press and the
  session continues immediately; that press is the *fleet's* confirmation, so
  autonomous passes may also spend up to the cap for the rest of the day. The
  session stays queued until you press, and starts on the next poll (~2s).
- **"Capped: today's real-money limit of $X is spent"** — no press helps before
  midnight, so none is offered. Raise the cap in Settings → Real money, or
  carry on tomorrow. The session is not failed; it waits.
- **"...no paid lane to overflow onto"** — naming the variable that would fix
  it (`ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`). Set it in Doppler and the
  session starts on the next poll.

Two things follow from this that are easy to be surprised by:

- **An active overage is treated as a paid lane.** If the account has overage
  billing and the window walls, requests still succeed — on the card. So the
  fleet reads that as metered spend: it counts against the cash cap, it needs
  the same confirmation, and the dashboard's real-money gauge moves even though
  the lane in force still says `claude-subscription`. Without this rule an
  overage-enabled account would never show a `rejected` at all and the wall
  would silently become a bill. Overage merely being *available* (nothing
  drawing on it) changes nothing.
- **A metered primary asks too.** The confirmation is per day and per fleet,
  not per overflow, so on a metered-primary deployment the first interactive
  turn of the day is the one that asks. That is the point of a guard keyed to
  billing kind rather than to having overflowed.

A held session never holds the queue: the pickup loop steps over the whole
interactive kind while the guards refuse it, so review passes and resumes —
work already paid for — keep starting.

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
| `AGENT_LANE` | The deployment's default execution lane (an id from `lanes.yaml`). Unset, cost routing picks the cheapest lane that can serve each pass and the file's preference order only breaks ties; **set** (here or on the settings screen), it pins the fleet and turns cost routing off. |
| `AGENT_MIN_LANE` | The weakest lane cost routing may send any pass onto (an id from `lanes.yaml`) — a capability floor, so routing may still pick anything at or above it. Unset means no floor. The fall-through for the four Settings → Execution lane rows left on `environment`. |
| `AGENT_MODEL`, `AGENT_MODEL_REVIEW`, `AGENT_MODEL_TRIAGE` | Default model per pass kind, as a tier (`heavy`/`standard`/`light`, or the `opus`/`sonnet`/`haiku` aliases) or a raw model id. The fall-through for a Settings → Models row left on `environment`; unset means no `--model` and the CLI resolves the account default. `AGENT_MODEL` is the tier itself for implement, interactive and repair (a repair runs at the run's own tier, issue #211). For review (issue #201) a tier in `AGENT_MODEL_REVIEW` is a **ceiling** on the derived tier — one rung above the run's implement tier — not the tier itself; unset, the derivation runs free. |
| `CAPACITY_SLOTS`, `AGENT_MEMORY_MB` | Override derived capacity — only when the derivation is wrong. |
| `OWED_REVIEW_STALL_MINUTES`, `PICKUP_WEDGED_MINUTES`, `QUEUE_HEARTBEAT_STALE_MINUTES` | Fleet-health watchdog thresholds in minutes (issue #126). Defaults 30 / 3 / 2. |
| `QUOTA_PICKUP_THRESHOLD_PERCENT` | Quota utilization at or above which no new ticket is claimed (issue #171). One of 50/70/80/85/90/95/100; default 90. The fall-through for Settings → Quota when that row is left on `environment`. |
| `UNDELIVERED_ANSWER_MINUTES` | How long an answer you gave may sit undelivered before the fleet says so (issue #136). Default 10 — delivery is one 2s poll away, so this cannot fire on a healthy resume. It catches a parked session that is not resuming (memory admission deferring it repeatedly), which from your side looks exactly like an agent still thinking. |
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
- **I answered a blocked agent and nothing happened.** The dashboard says so
  itself after 10 minutes — an **answer stuck** card, plus one Discord ping
  (issue #136) — but only when the session is *idle*; if a turn is running, your
  answer is simply next in line. Boot restores the container handle (#136) and
  the network survives a deploy (#190), so the cause left is memory: a parked
  container is only resumed when the box has headroom. Check free memory.
  Repeating the answer does not help — the *oldest* undelivered message is the
  one delivered first.
- **A deploy went green but prod is on old code.** Fixed in #189, and worth
  knowing how to check: compare `git -C /opt/interlude rev-parse HEAD` with the
  pushed SHA, and the `interlude-app` image's `CreatedAt` with the deploy time.
  A cached rebuild of a stale checkout reproduces the *identical* image and
  passes every health check, so the job's own green is not evidence. The deploy
  now asserts the checked-out SHA against `github.sha` and fails instead.
- **A gated PR never merges.** That's by design — `human-signoff` means it waits
  for you. Merge it yourself.
