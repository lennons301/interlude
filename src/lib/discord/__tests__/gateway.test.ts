import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Client } from "discord.js";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test/create-test-db";
import { messages, projects, tasks } from "@/db/schema";
import { resetConfig } from "@/lib/config";

/**
 * The gateway instrumentation (issue #135, layers 1 and 2), driven through a
 * fake client: a delivered event advances the inbound clock the watchdog reads,
 * an unrecoverable close is recorded for the watchdog rather than retried, and
 * a handler failure leaves the human a trace — ⚠️ on their message and a system
 * message on the task.
 */

let testDb: ReturnType<typeof createTestDb>["db"];

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));

import { reportDiscordHandlerFailure, startDiscordBot } from "../client";
import { observeDiscordGateway, resetDiscordGatewayHealth } from "../gateway-health";
import { insertDiscordAnswer } from "../blocked-replies";

class FakeClient extends EventEmitter {
  login = vi.fn(async () => "ok");
  destroy = vi.fn(async () => {});
  user = { tag: "interlude#0001" };
  channels = { fetch: vi.fn() };
}

const savedEnv = { ...process.env };

/** Let the async handlers attached to the emitter run to completion. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("Discord gateway instrumentation", () => {
  const clients: FakeClient[] = [];

  beforeEach(() => {
    testDb = createTestDb().db;
    clients.length = 0;
    resetDiscordGatewayHealth();
    process.env.DISCORD_BOT_TOKEN = "token-1";
    resetConfig();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    resetConfig();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function start(): Promise<FakeClient> {
    await startDiscordBot({
      createClient: () => {
        const c = new FakeClient();
        clients.push(c);
        return c as unknown as Client;
      },
    });
    return clients[0];
  }

  it("a received gateway event advances the inbound clock the watchdog reads", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-07T10:00:00Z"));
    const client = await start();
    expect(client.login).toHaveBeenCalledWith("token-1");

    // Nothing is observed until the session is ready.
    expect(observeDiscordGateway()).toBeNull();
    client.emit("clientReady");
    expect(observeDiscordGateway()).toEqual({
      lastOutboundMs: null,
      lastInboundMs: Date.parse("2026-09-07T10:00:00Z"),
      closedSinceMs: null,
      closeCode: null,
    });

    // The bot's own message echoed back is inbound like any other.
    vi.setSystemTime(new Date("2026-09-07T10:03:00Z"));
    client.emit("messageCreate", { author: { bot: true }, content: "" });
    await flush();
    expect(observeDiscordGateway()?.lastInboundMs).toBe(Date.parse("2026-09-07T10:03:00Z"));

    vi.setSystemTime(new Date("2026-09-07T10:04:00Z"));
    client.emit("shardResume", 0, 3);
    expect(observeDiscordGateway()?.lastInboundMs).toBe(Date.parse("2026-09-07T10:04:00Z"));
  });

  it("records an unrecoverable close for the watchdog and does not try to log in again", async () => {
    // In discord.js 14.26 `shardDisconnect` is emitted only for an unrecoverable
    // close code — a configuration error (4014 = disallowed intents) that a
    // re-login with the same token and intents would only repeat, IDENTIFYing
    // toward Discord's daily limit. So: record it, say so, and stop.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-07T10:00:00Z"));
    const client = await start();
    client.emit("clientReady");

    vi.setSystemTime(new Date("2026-09-07T10:05:00Z"));
    client.emit("shardDisconnect", { code: 4014, reason: "", wasClean: true }, 0);
    await flush();

    expect(observeDiscordGateway()).toMatchObject({
      closedSinceMs: Date.parse("2026-09-07T10:05:00Z"),
      closeCode: 4014,
    });
    expect(client.destroy).not.toHaveBeenCalled();
    expect(clients).toHaveLength(1);
    expect(client.login).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("4014 (DisallowedIntents)")
    );

    // A fresh session (after the human fixes the config and restarts) clears it.
    client.emit("clientReady");
    expect(observeDiscordGateway()).toMatchObject({ closedSinceMs: null, closeCode: null });
  });

  it("a recoverable close is logged and left to the library", async () => {
    const client = await start();
    client.emit("shardReconnecting", 0);
    await flush();
    expect(client.destroy).not.toHaveBeenCalled();
    expect(observeDiscordGateway()).toBeNull(); // never became ready; nothing to observe
  });

  it("`invalidated` — never emitted by this discord.js — is logged, not acted on", async () => {
    const client = await start();
    client.emit("invalidated");
    await flush();
    expect(clients).toHaveLength(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("session invalidated"));
  });

  it("marks a reply whose handler threw and records the failure on its task", async () => {
    const now = new Date();
    testDb.insert(projects).values({ id: "01PROJ", name: "p", createdAt: now }).run();
    testDb
      .insert(tasks)
      .values({
        id: "01TASK",
        projectId: "01PROJ",
        title: "t",
        description: "",
        status: "blocked",
        discordMessageId: "question-1",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const react = vi.fn(async () => {});

    await reportDiscordHandlerFailure(
      { id: "reply-1", reference: { messageId: "question-1" }, react },
      new Error("SQLITE_BUSY")
    );

    expect(react).toHaveBeenCalledWith("⚠️");
    const rows = testDb
      .select({ role: messages.role, content: messages.content })
      .from(messages)
      .where(eq(messages.taskId, "01TASK"))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe("system");
    expect(rows[0].content).toContain("could not be processed (SQLITE_BUSY)");
  });

  it("says the reply was recorded when its row exists, rather than asking for it again", async () => {
    const now = new Date();
    testDb.insert(projects).values({ id: "01PROJ", name: "p", createdAt: now }).run();
    testDb
      .insert(tasks)
      .values({
        id: "01TASK",
        projectId: "01PROJ",
        title: "t",
        description: "",
        status: "blocked",
        discordMessageId: "question-1",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    // The row landed; then the 👍 (or anything after) threw.
    insertDiscordAnswer("01TASK", "Use option B", "reply-1");

    await reportDiscordHandlerFailure(
      { id: "reply-1", reference: { messageId: "question-1" }, react: vi.fn(async () => {}) },
      new Error("Missing Permissions")
    );

    const system = testDb
      .select({ content: messages.content })
      .from(messages)
      .where(eq(messages.taskId, "01TASK"))
      .all()
      .map((r) => r.content)
      .filter((c) => !c.startsWith("{"));
    expect(system).toHaveLength(1);
    expect(system[0]).toContain("was recorded and will be delivered");
    expect(system[0]).not.toContain("Nothing was delivered");
  });

  it("a failed 👍 after the row is written is not a handler failure", async () => {
    const now = new Date();
    testDb.insert(projects).values({ id: "01PROJ", name: "p", createdAt: now }).run();
    testDb
      .insert(tasks)
      .values({
        id: "01TASK",
        projectId: "01PROJ",
        title: "t",
        description: "",
        status: "blocked",
        kind: "implement",
        discordMessageId: "question-1",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const client = await start();
    const react = vi.fn(async () => {
      throw new Error("Missing Permissions");
    });
    client.emit("messageCreate", {
      id: "reply-1",
      author: { bot: false },
      content: "Use option B",
      reference: { messageId: "question-1" },
      channelId: "chan",
      react,
    });
    await flush();

    // The row is the delivery — it is there, once, with its id.
    const rows = testDb
      .select({ role: messages.role, content: messages.content })
      .from(messages)
      .where(eq(messages.taskId, "01TASK"))
      .all();
    expect(rows).toEqual([
      { role: "user", content: JSON.stringify({ text: "Use option B", discordMessageId: "reply-1" }) },
    ]);
    // Only the receipt was attempted; no ⚠️, no "reply again".
    expect(react).toHaveBeenCalledTimes(1);
    expect(react).toHaveBeenCalledWith("👍");
  });

  it("wires the failure report into messageCreate", async () => {
    const client = await start();
    const react = vi.fn(async () => {});
    // A message shaped so the handler throws before touching the database.
    client.emit("messageCreate", {
      id: "bad-1",
      author: { bot: false },
      content: 42,
      reference: null,
      react,
    });
    await flush();
    expect(react).toHaveBeenCalledWith("⚠️");
  });
});
