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
- Non-text contrast (issue #142): `--fl-mark` is the quiet neutral for marks that are **not text** — the focus ring (`FOCUS_RING`) and every status dot — because those owe WCAG's 3:1 floor and `--fl-ink-3` misses it on the light ground (2.44:1). `--fl-ink-3` stays the quiet *ink*, for text only. A component that paints a background in ink-3 fails `src/components/__tests__/fleet-tokens.test.ts`, which also checks both themes' values against ground/surface/card and holds the light palette's two copies (a media query can't be OR'd with a selector) to being identical
- Tasks archive read path (issues #120, #142): the list is bounded by recency and nothing paginates it, so the kind filter is applied **in SQL** — `readTaskList` (`src/lib/tasks/task-list-query.ts`) is the one place the projection and the `where` live, and `TaskListRow` is *derived* from what it returns so a renamed column fails to type-check at the cards. The route's `kind` parameter speaks the list's own chip vocabulary (`TaskFilter`), and `chipColumns` derives the chip→column mapping from the same maps `taskChip` classifies with rather than restating them. Everything the screen decides — `organizeTasks`, `listState`, `filterOptions` — is a pure selector beside them, tested there rather than in a component
- Live-view transcript (issue #121): `toChatView` (`src/lib/chat/chat-view.ts`) is the pure mapper from stored message rows to the view-model the transcript renders (`user-chip` / `agent-markdown` / `tool-event` / `system-note`); the components are dumb renderers. Agent turns render as GFM markdown via `renderMarkdown` (`src/lib/chat/markdown.ts`) — a self-hosted unified pipeline (no CDN at build or runtime) whose plugin **order is the safety argument**: raw HTML is escaped to literal text, rehype-sanitize's allowlist then covers what markdown itself can produce (`javascript:`/`data:` URLs), and only trusted plugins run after it (highlighting, the recommendation marker), which is why their classes survive. Read that module before touching the order. Syntax colours are fleet CSS variables in `globals.css` — never import a highlighter theme. The tree must resolve **one** `highlight.js` (issue #150): the grammars are imported directly but `rehype-highlight` runs them on the core its own `lowlight` resolves, and a mismatch fails only at render time in the browser — so `package.json` tracks lowlight's range (`~11.11.0`), not the latest 11.x, and `markdown.test.ts` asserts the lockfile has no skew
- Bounded outbound I/O (issue #151): a stalled dependency must never freeze dispatch, the discipline #128 gave the Docker probe. Every outbound call the orchestrator awaits carries a wall-clock bound built on one primitive, `raceWithTimeout` (`src/lib/timeout.ts`), which returns a sentinel so each caller keeps its own policy — the admission probe fails *open* (#115), the agent-container census reports *unknown* (#152), a Discord REST call fails *closed*, a GitHub request additionally aborts its connection. Probe-shaped callers go through `runBoundedProbe` in that same module, which folds a *rejection* into the same three-way outcome because a probe's caller has to decide what a non-answer means whichever way it arrives; it is a thin wrapper over the race and must stay one — a second implementation drifts (the `unref` is the first thing it loses), so the race stays written once. GitHub clients only ever come from `createOctokit` (`src/lib/github/client.ts`), which installs the bound as a `request.fetch` wrapper because @octokit/request has no timeout option; an eslint rule bans `new Octokit(` anywhere else. A Discord call abandoned at the bound is never retried — the attempt may still land, and a retry would double-post
- Queue bookkeeping (issue #151): the poll loop keeps **two** sets, and merging them is what wedged the box on 2026-08-18. `inFlightTasks` is the re-entrancy lock, held until the driving promise settles (`startTask` marks its container idle *before* it commits, pushes and opens the PR, so an earlier release would run two agent execs in one container). `slotReservations` is slot accounting: it stands in for a container being provisioned and is released the moment the container registers or the task turns terminal, never waiting on a promise. `occupiedSlots` additionally ignores any reservation whose task has finished, so the count self-heals within one poll. Nothing, though, makes that count *true* — so the fleet-health watchdog no longer takes it on trust (issue #152). Its three #126 signals all read `occupiedSlots()`, which made a phantom reservation invisible by construction: it held the box's only slot for ~1.5h while the queue refused every pickup and `needsYou` stayed empty, because from the watchdog's view the box was legitimately saturated. The fix is a fourth *observation*, not a fourth mechanism — the sweep asks the daemon what agent containers really exist (`observeAgentContainers`, `src/lib/docker/agent-containers.ts`, which also owns the container-name prefix the census, the admission probe and the reaper all filter on) and hands both numbers to `decideFleetHealth`, where a sustained disagreement becomes the same pickup-wedged card and one-time ping the other three use, carrying its own remedy because a phantom slot lives in orchestrator memory and only a restart clears it. The ping is deduped on the *cause* and re-fires only on an **upgrade** (`dispatch` → `phantom-slot`), never a downgrade: a downgrade means we observed less, not that the fleet recovered, and re-pinging there would demote "restart the app" to "go and look" on a box that still has a phantom. Three rules keep it from crying wolf: the comparison is **one-directional** (`occupied > live` only — more containers than counted slots is the memory-admission probe's business), a **null census is *unknown*, and unknown decides nothing either way** — it may not manufacture a divergence (a zero census reads as "restart the app", so a daemon that cannot answer must say nothing rather than be misread as saying none) and it may not clear one, since only positive agreement stops the clock; erasing on unknown would have meant 40 consecutive answered sweeps to reach the threshold, which a daemon hiccuping once every 20 min never gives, and a hiccuping daemon is the likeliest companion of a real phantom, and only `live` corroborates — a parked container is `docker stop`ped since #93, so it is absent from *both* sides and cancels out, while counting it into the ceiling would instead hide a phantom sitting behind it. Queued work is gathered every sweep rather than only behind a seemingly-free slot, since whether a slot *reads* free is the fact under suspicion. The debounce is its own tunable (`OCCUPANCY_DIVERGED_MINUTES`, default 20 min in `budgets.ts`), far longer than the 3-minute pickup one and set by the worst *honest* case: a task holds its slot from reservation but has no container until `createWorkspaceContainer` returns, and that call runs `ensureImage` inside itself, so a cold agent-image build is legitimately uncorroborated the whole time — and this card's advice is a restart, which would kill exactly that task. The card names the two numbers it judged — what occupancy claims, and what the daemon reports — because the operator's action is a restart, not a wait. The dashboard's `slots.used` stays DB-derived (`occupants.length` via `isLiveTask`) and is deliberately *not* re-derived from the counter: those two surfaces disagreeing is what the #151 incident looked like from outside, so overwriting either with the other would hide the evidence rather than reconcile it — they are reconciled instead by making the *gating* number read the same fact the dashboard does (below), which is what closes the gap without blinding the surface
- Slot bookkeeping never outlives its task (issue #159): the task row, not memory, is the authority. `occupiedSlots` counts neither a reservation nor an `activeTasks` entry whose task the DB calls terminal (`taskIsFinished`, `src/lib/tasks/stored-status.ts` — the one predicate, shared, because a fleet that disagreed with itself about whether a task had finished is how bookkeeping outlived its task twice), and `releaseSpentReservations` then drops what the count skipped. That is a true invariant needing no Docker call: a `completed`/`failed`/`cancelled` task runs no agent process. It is also what makes `slots.used` and `occupiedSlots()` agree in every normal state — both now exclude terminal tasks and parked passes, each pinned by its own test — so a residual disagreement is real evidence rather than an artefact. The prune deliberately leaves containers alone; the stale-container reaper already owns any container whose task is neither live nor run-owned, and removing them here would race it. Beyond that, a **blocked** pickup is re-checked against the daemon every ~30 poll seconds (`reconcileSlotsAgainstDaemon`), fixing the direction the admission probe could never cover: that probe sits behind `slotFree`, so a phantom slot failed the slot test first and it only ever caught *under*-counting, never the over-counting that stops work. Both halves are one-directional and fail-safe, because freeing a slot out from under live work is worse than the wedge it fixes — an entry goes only on a positive 404 (`containerIsAbsent`, which tests *existence*, not liveness: an entry in `setup` is created-but-not-started and a parked pass is `docker stop`ped, and `isContainerRunning` calls both gone), a reservation only once it outlives `PROVISIONING_GRACE_MS` *and* its task still records no container. That grace is deliberately the same 20 min as `OCCUPANCY_DIVERGED_MINUTES` and for the same reason (a cold `ensureImage` build inside `createWorkspaceContainer`), so the watchdog's card never fires before the self-heal it would be warning about
- Orchestrator state a route handler touches lives on `globalThis` (issue #159), via `processSingleton` (`src/lib/process-singleton.ts`). Next compiles `instrumentation.ts` — where the queue loop, the sweep and the Discord bot run — and the app-router route handlers into **separate module graphs**: same process, one registry each, so a module imported from both is *evaluated twice* and its module-level `const` state exists twice. Measured on 16.1.6 against the production entrypoint (`output: standalone`): `turn-manager` loads twice, and `POST /api/tasks/[id]/complete` holds the second copy while the queue counts the first. That is why one normal UI close of an interactive session held the box's only slot until a restart, deterministically, while the same close from Discord always worked — Discord's path is a dynamic import from inside the orchestrator's own graph. `globalThis` is the only registry the two graphs share, so it is the only fix available; a plain module-level value is still right for state one side alone ever sees. The regression test loads `turn-manager` twice through `vi.resetModules()`, the only seam that can see a defect which is not in what either copy does but that there are two. **Still split, and known (needs filing):** `runAutonomySweep` is called from the GitHub webhook route, so a webhook-triggered sweep runs on the app-router graph — where `fleetHealthState`, `sweeping`, `inFlightClaims` and every announce-dedup set are that graph's own, freshly empty. Its consequences are worse than they look: `recordFleetHealth` *is* globalThis-backed, so a webhook sweep computes all-clear signals against an empty debounce clock and overwrites a standing needs-you card; `isQueueRunning()`/`getQueueLastProgress()` read that graph's stopped loop; and two sweeps can run and claim concurrently. Filed, not fixed here — every one of those needs the same treatment and concurrent sweeps need their own tests
- Quota observability (issue #165): the fleet writes down what it does not understand rather than dropping it. `stream-recorder.ts` is a durable, append-only JSONL log **beside the SQLite database** (so it inherits `/data` with no migration) holding every unrecognised stream event verbatim plus every pass's exit condition, because the one thing that cannot report a rate limit is the agent that just hit one — the orchestrator is an ordinary Node process reading stdout, it is not rate-limited, and it does not need to be conscious at the moment of the wall. `rate_limit_event` is recorded despite being recognised and now consumed (#167), and stays recorded after it: the state row #167 keeps is latest-wins and parsed, so this log is the only verbatim history — the only place a window's shape over time, or a field this build does not model, can be recovered from. It is bounded three ways (payload cap, a per-(task, event-type) cap that emits one `suppressed` marker rather than going quiet, rotation to one prior generation — the *oldest* evidence is usually the interesting evidence) and swallows its own errors, because it sits in the stream-parse path of every turn and a log that can break the pass it observes is worse than no log. Three findings from the spike bind the tickets above it: `rate_limit_event` **does** reach stdout under `--output-format stream-json --verbose`, but a rejection then arrives as `subtype: "success"` with `is_error: true` / `terminal_reason: "api_error"` / `api_error_status: 429` — so the only field the orchestrator reads is exactly the one that cannot tell a quota wall from a clean finish, which is why `TurnResult` now carries the terminal event whole; a rejected headless pass **exits in ~2s rather than waiting**, so the pause design detects an exit, not a hang; and the unified-window machinery is **subscription-only** (an API-key lane emits no `rate_limit_event` at all — #172/#173 get no quota telemetry from a metered lane). `scripts/rate-limit-stub.mjs` reproduces any limit state on demand via the `anthropic-ratelimit-unified-*` headers, and its enum values are the ones the binary actually accepts — getting them wrong is silent
- Fleet quota state (issue #167): the CLI's `rate_limit_event` stops being thrown away. The parser reads it into `TurnResult.rateLimit` and writes it, **at the moment of observation rather than at the end of the turn**, to the single `quota_state` row (an interactive turn can run for an hour, and the fleet's freshest fact must not arrive last); the dashboard's quota tile renders that row. Latest wins in both senses — one row for the fleet, and within a turn the *last* event, because the CLI emits one per API attempt and only the newest describes the account now. Three shapes the wire has that the CLI's own schema does not, each pinned by a test against the captured fixtures: `utilization` and `resetsAt` are frequently **absent, not null or zero** (a missing utilization read as 0% would describe a walled account as an idle one — #171's gate inherits this), the event nests its fields under `rate_limit_info`, and it carries `isUsingOverage`/`overageInUse`, which #173 needs and a reader written to the documented list would drop. Enums are held **verbatim as strings, never parsed against a union**: a member a later CLI adds must reach the screen, so an unknown status paints in a tone that claims nothing (`quotaSeverity` -> `unknown`) rather than throwing or being dropped. There is only ever one limit window on the tile because the event carries one — the server picks the *representative claim*, the window closest to tripping — so "which limit is closest" is a field, not a computation. Pausing (#168) is the first thing that acts on any of it; admission (#171) is the other. The row is written in the **wire's own encoding** (the CLI's field names, unix-second resets) and read back through the same `parseRateLimitEvent` the stream goes through, so there is exactly one reader of an observation and no second defensive parser to fall out of step. The tile makes one inference of its own: an observation whose stated reset has since passed goes **quiet**, keeping its words and losing its colour and its bar — a red `rejected` over a wall that lifted hours ago is crying wolf. A row rather than an in-memory store because a five-hour window outlives a deploy, and because the writer (the stream parser, in the orchestrator's module graph) and the reader (the dashboard's route handler, in the app router's) share nothing but the database (#159); a table rather than a column on `settings` because folding an observation written on every API attempt into that row would make the settings screen's "last changed" report the fleet's traffic instead of the operator's last press
- Quota pause (issue #168): a pass the account's quota **refuses** parks its run instead of failing it — before this, a wall spent one of the ticket's three attempts and three of them routed a perfectly good ticket to a human because the account ran out of window. `detectQuotaRejection` (`src/lib/quota/rate-limit-rejection.ts`) takes **both** signals, because each alone lies: the exit condition says the pass ended on an API error but reports `subtype: "success"` at a wall (#165's finding, which is why `TurnResult` carries the terminal event whole), and the `rate_limit_event` says the account was rejected but is emitted per API attempt — a pass can observe a rejection, be retried past it, and still finish, and pausing *that* run would park a finished attempt on a five-hour clock. A rejection carrying **no reset time takes the ordinary path**: a run paused on an unknown window is stranded where no later ticket can find it, so the fleet spends the attempt rather than inventing a clock it does not know the length of. The decision is the reducer's (`pauseRunOnRateLimit`), emitted **ahead of both other readings of a finished pass** — a refused turn never reached the model, so its "final message" is the CLI's own session-limit line (which the blocked-marker detector would read as a question nobody asked) and its empty diff is the wall's, not the work's (which #106's empty-pass path would charge as a strike). The executor writes `runs.status = rate_limited` + `resumeAfter` and **nothing else**: no `finishedAt` (the run has not finished, it is waiting), no attempt, no `interruptionCount` — the two bounds keep measuring what they say. The container is **removed, not stopped** as a blocked run's is: a parked container holds ~2 GiB while holding no slot (2026-08-04), and a five-hour window is far too long to hold one for. The status vocabulary is one leaf module (`src/lib/orchestrator/run-status.ts`) because the two questions it answers pull in opposite directions and both are **inclusion** lists, so a status added later is by default neither: `rate_limited` is *active* (the ticket is still this run's — claiming a second one over it would spend the very attempt the pause protects) and *not reclaimable at boot* (it waits on a clock, not a lost turn, exactly as `gated`/`blocked` wait on a human). On the surfaces it stays under **Running**, labelled paused with its countdown, and deliberately never reaches needs-you — nobody has to *do* anything about a quota window, and that section means a human decision is required; the digest reads the same `paused` field so the two cannot disagree. Deliberately implement-shaped passes only: a walled review pass already fails closed to a human without spending an attempt, and #171 is the ticket that stops a pass starting under a wall at all. Resuming a paused run is #169 — until it lands, a paused run stays paused

## Database

Schema at `src/db/schema.ts`. Six tables: `projects`, `tasks`, `messages`, `runs`, `settings`, `quota_state`.

- `runs` is the Phase 5 autonomy ledger — one row per attempt at one ticket; a run owns one or more tasks (its implement pass plus any review passes). Interactive tasks have no run, which exempts them from the daily autonomous spend cap by construction (`src/lib/orchestrator/spend.ts`)
- Budgets (issue #18): `MAX_BUDGET_USD` is the **$20 per-attempt** default — it was $5 per *task* before Phase 5, and interactive tasks deliberately inherit the new, more generous default. A ticket's `budget:` directive (Workflow section) may raise one attempt to at most $75; review passes carry their own ~$5; the $500/day autonomous cap and all ceilings live in `src/lib/orchestrator/autonomy/budgets.ts`
- `runs.status = rate_limited` + `runs.resumeAfter` is the quota pause (issue #168): non-terminal, set at pass completion when the account refused the pass, cleared by nothing yet — resuming is #169. It is the only status that waits on a clock rather than on a human or a turn
- `runs.reviewResult` holds a finished review pass's parsed verdict until the orchestrator has acted on it; `runs.reviewVerdict` is the last verdict actually posted to GitHub, and `runs.reviewedHeadSha` the commit that verdict was written about (issue #131). A parked run whose PR head has moved past it — a human's *Update branch*, commit or `main` merge — is disarmed, has its stale review dismissed, and re-gates + re-reviews once; past the review-cycle budget it goes to a human instead
- `tasks.kind` distinguishes interactive (default) / implement / review / triage; `tasks.runId` links a task to its run; `tasks.triageResult` holds a finished triage pass's parsed exit until the sweep applies it (triage owns no run, so its spend is counted into the daily cap by kind in `spend.ts`)
- `projects` carries `autonomyEnabled` (default off) plus cached `preflightStatus`/`preflightReason`
- `settings` is a single durable row (id `fleet`) of operator state flipped at runtime, as opposed to env config in `src/lib/config.ts` which is fixed at boot. It holds `globalAutonomyPaused` — the global kill switch (issue #118), read fresh by the sweep each tick (via `src/lib/settings.ts`) and toggled by `PATCH /api/settings/autonomy`. Engaged, `decideNext` emits no pickup actions at all (no claim, no triage pass) and nothing else changes: in-flight runs, gating, review and exhaust routing carry on, exactly as under the daily-cap pause whose gate it shares. `AUTONOMY_ENABLED` stays the **boot master** (false = sweeps never start); the flag is the runtime pause layered on top, so it takes effect at the next tick with no restart — and, being a row, an engaged switch survives a restart. Both observability surfaces read the row, never the sweep's log line (which only fires on a tick that had a ticket to claim): the dashboard's dot reads `held` with its banner, and the daily digest leads with an **Autonomous pickup** section (issue #143) stating the hold as it stands when the digest is written — the flag has no history, so a switch lifted before the morning send leaves the covered day reading quiet. Both read one field, `FleetView.pickupPaused` (issue #148), which carries **three** fleet-wide reasons so the surfaces cannot disagree: `autonomy-off-at-boot` (dot `off`) outranks `kill-switch` (dot `held`) outranks `daily-cap` (dot `paused`) — the master leads because lifting the switch under it would change nothing. Per-project holds are deliberately not in that field (one repo failing preflight is not a held fleet): they ride `ProjectPickupHold` on the backlog rows and the per-project preflight card, both fail-closed exactly as `decideNext` is
- UI-editable settings (issue #166): the `settings` row's second job. `overrides` is a sparse JSON object of env-config fields a human may change while the fleet runs, merged over the environment by a **pure resolver** (`src/lib/settings-resolver.ts`) — one JSON column rather than a column per setting, so a later ticket in #164's quota work adds a field to the registry there and not a migration, and a retired key is dropped on read instead of left as a dead column. Four rules, each pinned by a test: an **unset** field falls through to its own environment default (so a fresh deployment behaves exactly as before, and a cheap triage default never quietly decides what the reviewer runs on); a **set** one wins and reports its **provenance**, which is what makes a surprising tier debuggable from the screen; only keys in `SETTINGS_FIELDS` are settable at all, which is how "a UI override may never widen a hard ceiling" is enforced — the ceilings are refused *by name* (`FIXED_CEILINGS`) rather than absent by oversight; and a disallowed value is **rejected with a message, never clamped**, because a clamp turns "I asked for X" into "the fleet quietly did Y". The freshness rule lives at the call sites, not in the resolver: `getConfig()` memoises into a module-level value on first read, so an override cannot ride on it — `getSettingsOverrides()` is re-read at the point of use (the turn manager, per pass and per follow-up turn), which is what makes a change take effect at the next sweep with no restart
- Model choice is a **tier**, not a model id (issue #166): `heavy` / `standard` / `light` (`src/lib/model-tiers.ts`), with `opus` / `sonnet` / `haiku` kept working as aliases so a ticket carrying a `model:` directive doesn't break. The vocabulary is one module because three surfaces speak it — the settings UI, the env defaults and the semi-trusted ticket directive (which the parser now normalises to a tier, so everything downstream deals in tiers only) — and `TIER_MODEL_IDS` is the pre-lane tier→id map, which execution lanes (#172) now supersede per lane — it survives as the default for a caller with no lane in hand. Precedence, ordered once in `resolveAgentModelChoice`: a ticket's directive (work-carrying kinds only — the ticket chooses the model its *work* runs on, not the reviewer's) beats the UI override beats the environment. An env value that names no tier (a pinned `claude-opus-4-8`) stays legal and passes through verbatim; the UI, whose job is the durable choice, takes tiers only
- Execution lanes (issue #172): which harness runs a pass, against which provider, on which model is **configuration**, not code. A lane is `{ adapter, auth env var names, base URL, tier→model map, caps, billing kind }`, declared in the checked-in `lanes.yaml` at the repo root (`src/lib/lanes/lane-config.ts` parses it; the production image must `COPY` the file, as Next's standalone output carries only what the bundle imports). **Secrets appear only as variable names**: `auth` maps the variable the *harness* reads to the orchestrator variable holding the secret (Claude Code reads `ANTHROPIC_AUTH_TOKEN`, the OpenRouter key is provisioned as `OPENROUTER_API_KEY`, hence a mapping and not a list), and the parser enforces `^[A-Z][A-Z0-9_]*$` on both sides, so an inlined credential is a parse error rather than a secret in git. No lane **secret** is ever stored in the DB or served by an API route — the settings row holds the chosen lane's *id*, `runs.lane` holds the id a run used, and the settings payload carries variable *names* only; the rule a project route once broke by serving a stored token in cleartext. Resolution (`src/lib/lanes/resolve.ts`) is pure — `(catalog, pass kind, config, overrides, env)` in, `{auth values, base URL, model id, caps}` out — and it **reports rather than falls back**: an unavailable lane refuses *before* a container is provisioned, naming the missing variables, which replaces a live agent dying inside the harness with "Not logged in". Only the *unset* default walks the file's `primary` preference order (subscription first, then the API key — exactly what `config.ts` did before lanes, now written where a human can read it); an explicit choice, from the settings screen or `AGENT_LANE`, is honoured even when it is broken, because routing around an operator's choice is how a fleet spends money nobody authorised. The tier→id map moving into the lane is why `resolveAgentModel` became `resolveAgentModelChoice`, stopping at the tier: the tier is the durable human choice, and what it *means* now belongs to the endpoint being called
- The harness adapter seam (issue #172) is `src/lib/harness/` — `buildExecEnv`, `buildCommand`, `createOutputHandler`, chosen because those three were already pure and already tested. **One adapter ships** (`claude-code`); the interface is reviewed against what an OpenCode or Codex adapter would need, which is why nothing in it names a vendor: a lane hands over `auth` as `harness variable → value`, and the *adapter* owns `baseUrlEnvVar` (a lane knows which endpoint, an adapter knows how to be told). `container-manager.ts` is harness-agnostic below it — `execAgentTurn` runs whatever command and environment the adapter built. Two security facts carry forward and are pinned by tests: no model-provider credential is in the **persistent** container environment (`ANTHROPIC_API_KEY` used to be, and is not any more — the `anthropic-api` lane supplies it per exec), and `ghToken` stays null for every autonomous pass kind

- Restart recovery (issue #24): boot marks claimed/implementing/reviewing runs that own a `running` task as `interrupted` (a run holding a stored review verdict is left for the verdict path instead; gated/blocked runs wait on a human, not a lost turn). The sweep then re-claims the ticket **without** consuming an attempt — interruptions are counted from `interrupted` ledger rows, separately from failed attempts, and bounded by `MAX_INTERRUPTIONS_PER_TICKET` (5, in `budgets.ts`); past the bound the ticket is routed `ready-for-human` like exhaustion. The reaper never removes a container whose task belongs to a live run. Boot also **finalizes dangling runs** (issue #106): a run left non-terminal with no PR, no stored verdict, and all tasks terminal is driven to `failed` so a pre-fix ghost `running` card self-heals on the next restart — the durable fix drives such runs terminal at pass completion in `decideNext` (`finalizeEmptyPass`), this only backfills runs stranded before it landed

- Run migrations: `npx drizzle-kit push`
- **Adding a generated migration:** set the new journal entry's `when` to at
  least one day past the prior entry's (drizzle skips same-day entries it
  believes it has applied), and `rm local.db*` before running tests — a stale
  local DB makes the runs-ledger and parallel-worker migration tests fail on
  code that is actually correct
- Generate migrations: `npx drizzle-kit generate`
- DB client: `import { db } from "@/db"`

## Development

```bash
pnpm dev          # Start dev server
pnpm build        # Production build
pnpm lint         # Run ESLint
```

`pnpm lint` fails on `main` with pre-existing errors (known baseline). Lint
only the files you changed — don't fix or be blocked by baseline errors in
files you didn't touch.

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
