import { int, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

import type { SettingsOverrides } from "../lib/settings-resolver";

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
      "cancelled",
    ],
  })
    .notNull()
    .default("claimed"),
  budgetUsd: real("budget_usd").notNull(),
  // Per-exec turn limit from a ticket's max-turns directive; null = default
  maxTurns: int("max_turns"),
  // Model the implement pass ran on (issue #74), so this run's spend is
  // interpretable against its tier. A ticket's `model:` directive (issue #80)
  // pins it from claim time; otherwise it is set when the implement pass
  // starts. Null means AGENT_MODEL was unset (no directive) and the CLI
  // resolved the account default.
  model: text("model"),
  // Reasoning-effort level the implement pass ran at (issue #81) — the other
  // half of the cost/quality dial alongside model. A ticket's `effort:`
  // directive pins it from claim time; otherwise it is set when the implement
  // pass starts. Null means AGENT_EFFORT was unset (no directive) and the CLI
  // resolved its own default.
  effort: text("effort"),
  // Resolved version of the mattpocock-skills plugin the container installed at
  // start (issue #60) — the forensic trail for "what skill version ran?".
  // Recorded when the run's first pass sets up; null for a run whose container
  // predates this, or an interactive task (which has no run row at all).
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
    | { kind: "unparseable"; reason: string }
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
  containerId: text("container_id"),
  branch: text("branch"),
  sessionId: text("session_id"),
  containerStatus: text("container_status", {
    enum: ["setup", "running", "idle", "completing"],
  }),
  totalCostUsd: real("total_cost_usd").notNull().default(0),
  // A finished triage pass's parsed exit, held until the sweep has applied
  // it (comment, advisory labels, recommendation). Stored on the task —
  // triage owns no run — so an exit survives an orchestrator restart
  // without re-running the pass. The issue's needs-triage label is the
  // "acted on" latch: once removed, the result is no longer gathered.
  triageResult: text("triage_result", { mode: "json" }).$type<
    | { kind: "recommend" | "needs-info" | "ready-for-human"; body: string }
    | { kind: "unparseable"; reason: string }
  >(),
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

/** The one row id in `quota_state` — one account backs the whole fleet, so its
 * quota is one durable row, latest observation wins. */
export const QUOTA_STATE_ROW_ID = "fleet";

/**
 * The fleet's last observed quota state (issue #167): what the Claude Code
 * CLI's `rate_limit_event` said, the last time any pass saw one.
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
 */
export const quotaState = sqliteTable("quota_state", {
  id: text("id").primaryKey(),
  observation: text("observation", { mode: "json" }).notNull(),
  observedAt: int("observed_at", { mode: "timestamp_ms" }).notNull(),
});
