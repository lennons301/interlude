# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v` — `gh` does this automatically when run inside a clone.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments` then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop `OWNER`/`MEMBER`/`COLLABORATOR`).
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either — resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue, in the shape the *Ticket contract* section below requires: every published ticket carries a `## Workflow` section naming a tier.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Ticket contract: every published ticket declares a tier

This section extends the generation skill's issue template. The skill (`/to-tickets`) is not forked, wrapped or vendored: its template is a shape, and this contract adds one section to that shape, the same way `docs/agents/review-gates.yaml` adds gates to the estate defaults without removing any. Read it whenever you publish a ticket to this repo — from `/to-tickets`, by hand, or inside an interlude generation session. All three have this file checked out.

### The rule

**Every published ticket carries a `## Workflow` section, and that section names a tier** on a `model:` line:

```markdown
## Workflow

model: light
```

The tier says how hard the ticket's *work* is, so the fleet can run a one-line guard and a new state machine at different tiers instead of running both at whatever the fleet's configured default resolves to. Put the section after `## Acceptance criteria` and before `## Blocked by`. One `model:` line per ticket, on its own line, not inside a code fence; the executor reads whole lines inside the Workflow section and nothing else, so a tier mentioned in prose is data, not a decision.

The key is `model:`, not `tier:`, because `model:` is the directive the executor already reads. The vendor names `opus`, `sonnet` and `haiku` still resolve as aliases for `heavy`, `standard` and `light`, but write the tier: the tier is what the fleet acts on, records on the run and reports.

### Choosing the tier

Three tiers, and each one is **chosen positively**. There is no default and no "otherwise" branch: read all three criteria and state the one that describes the work. The axis is what the spec leaves for the implementer to decide — nothing, the route, or a design decision — not how confident you feel about the ticket.

- `light` — the change is determined by the spec: an explicit instruction, a mechanical edit, a well-bounded change with no ambiguity about what to write.
- `standard` — judgement within a known pattern: multi-file, follows existing conventions, acceptance criteria clear but the route not spelled out.
- `heavy` — a design decision the spec does not make: a new seam or abstraction, concurrency or state reasoning, a subtle invariant, or blast radius crossing module boundaries.

`standard` is not the middle to settle on when the choice feels hard; it is chosen when the route is genuinely the implementer's to find within conventions the repo already has. `light` is not reserved for the trivially obvious; it is chosen whenever the spec has already made every decision the implementer would otherwise make, however many lines that takes. `heavy` is chosen for the decision the ticket asks the implementer to make, not for the size of the diff. When none of the three fits, the ambiguity is usually in the ticket rather than the rubric — sharpen *what to build* until one criterion describes it.

### What a ticket may and may not say

- **A tier, never a lane.** Which lane runs a pass — the subscription, the Anthropic API, OpenRouter — is fleet policy and cost routing. A ticket body is semi-trusted text and may not send the fleet somewhere that spends money. There is no lane directive, and the executor ignores unknown keys rather than interpreting them.
- **A tier, never a raw model identifier.** `model: claude-opus-4-8` names no tier. The executor drops it, runs the pass at the configured default and notes on the issue that the directive was not recognised — so a mistyped tier is visible, never fatal, and never obeyed.
- **The tier applies to the ticket's implement pass only.** Its review and repair passes are *derived* from it — one rung above the tier the implement pass ran at, capped at the top of the vocabulary and by the fleet's own review/implement settings when the operator has set them (issue #201) — and triage runs at the fleet's own setting. A ticket cannot cheapen the gate that judges it or the pass that assesses it, and the Workflow section has no key that would let it: declaring `light` buys a light implement pass and a standard review, never a light one.
- `budget:`, `max-turns:`, `checkpoint:` and `effort:` stay hand-written escape hatches in the same section (see `docs/runbook.md`). They are not part of the tier decision: a budget is a ceiling, not a lever, and declaring a low one on a cheap ticket saves nothing.

### A ticket that arrives without a tier

It is not refused. It runs exactly as it did before this contract, at the configured default tier for the pass: a forgotten section costs the fleet nothing it was not already paying — it only forfeits the choice. Refusing to claim such a ticket would wedge the frontier over a missing doc section, so the contract is enforced by the producer writing the section, not by the executor.

### The section and `workflow:<skill>` labels

Know one consequence before you publish. The executor reads a body Workflow section as the ticket's *own* workflow: when one is present, the implement pass is told to follow the section, and a `workflow:<skill>` label (`workflow:tdd`) is **not** applied. This contract puts a section on every ticket, so a label alone no longer selects a method. The right fix is in the reader — a section carrying only directives should not count as a bespoke workflow — and is deliberately outside this contract, which changes no parser. Until it lands, a ticket that needs a named method writes the method into its Workflow section alongside the tier (the steps, the seams under test, the done-signal: the per-ticket override the estate contract already provides for) rather than relying on the label.

### The extended shape

The generation skill's issue template, with this contract's one addition:

```markdown
## Parent

Spec: #<n> (omit when there is no parent)

## What to build

The end-to-end behaviour this ticket makes work, from the user's perspective.

## Acceptance criteria

- [ ] Criterion 1
- [ ] Criterion 2

## Workflow

model: standard

## Blocked by

- #<n>, or "None — can start immediately"
```

### Scope

The tier vocabulary is interlude's own. The estate's other executor ignores `model:`, so this contract lives here and not in the estate's workflow choice document; promoting it estate-wide is a later decision, deliberately not taken until the rubric is proven on this repo's tickets.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (`gh api` on the sub-issues endpoint). Where sub-issues aren't enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's **native issue dependencies** — the canonical, UI-visible representation. Add an edge with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/<owner>/<repo>/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). GitHub reports `issue_dependencies_summary.blocked_by` (open blockers only — the live gate). Where dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children (`gh issue list --state open`, scoped to the map's sub-issues / task list), drop any with an open blocker (`issue_dependencies_summary.blocked_by > 0`, or an open issue in the `Blocked by` line) or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me` — the session's first write.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, then append a context pointer (gist + link) to the map's Decisions-so-far.
