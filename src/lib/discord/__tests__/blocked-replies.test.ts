import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test/create-test-db";
import { messages, projects, tasks } from "@/db/schema";
import { resetConfig } from "@/lib/config";

/**
 * A blocked run's answer collected over REST (issue #135, layer 4): the pure
 * selector's table — fresh reply adopted, already-present skipped, unrelated
 * and bot messages skipped — and the executor over a real database with a stub
 * channel, where idempotency and the 👍 are observable.
 */

let testDb: ReturnType<typeof createTestDb>["db"];

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));

import {
  existingAnswers,
  insertDiscordAnswer,
  reconcileBlockedReplies,
  selectRepliesToAdopt,
  type ChannelMessageObservation,
  type ReplyChannelSource,
} from "../blocked-replies";

const Q = "1537457104976085155";

function msg(over: Partial<ChannelMessageObservation> & { id: string }): ChannelMessageObservation {
  return {
    authorIsBot: false,
    content: "Use option B",
    referencedMessageId: Q,
    createdTimestampMs: 1_000,
    ...over,
  };
}

describe("selectRepliesToAdopt", () => {
  it("adopts a fresh human reply to the question", () => {
    const fresh = msg({ id: "r1" });
    expect(
      selectRepliesToAdopt({ questionMessageId: Q, channelMessages: [fresh], existingAnswers: [] })
    ).toEqual([fresh]);
  });

  it("skips a reply already on the task — by Discord message id", () => {
    expect(
      selectRepliesToAdopt({
        questionMessageId: Q,
        channelMessages: [msg({ id: "r1" })],
        existingAnswers: [{ discordMessageId: "r1", text: "something else entirely" }],
      })
    ).toEqual([]);
  });

  it("skips a reply already on the task — by exact text, for rows written before the id was recorded", () => {
    expect(
      selectRepliesToAdopt({
        questionMessageId: Q,
        channelMessages: [msg({ id: "r1", content: "  Use option B \n" })],
        existingAnswers: [{ discordMessageId: null, text: "Use option B" }],
      })
    ).toEqual([]);
  });

  it("skips an unrelated channel message — not a reply, or a reply to something else", () => {
    expect(
      selectRepliesToAdopt({
        questionMessageId: Q,
        channelMessages: [
          msg({ id: "chatter", referencedMessageId: null }),
          msg({ id: "other", referencedMessageId: "999" }),
        ],
        existingAnswers: [],
      })
    ).toEqual([]);
  });

  it("skips a bot message, even one replying to the question", () => {
    expect(
      selectRepliesToAdopt({
        questionMessageId: Q,
        channelMessages: [msg({ id: "bot", authorIsBot: true })],
        existingAnswers: [],
      })
    ).toEqual([]);
  });

  it("skips an empty reply and returns the rest oldest first, once each", () => {
    const later = msg({ id: "r2", content: "and also C", createdTimestampMs: 3_000 });
    const earlier = msg({ id: "r1", createdTimestampMs: 2_000 });
    expect(
      selectRepliesToAdopt({
        questionMessageId: Q,
        channelMessages: [later, msg({ id: "blank", content: "   " }), earlier, later],
        existingAnswers: [],
      })
    ).toEqual([earlier, later]);
  });
});

/** A channel whose history is whatever the test says, recording reactions. The
 * history is handed back as a Map keyed by id, the shape of a discord.js
 * `Collection`, so reading it any way but `.values()` would fail here too. */
function stubSource(history: Array<{
  id: string;
  bot?: boolean;
  content: string;
  replyTo?: string | null;
  at?: number;
}>) {
  const reactions: Array<{ id: string; emoji: string }> = [];
  const fetched: string[] = [];
  const source: ReplyChannelSource = {
    async fetchChannel(channelId) {
      fetched.push(channelId);
      return {
        messages: {
          async fetch() {
            return new Map(
              history.map((m) => [
                m.id,
                {
                  id: m.id,
                  author: { bot: m.bot ?? false },
                  content: m.content,
                  reference:
                    m.replyTo === undefined
                      ? { messageId: Q }
                      : m.replyTo
                        ? { messageId: m.replyTo }
                        : null,
                  createdTimestamp: m.at ?? 1_000,
                  react: async (emoji: string) => {
                    reactions.push({ id: m.id, emoji });
                  },
                },
              ])
            );
          },
        },
      };
    },
  };
  return { source, reactions, fetched };
}

