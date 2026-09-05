import { int, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

import type { SettingsOverrides } from "../lib/settings-resolver";
import type { StoredTriageResult } from "../lib/orchestrator/autonomy/triage";

// Generation-session skills (issue #61): the estate's ticket-loop generation
// half, runnable from an interactive session. The single source of truth for
// the runtime list — the DB column enum, the task-creation API's validation,
// and the fleet dashboard's own decoupled union all answer to this tuple.
export const SESSION_SKILLS = [
  "grill-me",
  "grill-with-docs",
  "triage",
  "to-spec",
  "to-tickets",
  "wayfinder",
] as const;

export type SessionSkill = (typeof SESSION_SKILLS)[number];

/**
 * A generation session is an interactive task running one of the estate's
 * generation skills (issue #61): kind stays `interactive`, and the non-null
 * sessionSkill is what distinguishes it from an ordinary chat task and from the
 * autonomous `kind=triage` pass. This predicate is the single definition of the
 * concept — issue #62 keys the per-exec `gh` token off it, so that a token able
 * to create issues (and therefore apply the launch-button label) only ever
 * reaches an attended session, never an unattended implement/review/triage exec.
 */
export function isGenerationSession(task: {
  kind: string;
  sessionSkill: SessionSkill | null;
}): boolean {
  return task.kind === "interactive" && task.sessionSkill !== null;
}

/** The one row id in `settings` — the estate runs a single fleet, so fleet-wide
 * operator state is one durable row, not a table of them. */
export const SETTINGS_ROW_ID = "fleet";

/**
 * Fleet-wide operator settings (issue #118): durable state a human flips while
 * the orchestrator runs, as opposed to env config (`src/lib/config.ts`), which
 * is fixed at boot. Exactly one row — id = SETTINGS_ROW_ID — written on demand,
 * so a fresh install and an upgraded one read the same defaults.
 */
export const settings = sqliteTable("settings", {
  id: text("id").primaryKey(),
  // The global autonomy kill switch: while engaged no sweep claims new work —
  // no implement pickup, no triage pass. It is the *runtime* pause layered on
  // top of the AUTONOMY_ENABLED boot master (false there and sweeps never start
  // at all), so it takes effect at the next sweep tick with no restart.
  // In-flight runs, gating and review are deliberately unaffected, exactly as
  // with the daily spend cap's pause.
  globalAutonomyPaused: int("global_autonomy_paused", { mode: "boolean" })
    .notNull()
    .default(false),
  // UI-set overrides of env config (issue #166), as a sparse JSON object keyed
  // by setting name — absent means "fall through to the environment default",
  // which is the state a fresh install is in and why nothing is seeded here.
  // Deliberately one JSON column rather than a column per setting: the fields
  // are a version-controlled allowlist in `settings-resolver.ts`, so adding one
  // is a code change there and not a migration, and an override retired by a
  // later version is dropped on read rather than left as a dead column.
  // Read through `sanitizeOverrides` — never trusted verbatim, because this is
  // JSON written by an older build of the app.
  overrides: text("overrides", { mode: "json" }).$type<SettingsOverrides>(),
  // When a human last confirmed that the fleet may spend real money (issue
  // #174). The confirm-once-per-day gate compares this against the local day:
  // the first metered spend of a day needs one press, and everything after it
  // that day proceeds automatically until the real-money cap.
  //
  // Durable, and a column rather than an in-memory flag, for the reason the
  // kill switch is: a restart must not re-ask (the fleet would sit held until
  // someone noticed) and must not silently forget that nobody ever asked. A
  // timestamp rather than a day string so the screen can say *when* it was
  // confirmed; the day comparison is the reader's (`sameLocalDay`).
  meteredSpendConfirmedAt: int("metered_spend_confirmed_at", {
    mode: "timestamp_ms",
  }),
  updatedAt: int("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  githubRepo: text("github_repo"),
  gitUrl: text("git_url"),
  dopplerToken: text("doppler_token"),
  discordChannelId: text("discord_channel_id"),
  autonomyEnabled: int("autonomy_enabled", { mode: "boolean" })
    .notNull()
    .default(false),
  // Cached result of the last autonomy preflight; null = never checked
  preflightStatus: text("preflight_status", {
    enum: ["passing", "failing"],
  }),
  preflightReason: text("preflight_reason"),
  createdAt: int("created_at", { mode: "timestamp_ms" }).notNull(),
});

// One row per attempt at one ticket. Tasks remain the container-and-
// conversation unit; a run owns one or more of them. Interactive tasks have
// no run, which is what exempts them from the daily autonomous spend cap.
export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id),
  githubIssue: text("github_issue").notNull(), // owner/repo#n
  attempt: int("attempt").notNull(),
  mode: text("mode", { enum: ["autonomous", "supervised"] }).notNull(),
  status: text("status", {
    enum: [
      "claimed",
      "implementing",
      "reviewing",
      "gated",
      "blocked",
      "merged",
      "failed",
      "exhausted",
      "interrupted",
      // Parked on the account's quota clock (issue #168): the pass was
      // *rejected* on the account-wide rate-limit window, which is not a
      // failure of the work and must not be counted as one. Non-terminal, and
      // deliberately the run's own status rather than a flag on another:
      // everything that gathers work reads `status`, so a paused run leaves
      // every pipeline by the same door it left `implementing` by, and boot
      // recovery leaves it alone exactly as it leaves `gated`/`blocked` — it
      // is waiting on a clock, not on a lost turn.
      "rate_limited",
      "cancelled",
    ],
  })
    .notNull()
    .default("claimed"),
  budgetUsd: real("budget_usd").notNull(),
  // Per-exec turn limit from a ticket's max-turns directive; null = default
  maxTurns: int("max_turns"),
  // Execution lane the implement pass ran on (issue #172) — the id of a lane
  // declared in `lanes.yaml`. Recorded so a run's spend stays interpretable:
  // the same dollar figure means subscription quota on one lane and real money
  // on another, and without the lane there is no way to tell them apart after
  // the fact. Set when the implement pass starts; null for a run that predates
  // lanes, and for an interactive task (which has no run row at all).
  lane: text("lane"),
  // Who paid for that lane (issue #174) — recorded beside the id rather than
  // looked up from `lanes.yaml` at read time, because the file is
  // version-controlled configuration that changes under a deployment: a lane
  // retired or re-pointed at a different provider would silently rewrite the
  // billing history of every past run. The ledger's job is to say what was
  // true when the work ran. Null for a run that predates lanes.
  laneBilling: text("lane_billing", { enum: ["subscription", "metered"] }),
  // The harness adapter the implement pass ran on (issue #223) — the id the
  // resolved lane named (`claude-code`, ...), stamped when the pass starts and
  // rewritten by each later implement pass of the attempt (a continuation
  // after a lane move is one), so a run that moved lanes across adapters
  // reads as the harness that did the work last. A repair pass leaves it
  // alone exactly as it leaves `model`: it consumes no attempt and its
  // changes are not what the verdict judged, and the harness it ran on is on
  // its own task row. Its own column beside `lane`, and never inferred
  // from the lane id later: `lanes.yaml` is version-controlled configuration
  // that changes under a deployment, and a lane re-pointed at another harness
  // would silently rewrite which vendor ran every past attempt — the one
  // question outcome-by-harness exists to answer. Null for a run written
  // before the column existed, which the surfaces read as "unknown harness"
  // rather than attributing it to any adapter.
  harness: text("harness"),
  // Model the implement pass ran on (issue #74), so this run's spend is
  // interpretable against its tier. A ticket's `model:` directive (issue #80)
  // pins it from claim time; otherwise it is set when the implement pass
  // starts. Null means AGENT_MODEL was unset (no directive) and the CLI
  // resolved the account default.
  //
  // Holds a *tier* (`heavy`/`standard`/`light`) since lanes (issue #172), not
  // the identifier it resolved to — the column is read back as the run's
  // directive on every later pass of the same attempt, and a lane-specific
  // identifier names no tier, so storing one would drop the directive. Read
  // it beside `lane` to recover the identifier. The one exception is an
  // environment that pins a raw model id naming no tier: that is stored
  // verbatim, because there is no tier to store.
  model: text("model"),
  // Reasoning-effort level the implement pass ran at (issue #81) — the other
  // half of the cost/quality dial alongside model. A ticket's `effort:`
  // directive pins it from claim time; otherwise it is set when the implement
  // pass starts. Null means AGENT_EFFORT was unset (no directive) and the CLI
  // resolved its own default.
  effort: text("effort"),
  // The tier this run was *asked* for, once the quota degrade ladder has moved
  // it off that tier (issue #170). Null on every run still running at the tier
  // it was given, which is what makes "is this run degraded?" one non-null
  // check; set on the first step down and never rewritten, so a run that has
  // walked heavy -> standard -> light still reads as "asked for heavy".
  //
  // Two columns rather than one because `model` has to keep meaning "the tier
  // that actually ran" — it is what the run's spend is read against, and what
  // every later pass of the same attempt resolves through — so the requested
  // tier needs somewhere of its own to live rather than overwriting it.
  degradedFrom: text("degraded_from"),
  // The tier the ticket's own Workflow section declared, as parsed at claim
  // (issue #198) — null when it declared none. Written once, at claim, and
  // never rewritten. `model` cannot answer this: the implement pass writes the
  // *resolved* tier there (so the ladder has a rung to step off and every later
  // pass resolves through it), and from that moment a fleet default is
  // indistinguishable from a declaration. Tier coverage — the fraction of
  // claims that carried a declared tier — is read from this column alone;
  // which tier actually ran stays `model`'s to say.
  declaredTier: text("declared_tier"),
  // The version of the estate's skills (`mattpocock/skills`) the run's first
  // pass ran with (issue #60) — the forensic trail for "what skill version
  // ran?". Since issue #215 it is the git ref pinned into the agent image at
  // build (e.g. `v1.2.3`), lifted off the image's label as the container is
  // created; before that it was the plugin version the container's own setup
  // resolved (e.g. `1.2.0`). Recorded when the run's first pass starts; null
  // for a run whose container predates this, or an interactive task (which has
  // no run row at all).
  skillsVersion: text("skills_version"),
  totalCostUsd: real("total_cost_usd").notNull().default(0),
  pullRequestNumber: int("pull_request_number"),
  pullRequestUrl: text("pull_request_url"),
  // Review-gate categories matched by the PR's changed paths; empty = ungated
  gateCategories: text("gate_categories", { mode: "json" })
    .$type<string[]>()
    .notNull()
    .default([]),
  // The last verdict the orchestrator POSTED to GitHub for this run
  reviewVerdict: text("review_verdict", {
    enum: ["approve", "request-changes", "escalate"],
  }),
  // A finished review pass's parsed output, held until the orchestrator has
  // acted on it (posted the review / escalated / notified), then cleared.
  // Stored on the run so a verdict survives an orchestrator restart.
  reviewResult: text("review_result", { mode: "json" }).$type<
    | { kind: "approve" | "request-changes" | "escalate"; body: string }
    // `retryable: false` marks an unparseable verdict the format-retry must not
    // be spent on (issue #220) — mirrors `ReviewVerdictResult` in verdict.ts.
    | { kind: "unparseable"; reason: string; retryable?: false }
  >(),
  // The PR head the last posted verdict was written about (issue #131). Set
  // alongside reviewVerdict when the orchestrator posts a review, and cleared
  // wherever the verdict is. Without it there was no record of *which* commit
  // was reviewed, so a push by anyone but the loop's own repair path left the
  // approval standing over code nobody read — and an armed run auto-merged it.
  // A parked run whose PR head has moved past this SHA is re-gated and
  // re-reviewed (or, once its cycles are spent, handed to a human).
  reviewedHeadSha: text("reviewed_head_sha"),
  reviewCycleCount: int("review_cycle_count").notNull().default(0),
  // Times a review pass produced an unparseable verdict this attempt (issue
  // #89). A pure format slip — a substantively fine review whose final message
  // just didn't lead with a VERDICT: line — buys one bounded re-queue with the
  // parse failure fed back into the prompt, rather than costing a human
  // intervention. Past MAX_UNPARSEABLE_REVIEW_RETRIES the verdict fails closed
  // as before. Counted per attempt (never reset across review cycles).
  reviewUnparseableCount: int("review_unparseable_count").notNull().default(0),
  // Repair passes run to resolve a CONFLICTING PR (issue #54). Counted per
  // conflict episode — reset to 0 once the PR is observed mergeable again, so
  // a fresh conflict earns fresh repairs; past MAX_INTEGRATION_ATTEMPTS a
  // still-conflicting PR escalates to a human. Never consumes an attempt.
  integrationCount: int("integration_count").notNull().default(0),
  // CI-repair passes run to make a red check rollup green (issue #130). Counted
  // per failure episode — reset to 0 once the rollup is observed green, so an
  // unrelated later failure earns its own repair; past MAX_CI_REPAIR_ATTEMPTS a
  // still-failing PR escalates to a human. Deliberately separate from
  // integrationCount: a conflict repair followed by a CI failure must not
  // escalate on a spent count. Never consumes an attempt.
  ciRepairCount: int("ci_repair_count").notNull().default(0),
  interruptionCount: int("interruption_count").notNull().default(0),
  // When a `rate_limited` run may be tried again (issue #168) — the reset time
  // the CLI's own `rate_limit_event` reported, stored verbatim rather than
  // computed from a window length this build would have to guess. Null on
  // every other status: it is set when the run pauses and is the one fact a
  // resume needs. A quota pause consumes neither an attempt nor an
  // interruption, so there is no counter here to bump.
  resumeAfter: int("resume_after", { mode: "timestamp_ms" }),
  // Times this attempt has been resumed after a quota pause (issue #169).
  // Bounded by the resume bound (settable in the UI, `MAX_RESUMES_PER_ATTEMPT`
  // otherwise): past it the ticket routes to `ready-for-human` the way
  // exhaustion does, so a pathological ticket cannot loop across quota windows
  // forever. Deliberately its own counter and not `attempt` or
  // `interruptionCount` — a pause spends neither, and a bound that measured
  // one of those would change what those two numbers mean.
  resumeCount: int("resume_count").notNull().default(0),
  blockedQuestion: text("blocked_question"),
  // A checkpoint: directive's text, stored at claim time. Non-null makes the
  // run supervised: its gate decision is forced to human-signoff regardless
  // of glob matches, and the text names the decision waiting for the owner.
  checkpoint: text("checkpoint"),
  // Why a failed attempt failed (budget/turn exhaustion, container error,
  // review cycles) — human-readable, surfaced in the exhaust summary
  failureReason: text("failure_reason"),
  claimedAt: int("claimed_at", { mode: "timestamp_ms" }).notNull(),
  startedAt: int("started_at", { mode: "timestamp_ms" }),
  finishedAt: int("finished_at", { mode: "timestamp_ms" }),
});

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  status: text("status", {
    enum: ["queued", "running", "blocked", "completed", "failed", "cancelled"],
  })
    .notNull()
    .default("queued"),
  githubIssue: text("github_issue"),
  kind: text("kind", {
    enum: ["interactive", "implement", "review", "triage", "repair"],
  })
    .notNull()
    .default("interactive"),
  // Generation sessions (issue #61): a non-null value makes an interactive task
  // a first-class generation session running one of the estate's generation
  // skills. Null = an ordinary chat task. Kind stays `interactive` and no run
  // row exists, so spend-cap exemption and the autonomy reducer are unchanged
  // by construction. Distinct from the autonomous `kind=triage` pass: a
  // `sessionSkill=triage` session is a human-driven, runless triage.
  sessionSkill: text("session_skill", { enum: SESSION_SKILLS }),
  // The GitHub issue a session is anchored to (owner/repo#n), passed through so
  // the session can open with the issue as context. Deliberately separate from
  // `githubIssue`, which drives implement-lifecycle machinery (issue comments,
  // a `Closes #n` draft PR) that an anchored generation session must not
  // trigger.
  sessionIssue: text("session_issue"),
  runId: text("run_id").references(() => runs.id),
  // The execution lane this pass ran on, and who paid for it (issues #172,
  // #174). Recorded per task as well as per run because a task is the unit
  // money is actually spent by: a run's lane covers its implement pass, but
  // triage owns no run at all and an interactive session never has one, and
  // the real-money cap has to measure *every* dollar that went through a
  // metered lane today or it is not measuring money. Null for a pass that
  // predates lanes.
  lane: text("lane"),
  laneBilling: text("lane_billing", { enum: ["subscription", "metered"] }),
  // The harness adapter this pass ran on (issue #223), stamped from the
  // resolved lane when the pass starts (a follow-up turn re-records it, as it
  // does the lane). Per task as well as per run because the task is the unit
  // work is done by: a run that moved lanes across adapters owns a pass on
  // each, and attributing its spend per pass is what lets "is the cheaper
  // vendor costing me attempts?" be answered from the ledger. Null for a pass
  // written before the column existed — read as "unknown harness", never
  // looked up from the lane id (see `runs.harness`).
  harness: text("harness"),
  // The model tier this pass ran at (issue #173) — `heavy`/`standard`/`light`,
  // or a raw model id for an environment that pins one (naming no tier).
  // Recorded beside the lane for the same reason the lane is recorded beside
  // the cost: the tier is what makes a figure interpretable, and a lane's
  // tier→identifier map is version-controlled configuration that changes under
  // a deployment. A run carries both already; a task is where interactive
  // spend lives, and interactive work is the only kind that crosses onto a
  // paid lane, so without this column the one dollar figure the fleet cannot
  // account for is the one it spent real money on. Null for a pass that
  // predates this, and for one whose harness resolved its own default.
  tier: text("tier"),
  containerId: text("container_id"),
  branch: text("branch"),
  sessionId: text("session_id"),
  // The pass this one continued past a quota wall — resumed off a pause (issue
  // #169) or retried a tier lower (issue #170). Either is a *new* task row for
  // the same attempt, so lineage is what makes "the same pass, continued" a
  // fact rather than a guess — and it is what the attempt's
  // budget follows, so a resumed pass keeps spending the allowance its
  // predecessor started on rather than being handed a fresh one. The run
  // cannot answer this: it also owns review passes with their own allowance,
  // and it may own two *distinct* repair passes, each entitled to its own.
  // Null for every pass that is not a resume.
  resumedFromTaskId: text("resumed_from_task_id"),
  containerStatus: text("container_status", {
    enum: ["setup", "running", "idle", "completing"],
  }),
  totalCostUsd: real("total_cost_usd").notNull().default(0),
  // A finished triage pass's parsed exit, held until the sweep has applied
  // it (comment, advisory labels, recommendation). Stored on the task —
  // triage owns no run — so an exit survives an orchestrator restart
  // without re-running the pass. The issue's needs-triage label is the
  // "acted on" latch: once removed, the result is no longer gathered.
  // The shape is the parser's own (`StoredTriageResult`), with the tier
  // optional because rows written before issue #200 carry no key; the one
  // reader that turns a row back into a result coalesces it.
  triageResult: text("triage_result", { mode: "json" }).$type<StoredTriageResult>(),
  // The tier a finished triage pass suggested for the issue's *work* (issue
  // #200) — `heavy`/`standard`/`light`, or null when the exit named none. Its
  // own column beside the exit because the two have different lifetimes: the
  // exit is consumed when the sweep applies it (so a re-labelled issue gets a
  // fresh pass rather than a replay), while the suggestion has to outlive
  // that and be read at *claim*, which may come hours later on a human's
  // label click or Discord "yes". It is advice, never authority: the claim
  // applies it only where the ticket body states no `model:` directive.
  triageTier: text("triage_tier"),
  devPort: int("dev_port"),
  containerName: text("container_name"),
  previewSubdomain: text("preview_subdomain"),
  pullRequestNumber: int("pull_request_number"),
  pullRequestUrl: text("pull_request_url"),
  discordMessageId: text("discord_message_id"),
  createdAt: int("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: int("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.id),
  role: text("role", { enum: ["user", "agent", "system"] }).notNull(),
  content: text("content").notNull(),
  type: text("type", {
    enum: ["text", "tool_use", "tool_result", "system"],
  })
    .notNull()
    .default("text"),
  deliveredAt: int("delivered_at", { mode: "timestamp_ms" }),
  createdAt: int("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: int("updated_at", { mode: "timestamp_ms" }),
});

