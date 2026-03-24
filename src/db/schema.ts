import { int, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  githubRepo: text("github_repo"),
  gitUrl: text("git_url"),
  dopplerToken: text("doppler_token"),
  createdAt: int("created_at", { mode: "timestamp_ms" }).notNull(),
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
  containerId: text("container_id"),
  branch: text("branch"),
  sessionId: text("session_id"),
  containerStatus: text("container_status", {
    enum: ["setup", "running", "idle", "completing"],
  }),
  totalCostUsd: real("total_cost_usd").notNull().default(0),
  devPort: int("dev_port"),
  containerName: text("container_name"),
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
