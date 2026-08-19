# LPS autonomous demo — 20 minutes

One claim: **define a block of well-scoped work, arm it, and trust it to run to completion.**
Two tickets in one milestone on `lennons301/last-person-standing` — one merges itself, one
stops and waits for a human — plus a triage issue armed from Discord.

LPS because autonomy is already on and preflight passes, its `main` requires 1 approving
review **and** four green checks (so auto-merge visibly waits on real CI), and its repo gate
file is empty so only the estate defaults apply. No Doppler token needed: no required check
uses a secret, and the unit suite runs with zero env and no DB.

---

## 0. Status — everything below is already created

Milestone [**Demo: pot breakdown**](https://github.com/lennons301/last-person-standing/milestone/4):

| | Issue | State |
| --- | --- | --- |
| **A** — merges itself | [#213](https://github.com/lennons301/last-person-standing/issues/213) | `enhancement`, **not yet armed** |
| **B** — waits for a human | [#214](https://github.com/lennons301/last-person-standing/issues/214) | `enhancement`, carries `Blocked by: #213`, **not yet armed** |
| **C** — triage demo | [#215](https://github.com/lennons301/last-person-standing/issues/215) | `needs-triage` — the triage pass will pick it up |

`needs-triage` was cleared from A and B on creation so no triage pass wastes the single slot
on tickets that are already specified. C keeps it, because that's the point of C.

**The one thing left to do: apply `ready-for-agent` to #213.** That's the launch button, and
by design only a human ever presses it — so it's yours to click, not mine. Do it now: the
ledger says an unattended ticket takes 5–57 minutes, and #214 stays deliberately unarmed so
you have something to arm on camera.

---

## 1. The tickets

Both authored as `lennons301` (the loop skips other authors), with no `workflow:` label —
only `workflow:tdd` is vendored, and any other `workflow:*` label throws and burns an attempt
before a container starts.

### Ticket A — merges itself (#213)

**Pot breakdown carries a refunded total**

```markdown
`calculatePot` (`src/lib/game-logic/prizes.ts`) totals `paid` and `claimed` rows and ignores
`refunded` ones, so admin-removed-player money is invisible. Add it to the breakdown so the
UI can show it (#214 renders it).

- Add `refunded: string` to `PotBreakdown` and total `status === 'refunded'` rows into it.
- `total` keeps its current meaning (confirmed + pending). Refunded money is reported, not
  added back.
- Extend `src/lib/game-logic/prizes.test.ts` to cover it, including the all-refunded and
  no-payments cases.

## Workflow
- Verify with the exact commands CI runs: `pnpm exec biome check .`,
  `pnpm exec tsc --noEmit`, `pnpm exec vitest run`.
- Do **not** use `pnpm lint` — it is `biome check --write .`, which auto-fixes and passes
  locally while CI's `biome check .` fails. There is no `pnpm test` script.
- The smoke suite (`scripts/smoke/**`) needs Postgres and is out of scope here.
```

Auto-merges because it touches only `src/lib/game-logic/**`, which matches no gate glob.
Safe: `PotBreakdown` is only ever consumed as a type, never built as a literal, so adding a
field breaks no consumer.

### Ticket B — waits for a human (#214)

**Show refunded money on the game pot breakdown**

```markdown
Blocked by: #213

Surface the new `refunded` figure from `PotBreakdown` on the game detail pot breakdown in
`src/components/game/game-detail-view.tsx`, alongside confirmed and pending. Omit the line
entirely when it is `0.00`.
```

`src/components/**` hits the estate's `visual-ui` gate → `human-signoff`, auto-merge left
disarmed. `Blocked by:` must be its own line — prose mentions and headings don't count. The
dependency is real: the field doesn't exist until A lands.

### Ticket C — the triage issue (#215)

Deliberately vague:

> **Pot totals should be easier to read on mobile** — The pot numbers are cramped on my
> phone. Would be good if they were clearer.

---

## 2. Timing: arm #213 now

The ledger says a fully unattended ticket takes **5–57 minutes** (median 42, one outlier at
6 hours). So **arm #213 now** — 40+ minutes before you start — and keep
**#214 unarmed** so you can arm it on camera.

At demo time you'll be in one of two states, and both work:

- **A still running** → you show it live, arm B on camera, B is visibly *skipped* while A is
  open, then A merges and B is claimed. The full story.
- **A already merged** → you open with the completed audit trail, arm B on camera, and B is
  claimed within 30 s. You lose the live "skipped" moment but keep everything else.

Ticket C is already open, so its triage pass runs before the slot is busy — there
is only one slot, so triage would otherwise queue behind the implement pass.

---

## 3. Run flow

| Beat | On screen |
| --- | --- |
| **Frame it** | The tracker is the queue; a human applies the launch button; everything after that is deterministic. |
| **The block of work** | The milestone. Read #213. Read #214, point at `Blocked by: #213`. Predict out loud: *A merges itself, B stops and waits for me, and B doesn't start until A closes.* |
| **Arm B** | Apply `ready-for-agent` on camera. If A is still open, B is now armed and **ineligible** — skipped, not queued behind. |
| **Dashboard** (`/`) | The slot holds `LPS #213`, chip `afk`, phase strip `implement ▸ review ▸ merge`, attempt pips `●●○`, turns, elapsed, spend vs the $20 attempt budget, today's spend vs the $500 cap. Needs-you: *"Nothing needs you."* |
| **Drill-down** | `/tasks/<id>` — tool calls streaming, colour-coded diffs, branch `agent/issue-213`, issue + PR links appearing live as the draft PR opens on the first push. |
| **← talk track here** | §4, for as long as A takes. This is the filler; it's meant to absorb the wait. |
| **Gate + merge** | A's PR: *"matched no gates — auto-merge (squash) armed."* Review pass posts an approving review as **`lennons301-reviewer`** — a different account. Four checks green. GitHub squash-merges. Issue closes via `Closes #213`. Scroll the PR: that's the audit trail. |
| **Dependency releases** | A closed → next sweep claims B. Same dashboard, **no human action**. This is the beat that proves "a block of work", not "a task". |
| **Triage → Discord** | Ticket C: `needs-triage` by webhook, the triage pass's `recommend` comment, the embed in Discord. Reply exactly **`yes`** → ✅, an audit comment naming the Discord route, `ready-for-agent` applied, claimed next sweep. |
| **The human gate** | B's PR: `human-signoff`, auto-merge disarmed, `visual-ui` named in the comment, amber **needs you** card with a link. Merge it yourself — the loop handed you exactly one decision. |
| **Close** | `/settings`: press the kill switch, watch pickup pause, lift it. Then the numbers (§5). |

If B is still going at the end, its `human-signoff` card makes the point without waiting for
the PR.

---

## 4. Talk track

### a) How an available issue gets detected

- A **GitHub App** is installed on the repo. Applying `ready-for-agent` fires an
  `issues.labeled` webhook to `POST /api/webhooks/github` (HMAC-verified), which kicks a
  sweep immediately.
- The backbone isn't the webhook, though — a **reconciliation sweep runs every 30 seconds**
  and lists open `ready-for-agent` issues per registered project. **The label is the queue.**
  There's no separate queue to drift out of sync, and a dropped webhook costs at most 30 s.
- Each candidate then passes an eligibility filter: project registered and armed, preflight
  passing, no run already active on it, attempts remaining, author allow-listed, and **no
  open blocker** — a `Blocked by: #N` line or a native GitHub dependency.
- Order is **oldest-armed-first**, globally across projects. Priority is expressed purely by
  when you arm something; there's no priority field anywhere.

### b) What a ticket goes through

1. **Claim** — a `runs` row is opened (one row per *attempt*), a comment goes on the issue,
   and a container starts on branch `agent/issue-<n>`.
2. **Implement pass** — the agent works the ticket. A draft PR opens on the first branch
   push, so you can watch it land commit by commit, and it's marked ready when the pass ends.
3. **Self-review inside the pass** — the agent has to satisfy its own verification (lint,
   typecheck, tests) before it finishes. That's the first gate, and it's the agent's own.
4. **Gate evaluation** — deterministic, on the PR's changed paths, against the estate gate
   file unioned with the repo's own. Both are read from the **default branch**, so a PR can
   never widen its own gates. No match → auto-merge armed. Any match → `human-signoff`, and
   it waits for you.
5. **Independent review pass** — a *fresh container with fresh context* and no memory of
   having written the code. It holds no GitHub credential at all; it returns a structured
   verdict — approve, request-changes, or escalate — and the **orchestrator** posts the
   review under the reviewer account. It can always *add* human oversight (escalate disarms
   auto-merge); it can never remove it.
6. **Merge** — approve + green CI + armed auto-merge → GitHub squash-merges → the issue
   closes via `Closes #n` → the next sweep marks the run `merged`, and anything blocked on
   that issue becomes eligible.

**The self-healing loops**, which are most of the value:

- **request-changes** → the reviewer's findings are injected as the implement agent's *next
  turn*, same attempt, same container. Two review cycles per attempt. *(This month: 5 of 47
  verdicts were request-changes, 1 escalate.)*
- **Red CI** → confirmed over two consecutive sweeps (so a flake doesn't spend the budget),
  then exactly **one** automated repair pass. Still red → auto-merge disarmed, PR labelled
  `human-signoff`, ticket back to `ready-for-human`, plus an issue comment, a red Discord
  embed and a dashboard card. CI is always repaired before any re-review, so no reviewer is
  ever pointed at a branch that doesn't compile. *(17 repair passes ran this month.)*
- **Merge conflict** with the default branch → a repair pass, then escalation.
- **A push after a review** → the stale approval is withdrawn and the PR re-gated, because
  GitHub keeps counting an approval until it's dismissed.
- **A dead container or a restart** → the run is marked `interrupted`, not `failed`, and
  re-claimed **without burning an attempt**. *(18 interruptions this month, $4.19 total.)*
- **Three real failures** → `ready-for-human`, and it stops asking. *(Happened once.)*

### c) What the sandbox is

A **standalone Docker container per attempt, running Claude Code headless** — `claude -p`
with streaming JSON out — as a non-root user. It gets nothing from the host: **no bind mount
at all**, so it can't see your Claude config, credentials or history. It gets a clone of the
repo, a GitHub App token minted fresh per exec (consumed by a credential helper, so no secret
lands on disk), hard 2 GB / 1 CPU limits, and a branch of its own. The reviewer's credential
never goes near it.

---

## 5. Numbers to quote

Straight from Interlude's own `runs` ledger on the VPS — so this is only work **Interlude
ran**, not the local runner. Autonomy went live **2026-08-04**; the ledger covers **9 active
days**.

| | |
| --- | --- |
| Tickets attempted | **53** |
| Attempts | 79 |
| **PRs merged** | **49** — of which **44 first try** |
| Failed / exhausted / cancelled | 10 / 1 / 1 |
| Interrupted and re-claimed free | 18 (**$4.19** total) |
| Total spend | **$640.93** |
| Median cost per merged ticket | **$8.71** |
| By project | LPS 35, Moontide 10, Platform 4 |

Passes run: **79 implement** ($423.86), **110 review** ($166.12), **37 triage** ($16.94),
**17 repair** ($50.95), 9 interactive ($5.01).

Time to merge, fully unattended tickets: **5 to 57 minutes**, median 42 (one 6-hour outlier).

### The number worth being honest about

**6 of the 49 merged runs were ungated** — auto-merged with no human at all. The other 43
were gated to `human-signoff`. That isn't the loop failing; it's the gate config doing its
job: nearly all the work so far has been UI, and the estate deliberately reserves visual UI
for a human. So the honest claim is:

> 49 tickets merged in 9 days, 44 of them first time, for $641. Six needed nothing from me at
> all. The other 43 needed exactly one action — a sign-off click — because they touched
> pixels, which is a line I've chosen not to let an agent cross.

That's **throughput per unit of attention**, and it's a better story than "it does everything
by itself". Worth saying that ticket A in this demo is the *rarer* fully-unattended path, and
ticket B is what most tickets actually look like.

---

## 6. Ten minutes before

- [ ] Nothing else armed: `gh search issues --owner lennons301 --label ready-for-agent --state open`
- [ ] LPS shows `autonomyEnabled: true` / `preflightStatus: "passing"`; kill switch lifted.
- [ ] Ticket C already triaged and its embed sitting in Discord.
- [ ] **Discord inbound smoke test** — reply to any task embed, confirm the 👍. Inbound rides
      one gateway with no watchdog and has been seen dropping a reply.
- [ ] Arming needs **exactly `yes`** — "yes please" and a 👍 do nothing.
- [ ] Tabs: dashboard, milestone, A, B, `docs/agents/review-gates.yaml`, `/settings`, Discord.
      Check `/tasks` loads — it was hanging earlier; if it still is, drill down from the
      dashboard's Running card instead.
- [ ] Expect up to 30 s pickup latency (never say "instantly"), and agent prose rendering as
      one undifferentiated block in the chat view.