/**
 * The last observed quota state **per execution lane** (issue #167, made
 * per-lane by #175): what the Claude Code CLI's `rate_limit_event` said, the
 * last time a pass on that lane saw one.
 *
 * A table rather than a column on `settings` because the two have opposite
 * lifecycles — `settings` is state a human flips and stamps `updatedAt` when
 * they do, and folding an observation written on every API attempt into that
 * row would make the settings screen's "last changed" report the fleet's
 * traffic instead of the operator's last press.
 *
 * A row rather than the in-memory stores the sweep's observations use
 * (`fleet/health-store.ts` and friends): a quota window is five hours or seven
 * days, far longer than the gap between two deploys, so an observation that
 * did not survive a restart would be lost exactly when it mattered — and the
 * writer (the stream parser, in the orchestrator's module graph) and the
 * reader (the dashboard's route handler, in the app-router's) do not share
 * module state at all (issue #159).
 *
 * The observation itself is one JSON column for #166's reason: the wire shape
 * already carries two fields the CLI's own schema does not document, so a later
 * ticket reading one more of them should be a code change and not a migration.
 * Written by `lib/quota/quota-store.ts`, which never trusts it verbatim on read.
 *
 * Keyed by lane rather than by the fleet (issue #175) because a rate limit is a
 * fact about one account at one provider, and the lanes do not share one. The
 * unified-window machinery is subscription-only (#165's finding 6, re-confirmed
 * against OpenRouter on 2026-09-02: no `anthropic-ratelimit-*` response header,
 * no `rate_limit_event` anywhere on the stream), so a metered lane has *no*
 * observation, permanently. Under one fleet-wide row, the fleet's last
 * subscription reading would stand as the current state of a lane that cannot
 * produce one — which is exactly how a lane bounded by spend would come to be
 * gated by somebody else's wall.
 */
