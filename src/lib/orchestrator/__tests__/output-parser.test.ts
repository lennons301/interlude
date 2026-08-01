import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs";
import path from "path";
import { createOutputHandler } from "../output-parser";

// Use an in-memory SQLite database for tests
// We need to mock the db module before importing the parser
import * as schema from "@/db/schema";
import { createTestDb } from "@/test/create-test-db";

import { vi } from "vitest";

// Create a fresh in-memory DB for each test
let testDb: ReturnType<typeof createTestDb>["db"];

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));

// Load the real fixture captured from Claude Code CLI
const fixturePath = path.join(__dirname, "stream-fixture.ndjson");
const fixtureLines = fs
  .readFileSync(fixturePath, "utf-8")
  .split("\n")
  .filter((l) => l.trim());

describe("output-parser with real Claude Code stream-json", () => {
  const TASK_ID = "test-task-001";

  beforeEach(() => {
    testDb = createTestDb().db;
    // Insert a project and task so foreign keys work
    testDb
      .insert(schema.projects)
      .values({
        id: "test-project",
        name: "Test",
        createdAt: new Date(),
      })
      .run();
    testDb
      .insert(schema.tasks)
      .values({
        id: TASK_ID,
        projectId: "test-project",
        title: "Test task",
        status: "running",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();
  });

  it("parses assistant text messages", () => {
    const handler = createOutputHandler(TASK_ID);

    // Feed all fixture lines
    for (const line of fixtureLines) {
      handler.write(line + "\n");
    }
    const result = handler.flush();

    // Should have created text messages from assistant events
    const msgs = testDb
      .select()
      .from(schema.messages)
      .where(
        require("drizzle-orm").and(
          require("drizzle-orm").eq(schema.messages.taskId, TASK_ID),
          require("drizzle-orm").eq(schema.messages.type, "text")
        )
      )
      .all();

    expect(msgs.length).toBeGreaterThan(0);
    // Verify content is parseable JSON with text field
    for (const msg of msgs) {
      const parsed = JSON.parse(msg.content);
      expect(parsed.text).toBeDefined();
      expect(typeof parsed.text).toBe("string");
      expect(parsed.text.length).toBeGreaterThan(0);
    }
  });

  it("parses tool_use messages from assistant content blocks", () => {
    const handler = createOutputHandler(TASK_ID);

    for (const line of fixtureLines) {
      handler.write(line + "\n");
    }
    handler.flush();

    const msgs = testDb
      .select()
      .from(schema.messages)
      .where(
        require("drizzle-orm").and(
          require("drizzle-orm").eq(schema.messages.taskId, TASK_ID),
          require("drizzle-orm").eq(schema.messages.type, "tool_use")
        )
      )
      .all();

    expect(msgs.length).toBeGreaterThan(0);
    for (const msg of msgs) {
      const parsed = JSON.parse(msg.content);
      expect(parsed.tool).toBeDefined();
      expect(typeof parsed.tool).toBe("string");
    }
  });

  it("updates tool_use messages with tool_result output", () => {
    const handler = createOutputHandler(TASK_ID);

    for (const line of fixtureLines) {
      handler.write(line + "\n");
    }
    handler.flush();

    const msgs = testDb
      .select()
      .from(schema.messages)
      .where(
        require("drizzle-orm").and(
          require("drizzle-orm").eq(schema.messages.taskId, TASK_ID),
          require("drizzle-orm").eq(schema.messages.type, "tool_use")
        )
      )
      .all();

    // At least one tool_use should have output from tool_result
    const withOutput = msgs.filter((m) => {
      const parsed = JSON.parse(m.content);
      return parsed.output !== undefined;
    });
    expect(withOutput.length).toBeGreaterThan(0);
  });

  it("returns session_id and cost from result event", () => {
    const handler = createOutputHandler(TASK_ID);

    for (const line of fixtureLines) {
      handler.write(line + "\n");
    }
    const result = handler.flush();

    expect(result.sessionId).toBeDefined();
    expect(typeof result.sessionId).toBe("string");
    expect(result.sessionId!.length).toBeGreaterThan(0);
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it("fires onDone callback when result event is received", () => {
    const handler = createOutputHandler(TASK_ID);
    let doneFired = false;
    handler.onDone(() => { doneFired = true; });

    // Feed all lines except the result event
    for (const line of fixtureLines.slice(0, -1)) {
      handler.write(line + "\n");
    }
    expect(doneFired).toBe(false);

    // Feed the result event
    handler.write(fixtureLines[fixtureLines.length - 1] + "\n");
    expect(doneFired).toBe(true);
  });

  it("returns the turn's final text message for a turn ending normally", () => {
    const handler = createOutputHandler(TASK_ID);

    for (const line of fixtureLines) {
      handler.write(line + "\n");
    }
    const result = handler.flush();

    expect(result.finalMessage).toBe("The file has **12 lines**.");
  });

  it("returns a blocked question as the final message of a turn ending blocked", () => {
    const handler = createOutputHandler(TASK_ID);

    const blockedTurn = [
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Reading the ticket." }] },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "BLOCKED: Postgres or SQLite for the cache?" },
          ],
        },
      }),
      JSON.stringify({ type: "result", session_id: "s-1", total_cost_usd: 0.02 }),
    ];
    for (const line of blockedTurn) {
      handler.write(line + "\n");
    }
    const result = handler.flush();

    expect(result.finalMessage).toBe("BLOCKED: Postgres or SQLite for the cache?");
  });

  it("returns a null final message for a turn with no text at all", () => {
    const handler = createOutputHandler(TASK_ID);

    handler.write(
      JSON.stringify({ type: "result", session_id: "s-1", total_cost_usd: 0.01 }) + "\n"
    );
    const result = handler.flush();

    expect(result.finalMessage).toBeNull();
  });

  it("handles partial line buffering", () => {
    const handler = createOutputHandler(TASK_ID);

    // Feed a line in chunks
    const resultLine = fixtureLines[fixtureLines.length - 1];
    const mid = Math.floor(resultLine.length / 2);
    handler.write(resultLine.substring(0, mid));
    handler.write(resultLine.substring(mid) + "\n");
    const result = handler.flush();

    expect(result.sessionId).toBeDefined();
    expect(result.costUsd).toBeGreaterThan(0);
  });
});
