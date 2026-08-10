import { int, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