const savedEnv = { ...process.env };

describe("reconcileBlockedReplies", () => {
  let taskId: string;

  beforeEach(() => {
    testDb = createTestDb().db;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.DISCORD_FLEET_CHANNEL_ID = "fleet-chan";
    resetConfig();
    testDb
      .insert(projects)
      .values({ id: "01PROJ", name: "lps", discordChannelId: "proj-chan", createdAt: new Date() })
      .run();
    taskId = "01TASKBLOCKED";
    const now = new Date();
    testDb
      .insert(tasks)
      .values({
        id: taskId,
        projectId: "01PROJ",
        title: "Implement #189",
        description: "",
        status: "blocked",
        kind: "implement",
        discordMessageId: Q,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    resetConfig();
    vi.restoreAllMocks();
  });

  function userRows() {
    return testDb
      .select({ content: messages.content })
      .from(messages)
      .where(eq(messages.taskId, taskId))
      .all()
      .map((r) => JSON.parse(r.content));
  }

  it("adopts the owner's reply the gateway never delivered, as the gateway would have, and reacts 👍", async () => {
    const { source, reactions, fetched } = stubSource([
      { id: "embed", bot: true, content: "", replyTo: null },
      { id: "chatter", content: "unrelated", replyTo: null },
      { id: "r1", content: "Use option B" },
    ]);

    expect(await reconcileBlockedReplies(source)).toBe(1);

    expect(fetched).toEqual(["proj-chan"]); // the project's channel, as parkBlockedRun chose
    expect(userRows()).toEqual([{ text: "Use option B", discordMessageId: "r1" }]);
    expect(reactions).toEqual([{ id: "r1", emoji: "👍" }]);
  });

  it("is idempotent: a second sweep adopts nothing, and neither does the gateway path afterwards", async () => {
    const { source } = stubSource([{ id: "r1", content: "Use option B" }]);
    expect(await reconcileBlockedReplies(source)).toBe(1);
    expect(await reconcileBlockedReplies(source)).toBe(0);
    // The gateway delivering the same message late finds the row and inserts nothing.
    expect(insertDiscordAnswer(taskId, "Use option B", "r1")).toBe(false);
    expect(userRows()).toHaveLength(1);
  });

  it("does not re-deliver a reply the gateway already delivered", async () => {
    // What handleReply writes — with the id, and the pre-#135 shape without it.
    expect(insertDiscordAnswer(taskId, "Use option B", "r1")).toBe(true);
    testDb
      .insert(messages)
      .values({
        id: "01OLDROW",
        taskId,
        role: "user",
        type: "text",
        content: JSON.stringify({ text: "Go with C" }),
        createdAt: new Date(),
      })
      .run();
    const { source } = stubSource([
      { id: "r1", content: "Use option B" },
      { id: "r2", content: "Go with C" },
    ]);

    expect(await reconcileBlockedReplies(source)).toBe(0);
    expect(existingAnswers(taskId)).toEqual([
      { text: "Use option B", discordMessageId: "r1" },
      { text: "Go with C", discordMessageId: null },
    ]);
  });

  it("falls back to the fleet channel for a project with no linked channel", async () => {
    testDb.update(projects).set({ discordChannelId: null }).where(eq(projects.id, "01PROJ")).run();
    const { source, fetched } = stubSource([{ id: "r1", content: "Use option B" }]);

    expect(await reconcileBlockedReplies(source)).toBe(1);
    expect(fetched).toEqual(["fleet-chan"]);
  });

  it("looks at nothing but blocked tasks with a stored question", async () => {
    testDb.update(tasks).set({ status: "running" }).where(eq(tasks.id, taskId)).run();
    const { source, fetched } = stubSource([{ id: "r1", content: "Use option B" }]);

    expect(await reconcileBlockedReplies(source)).toBe(0);
    expect(fetched).toEqual([]);
  });

  it("does nothing without a connected bot", async () => {
    expect(await reconcileBlockedReplies(null)).toBe(0);
  });

  it("survives a channel that cannot be fetched and tries the next sweep", async () => {
    const source: ReplyChannelSource = {
      async fetchChannel() {
        throw new Error("Missing Access");
      },
    };
    expect(await reconcileBlockedReplies(source)).toBe(0);
    expect(userRows()).toEqual([]);
  });
});
