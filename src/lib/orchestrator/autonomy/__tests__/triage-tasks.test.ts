import { describe, it, expect, beforeEach } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb } from "@/test/create-test-db";
import { latestTriageTier } from "../triage-tasks";
import type { Db } from "../review-tasks";

/**
 * The claim-side reader of triage's suggested tier (issue #200), pinned over
 * a real (in-memory, migrated) database. Its writer, `finishTriagePass`, is
 * pinned in `orchestrator/__tests__/triage-pass-completion.test.ts`; the two
 * together are what make the recommendation embed and the run it authorizes
 * name the same tier.
 */

const ISSUE_REF = "owner/repo#34";

let db: Db;
let clock = 0;

function seedTriageTask(opts: {
  status: "completed" | "failed" | "running";
  triageTier?: string | null;
  issueRef?: string;
  kind?: "triage" | "implement";
}): void {
  clock += 60_000;
  db.insert(schema.tasks)
    .values({
      id: `task-${clock}`,
      projectId: "p1",
      title: "Triage",
      kind: opts.kind ?? "triage",
      status: opts.status,
      githubIssue: opts.issueRef ?? ISSUE_REF,
      triageTier: opts.triageTier ?? null,
      createdAt: new Date(clock),
      updatedAt: new Date(clock),
    })
    .run();
}

describe("latestTriageTier (issue #200)", () => {
  beforeEach(() => {
    db = createTestDb().db;
    clock = 0;
    db.insert(schema.projects).values({ id: "p1", name: "Test", createdAt: new Date() }).run();
  });

  it("reads the newest completed pass's suggestion", () => {
    seedTriageTask({ status: "completed", triageTier: "light" });
    seedTriageTask({ status: "completed", triageTier: "heavy" });

    expect(latestTriageTier(db, ISSUE_REF)).toBe("heavy");
  });

  it("lets a newer completed pass that suggested nothing mean the default", () => {
    // A re-triage that omitted the line judged the issue as it now stands;
    // an earlier pass's tier was about an earlier body.
    seedTriageTask({ status: "completed", triageTier: "heavy" });
    seedTriageTask({ status: "completed", triageTier: null });

    expect(latestTriageTier(db, ISSUE_REF)).toBeNull();
  });

  it("skips a pass that died, leaving the last completed judgement standing", () => {
    // A `failed` triage row is one the turn manager's catch wrote for a pass
    // that delivered no exit; the sweep applied its unparseable result
    // fail-closed and named no tier, so it must say nothing here either.
    seedTriageTask({ status: "completed", triageTier: "standard" });
    seedTriageTask({ status: "failed", triageTier: null });
    seedTriageTask({ status: "running" });

    expect(latestTriageTier(db, ISSUE_REF)).toBe("standard");
  });

  it("reads only this issue's triage passes", () => {
    seedTriageTask({ status: "completed", triageTier: "heavy", issueRef: "owner/repo#35" });
    seedTriageTask({ status: "completed", triageTier: "heavy", kind: "implement" });

    expect(latestTriageTier(db, ISSUE_REF)).toBeNull();
  });

  it("re-clamps the stored word to the tier vocabulary", () => {
    seedTriageTask({ status: "completed", triageTier: "sonnet" });
    expect(latestTriageTier(db, ISSUE_REF)).toBe("standard");

    seedTriageTask({ status: "completed", triageTier: "claude-opus-4-8" });
    expect(latestTriageTier(db, ISSUE_REF)).toBeNull();
  });
});
