import { int, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  githubRepo: text("github_repo"),
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
  createdAt: int("created_at", { mode: "timestamp_ms" }).notNull(),
});
