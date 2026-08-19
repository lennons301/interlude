# LPS autonomous demo — cue card

**Claim:** define a block of well-scoped work, arm it, trust it to run to completion.

| | |
| --- | --- |
| Dashboard | https://interludes.co.uk |
| Milestone | [Demo: pot breakdown](https://github.com/lennons301/last-person-standing/milestone/4) |
| **#213** — auto-merges (`src/lib/game-logic/**`, matches no gate) | [issue](https://github.com/lennons301/last-person-standing/issues/213) |
| **#214** — gated (`src/components/**` → `visual-ui`), blocked by #213 both ways: `Blocked by:` line **and** native dependency | [issue](https://github.com/lennons301/last-person-standing/issues/214) |

Arm #213 and #214 together. If #214 is already running when you start, fine — the blocked-then-released beat can be told from #214's history instead.

---

## Open this live (ticket C)

Title:

```
Pot totals should be easier to read on mobile
```

Body:

```
The pot numbers are cramped on my phone — hard to read at a glance when I open a game.
Would be good if they were clearer.
```

No labels, no milestone, opened as `lennons301`. `needs-triage` lands within seconds — that label *is* the enqueue. The pass itself is a container and there's one slot, so it starts at the next gap (when an implement pass parks for review); triage outranks implement in the queue. Open it early, come back to it later.

---

## Run flow

| Beat | On screen |
| --- | --- |
| **Frame it** | The tracker is the queue. A human presses the launch button. Everything after that is deterministic. |
| **The block** | The milestone. #214 is blocked by #213 — skipping is **silent**, so the evidence is negative: #214 has the label, no run, no card. |
| **Dashboard** | Slot holds `LPS #213`, chip `afk`, `implement ▸ review ▸ merge`, pips `●●○`, turns, elapsed, spend vs $20, today vs the $500 cap. Needs-you: *"Nothing needs you."* |
| **Drill-down** | Tool calls streaming, colour-coded diffs, branch `agent/issue-213`, issue + PR links appearing live as the draft PR opens on first push. |
| **Open ticket C** | Paste from above. Watch `needs-triage` land. |
| **↓ talk track — fills the wait** | |
| **Gate + merge** | *"matched no gates — auto-merge (squash) armed."* Approving review from **`lennons301-reviewer`** — a different account. Four checks green. Squash-merged. Issue closed by `Closes #213`. The PR conversation is the audit trail. |
| **Dependency releases** | #213 closed → next sweep claims #214. No human action. |
| **Triage → Discord** | C's `recommend` comment on the issue, embed in Discord. Reply exactly **`yes`** → ✅, audit comment naming the Discord route, `ready-for-agent` applied, claimed. |
| **The human gate** | #214's PR: `human-signoff`, auto-merge disarmed, `visual-ui` named in the comment, amber needs-you card. You merge it. One decision, handed to you. |
| **Close** | `/settings` — press the kill switch, pickup pauses, lift it. Then the numbers. |

---

## Talk track

### a) How an armed issue gets detected

- GitHub App on the repo. `ready-for-agent` fires an `issues.labeled` webhook (HMAC-verified) which kicks a sweep.
- The webhook is only latency. A **reconciliation sweep runs every 30 s** listing open `ready-for-agent` issues per project. **The label is the queue** — nothing to drift out of sync, and a dropped webhook costs ≤30 s.
- Eligibility: project armed, preflight passing, no active run, attempts left, author allow-listed, **no open blocker** (`Blocked by: #N` line or native dependency).
- Order is **oldest-armed-first**, globally. Priority is *when* you arm, nothing else.

### b) What a ticket goes through

1. **Claim** — a `runs` row per *attempt*, comment on the issue, container on `agent/issue-<n>`.
2. **Implement** — draft PR on first push, marked ready at the end.
3. **Self-review in-pass** — the agent must satisfy its own lint/typecheck/tests first.
4. **Gate** — deterministic, on changed paths, estate config ∪ repo config, both read from the **default branch** so a PR can't widen its own gates. No match → auto-merge armed. Match → `human-signoff`.
5. **Independent review** — fresh container, fresh context, no memory of writing the code, **no GitHub credential**. Returns approve / request-changes / escalate; the *orchestrator* posts it. It can always add oversight, never remove it.
6. **Merge** — approve + green CI + armed auto-merge → squash → `Closes #n` → next sweep marks the run `merged` and anything blocked on it becomes eligible.

**Self-healing loops:**

- **request-changes** → findings injected as the implement agent's next turn, same attempt. 2 cycles max.
- **Red CI** → confirmed over 2 sweeps (flake guard), then exactly **one** repair pass. Still red → disarm, `human-signoff`, `ready-for-human`, issue comment + red Discord embed + dashboard card. CI is repaired *before* any re-review, so no reviewer sees a branch that won't compile.
- **Merge conflict** → repair pass, then escalate.
- **Push after review** → stale approval withdrawn and the PR re-gated (GitHub counts an approval until it's dismissed).
- **Dead container or restart** → `interrupted`, not `failed`: re-claimed **without burning an attempt**.
- **Three real failures** → `ready-for-human`, and it stops asking.

### c) What the sandbox is

A standalone Docker container per attempt running **Claude Code headless** (`claude -p`, streaming JSON), as a non-root user. **No bind mount at all** — it cannot see the host's Claude config, credentials or history. It gets a clone, a GitHub App token minted fresh per exec (via a credential helper, so nothing lands on disk), hard 2 GB / 1 CPU, and its own branch. The reviewer's credential never goes near it.

---

## Numbers

From Interlude's own `runs` ledger. Autonomy live **2026-08-04**, **9 active days**.

| | |
| --- | --- |
| Tickets attempted | **53** (79 attempts) |
| **PRs merged** | **49** — **44 first try** |
| Failed / exhausted | 10 / 1 |
| Interrupted, re-claimed free | 18 (**$4.19**) |
| Total spend | **$640.93** |
| Median per merged ticket | **$8.71** |
| By project | LPS 35, Moontide 10, Platform 4 |
| Unattended time to merge | 5–57 min, median 42 |
| Gated vs auto-merged | 43 / 6 |

Passes: 79 implement, 110 review, 37 triage, 17 repair, 9 interactive.

---

## Two things to expect

- Pickup takes up to 30 s — the sweep is single-flight and merge detection is polling-only. Never say "instantly".
- Agent prose renders as one undifferentiated block in the chat view (issue #114).
