import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Client } from "discord.js";
import {
  DISCORD_REST_TIMEOUT_MS,
  notifyTaskIdle,
  setBotClient,
} from "../notifications";

/**
 * Discord notifications are best-effort — every helper swallows its own failure
 * — but "best-effort" has to mean *settling* (issue #151). The idle notification
 * is awaited inside the promise that holds a queue reservation, so one that
 * never came back is one more way to wedge dispatch. @discordjs/rest aborts a
 * single HTTP attempt after 15s, but nothing above it is bounded: it waits out
 * rate limits, retries, and `sendWithRetry` retries again on top.
 */

const IDLE_TASK = {
  id: "01M09V20FC15BBT7JNSDPM9QXS",
  title: "Grill the fleet dashboard",
  summary: "Asked three questions.",
  branch: "agent/01M09V20FC15BBT7JNSDPM9QXS",
};

/** A bot client whose REST calls never answer. `stalls` says which layer. */
function stalledClient(stalls: "channel-fetch" | "send"): Client {
  const channel = {
    isTextBased: () => true,
    send: () =>
      stalls === "send" ? new Promise(() => {}) : Promise.resolve({ id: "sent" }),
  };
  return {
    channels: {
      fetch: () =>
        stalls === "channel-fetch"
          ? new Promise(() => {})
          : Promise.resolve(channel),
    },
  } as unknown as Client;
}

describe("Discord notifications are bounded", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    setBotClient(null as unknown as Client);
  });

  it("gives up on a channel lookup that never answers", async () => {
    setBotClient(stalledClient("channel-fetch"));

    const pending = notifyTaskIdle("channel-1", IDLE_TASK);
    await vi.advanceTimersByTimeAsync(DISCORD_REST_TIMEOUT_MS);

    await expect(pending).resolves.toBeNull();
  });

  it("gives up on a send that never answers, retries included", async () => {
    setBotClient(stalledClient("send"));

    const pending = notifyTaskIdle("channel-1", IDLE_TASK);
    // Three attempts, each bounded, with backoff between them.
    await vi.advanceTimersByTimeAsync(DISCORD_REST_TIMEOUT_MS * 3 + 3_000);

    await expect(pending).resolves.toBeNull();
  });

  it("leaves a prompt notification alone", async () => {
    setBotClient(stalledClient("nothing" as "send"));

    await expect(notifyTaskIdle("channel-1", IDLE_TASK)).resolves.toBe("sent");
  });
});
