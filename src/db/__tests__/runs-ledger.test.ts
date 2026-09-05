import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "@/db/schema";
import { createTestDb } from "@/test/create-test-db";

const MIGRATIONS_DIR = path.join(process.cwd(), "drizzle");

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
    expect(run.reviewedHeadSha).toBeNull();
    expect(run.reviewCycleCount).toBe(0);
    expect(run.interruptionCount).toBe(0);
    expect(run.blockedQuestion).toBeNull();
    expect(run.pullRequestNumber).toBeNull();
    expect(run.pullRequestUrl).toBeNull();
    expect(run.model).toBeNull();
    expect(run.lane).toBeNull();
    // Stamped at pass start (issue #223), so a claim records no harness yet —
    // and a row from before the column existed reads the same way.
    expect(run.harness).toBeNull();
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
        reviewedHeadSha: "d9d06fc1a2b3c4d5e6f708192a3b4c5d6e7f8091",
        reviewCycleCount: 2,
        interruptionCount: 1,
        blockedQuestion: "Which auth provider should this target?",
        // Since lanes (issue #172) the ledger records which substrate the
        // attempt ran on beside the tier, because the same dollar figure means
        // subscription quota on one lane and real money on another. The tier —
        // not the identifier it resolved to — is what `model` holds, so the
        // run's `model:` directive survives a lane whose ids name no tier.
        lane: "openrouter",
        // The harness the lane ran on (issue #223), stored beside the lane id
        // rather than looked up from it: a lane re-pointed at another harness
        // must not rewrite which vendor ran a past attempt.
        harness: "claude-code",
        model: "heavy",
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
    expect(run.reviewedHeadSha).toBe("d9d06fc1a2b3c4d5e6f708192a3b4c5d6e7f8091");
    expect(run.lane).toBe("openrouter");
    expect(run.harness).toBe("claude-code");
    expect(run.model).toBe("heavy");
    expect(run.claimedAt).toEqual(claimedAt);
    expect(run.startedAt).toEqual(startedAt);
    expect(run.finishedAt).toEqual(finishedAt);
  });

  it("defaults tasks to kind interactive with no run and no session skill", () => {
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
    expect(task.sessionSkill).toBeNull();
    expect(task.sessionIssue).toBeNull();
  });

  it("records a generation session as an interactive task with no run (#61)", () => {
    db.insert(schema.tasks)
      .values({
        id: "t-session",
        projectId: "p1",
        title: "Grill a fresh idea",
        sessionSkill: "grill-me",
        sessionIssue: "owner/repo#61",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();

    const task = db.select().from(schema.tasks).get()!;
    expect(task.kind).toBe("interactive");
    expect(task.runId).toBeNull();
    expect(task.sessionSkill).toBe("grill-me");
    expect(task.sessionIssue).toBe("owner/repo#61");
  });

  it("stamps a pass with the harness that ran it, per task (issue #223)", () => {
    db.insert(schema.runs)
      .values({
        id: "r-moved",
        projectId: "p1",
        githubIssue: "owner/repo#223",
        attempt: 1,
        mode: "autonomous",
        budgetUsd: 20,
        lane: "other-lane",
        harness: "fake-other",
        claimedAt: new Date(),
      })
      .run();
    // A run that moved lanes across adapters owns a pass on each; the ledger
    // keeps both, so the attempt is attributed pass by pass rather than to
    // whichever harness the run row ended on.
    for (const [id, lane, harness] of [
      ["t-first", "fake-lane", "fake"],
      ["t-moved", "other-lane", "fake-other"],
    ] as const) {
      db.insert(schema.tasks)
        .values({
          id,
          projectId: "p1",
          title: "Implement pass",
          kind: "implement",
          runId: "r-moved",
          lane,
          laneBilling: "subscription",
          harness,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .run();
    }

    const passes = db.select().from(schema.tasks).all();
    expect(passes.map((t) => [t.id, t.harness])).toEqual([
      ["t-first", "fake"],
      ["t-moved", "fake-other"],
    ]);
    expect(db.select().from(schema.runs).get()!.harness).toBe("fake-other");
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
    // A queued pass has no harness yet: it is stamped as the pass starts, from
    // the lane it resolves to (issue #223).
    expect(task.harness).toBeNull();

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

describe("migration journal", () => {
  // Drizzle's migrator only applies a migration whose "when" exceeds the last
  // applied row's created_at. 0007 (#9) and 0008 (#13) are future-dated, so a
  // freshly generated migration gets a real timestamp that sorts *before*
  // them and would be silently skipped everywhere. This trips loudly instead:
  // if it fails on your new migration, hand-bump its "when" in
  // drizzle/meta/_journal.json past the previous entry's.
  it("keeps journal timestamps strictly increasing", () => {
    const journal = JSON.parse(
      fs.readFileSync(path.join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf-8")
    ) as { entries: { tag: string; when: number }[] };

    for (let i = 1; i < journal.entries.length; i++) {
      const prev = journal.entries[i - 1];
      const curr = journal.entries[i];
      expect(
        curr.when,
        `${curr.tag} is stamped before ${prev.tag} (${prev.when}) and would be ` +
          `silently skipped by the migrator — bump its "when" past ${prev.when}`
      ).toBeGreaterThan(prev.when);
    }
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

    // Migrate to the previous head and populate it with pre-upgrade rows,
    // via raw SQL since schema.ts describes the *new* schema
    const { db, sqlite } = createTestDb(stagingDir);
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
    // A pass from before the harness column existed carries none (issue
    // #223) — the surfaces read that as "unknown harness", never as a guess
    // from the lane file.
    expect(task.harness).toBeNull();

    // And the new table is usable, harness stamp included
    db.insert(schema.runs)
      .values({
        id: "r1",
        projectId: "p1",
        githubIssue: "owner/repo#13",
        attempt: 1,
        mode: "autonomous",
        budgetUsd: 20,
        harness: "claude-code",
        claimedAt: new Date(),
      })
      .run();
    expect(db.select().from(schema.runs).all()).toHaveLength(1);
    expect(db.select().from(schema.runs).get()!.harness).toBe("claude-code");
  });
});
