import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "@/db/schema";

const MIGRATIONS_DIR = path.join(process.cwd(), "drizzle");

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  return { db, sqlite };
}

describe("runs ledger schema (fresh from-migrations DB)", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    db = createTestDb().db;
    db.insert(schema.projects)
      .values({ id: "p1", name: "Test", createdAt: new Date() })
      .run();
  });

  it("applies defaults to a minimal run insert", () => {
    db.insert(schema.runs)
      .values({
        id: "r1",
        projectId: "p1",
        githubIssue: "owner/repo#13",
        attempt: 1,
        mode: "autonomous",
        budgetUsd: 20,
        claimedAt: new Date(),
      })
      .run();

    const run = db.select().from(schema.runs).get()!;
    expect(run.status).toBe("claimed");
    expect(run.totalCostUsd).toBe(0);
    expect(run.gateCategories).toEqual([]);
    expect(run.reviewVerdict).toBeNull();
    expect(run.reviewCycleCount).toBe(0);
    expect(run.interruptionCount).toBe(0);
    expect(run.blockedQuestion).toBeNull();
    expect(run.pullRequestNumber).toBeNull();
    expect(run.pullRequestUrl).toBeNull();
    expect(run.startedAt).toBeNull();
    expect(run.finishedAt).toBeNull();
  });

  it("round-trips a fully populated run", () => {
    const claimedAt = new Date(2026, 7, 1, 9, 0, 0);
    const startedAt = new Date(2026, 7, 1, 9, 0, 30);
    const finishedAt = new Date(2026, 7, 1, 9, 45, 0);
    db.insert(schema.runs)
      .values({
        id: "r2",
        projectId: "p1",
        githubIssue: "owner/repo#42",
        attempt: 2,
        mode: "supervised",
        status: "gated",
        budgetUsd: 75,
        totalCostUsd: 13.37,
        pullRequestNumber: 99,
        pullRequestUrl: "https://github.com/owner/repo/pull/99",
        gateCategories: ["migrations", "auth"],
        reviewVerdict: "request-changes",
        reviewCycleCount: 2,
        interruptionCount: 1,
        blockedQuestion: "Which auth provider should this target?",
        claimedAt,
        startedAt,
        finishedAt,
      })
      .run();

    const run = db.select().from(schema.runs).get()!;
    expect(run.mode).toBe("supervised");
    expect(run.status).toBe("gated");
    expect(run.budgetUsd).toBe(75);
    expect(run.totalCostUsd).toBe(13.37);
    expect(run.gateCategories).toEqual(["migrations", "auth"]);
    expect(run.reviewVerdict).toBe("request-changes");
    expect(run.claimedAt).toEqual(claimedAt);
    expect(run.startedAt).toEqual(startedAt);
    expect(run.finishedAt).toEqual(finishedAt);
  });

  it("defaults tasks to kind interactive with no run", () => {
    db.insert(schema.tasks)
      .values({
        id: "t1",
        projectId: "p1",
        title: "Chat task",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();

    const task = db.select().from(schema.tasks).get()!;
    expect(task.kind).toBe("interactive");
    expect(task.runId).toBeNull();
  });

  it("links a task to its run and enforces the foreign key", () => {
    db.insert(schema.runs)
      .values({
        id: "r3",
        projectId: "p1",
        githubIssue: "owner/repo#7",
        attempt: 1,
        mode: "autonomous",
        budgetUsd: 20,
        claimedAt: new Date(),
      })
      .run();
    db.insert(schema.tasks)
      .values({
        id: "t2",
        projectId: "p1",
        title: "Implement pass",
        kind: "implement",
        runId: "r3",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();

    const task = db.select().from(schema.tasks).get()!;
    expect(task.kind).toBe("implement");
    expect(task.runId).toBe("r3");

    expect(() =>
      db
        .insert(schema.tasks)
        .values({
          id: "t3",
          projectId: "p1",
          title: "Dangling run link",
          runId: "no-such-run",
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .run()
    ).toThrow(/FOREIGN KEY/);
  });

  it("defaults projects to autonomy off with no preflight result", () => {
    const project = db.select().from(schema.projects).get()!;
    expect(project.autonomyEnabled).toBe(false);
    expect(project.preflightStatus).toBeNull();
    expect(project.preflightReason).toBeNull();
  });
});

describe("latest migration on a populated previous-head DB (production path)", () => {
  // Simulate the VPS upgrade: a DB migrated to the previous head and holding
  // real rows, then the newest migration applied on top — the scenario that
  // bit migration 0007 (#9).
  const cacheDir = path.join(process.cwd(), "node_modules", ".cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const stagingDir = fs.mkdtempSync(path.join(cacheDir, "migrations-prev-head-"));

  afterAll(() => {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  });

  it("applies additively and backfills defaults on existing rows", () => {
    const journal = JSON.parse(
      fs.readFileSync(path.join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf-8")
    );
    expect(journal.entries.length).toBeGreaterThan(1);
    const previousHead = {
      ...journal,
      entries: journal.entries.slice(0, -1),
    };
    fs.mkdirSync(path.join(stagingDir, "meta"), { recursive: true });
    fs.writeFileSync(
      path.join(stagingDir, "meta", "_journal.json"),
      JSON.stringify(previousHead)
    );
    for (const entry of previousHead.entries) {
      fs.copyFileSync(
        path.join(MIGRATIONS_DIR, `${entry.tag}.sql`),
        path.join(stagingDir, `${entry.tag}.sql`)
      );
    }

    const sqlite = new Database(":memory:");
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    const db = drizzle(sqlite, { schema });

    // Migrate to the previous head and populate it with pre-upgrade rows,
    // via raw SQL since schema.ts describes the *new* schema
    migrate(db, { migrationsFolder: stagingDir });
    sqlite
      .prepare("INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)")
      .run("p1", "Existing project", Date.now());
    sqlite
      .prepare(
        "INSERT INTO tasks (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run("t1", "p1", "Existing task", Date.now(), Date.now());

    // The upgrade: apply the full migrations folder on top
    migrate(db, { migrationsFolder: MIGRATIONS_DIR });

    const project = db.select().from(schema.projects).get()!;
    expect(project.autonomyEnabled).toBe(false);
    expect(project.preflightStatus).toBeNull();

    const task = db.select().from(schema.tasks).get()!;
    expect(task.kind).toBe("interactive");
    expect(task.runId).toBeNull();

    // And the new table is usable
    db.insert(schema.runs)
      .values({
        id: "r1",
        projectId: "p1",
        githubIssue: "owner/repo#13",
        attempt: 1,
        mode: "autonomous",
        budgetUsd: 20,
        claimedAt: new Date(),
      })
      .run();
    expect(db.select().from(schema.runs).all()).toHaveLength(1);
  });
});