/**
 * Real money spent per local day (issue #174), one row per day the fleet has
 * charged a card.
 *
 * A ledger rather than a sum over tasks, because a task's `totalCostUsd` is a
 * *running total* with no day in it: a chat session opened on Monday and driven
 * all week carries one figure, and any attempt to attribute it to a day —
 * creation, last update — is a guess that either under-counts (spending past
 * the cap) or double-counts (holding the fleet over money it did not spend
 * today). What is unambiguous is the **delta** at the moment a turn's cost
 * lands, and the lane that turn ran on, so that is what is written here.
 *
 * Keyed by the local day (`YYYY-MM-DD`), which is the reset every other daily
 * figure here answers to. Rows are tiny and never rewritten once the day turns,
 * so the history stays readable — the daily digest reports the day it covers
 * rather than the day it is sent on.
 *
 * Written by `recordMeteredSpend` (`src/lib/orchestrator/spend.ts`), which is
 * idempotent by construction: it adds `new total - old total`, so writing the
 * same total twice adds nothing.
 */
export const meteredSpend = sqliteTable("metered_spend", {
  /** Local calendar day, `YYYY-MM-DD`. */
  day: text("day").primaryKey(),
  usd: real("usd").notNull().default(0),
  updatedAt: int("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const quotaState = sqliteTable("quota_state", {
  /** The execution-lane id the observation was made on — `lanes.yaml`'s own
   * vocabulary, so a renamed lane simply reads as never-observed rather than as
   * somebody else's quota. */
  lane: text("lane").primaryKey(),
  observation: text("observation", { mode: "json" }).notNull(),
  observedAt: int("observed_at", { mode: "timestamp_ms" }).notNull(),
});
