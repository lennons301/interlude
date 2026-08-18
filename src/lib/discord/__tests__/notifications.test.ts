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

/** A bot client whose REST calls never answer at the given layer — or answer
 * promptly when nothing stalls. `sends` counts attempts, so the test can see
 * whether a timed-out send was retried. */
function stubClient(stalls: "channel-fetch" | "send" | "nothing") {
  const sends: number[] = [];
  const channel = {
    isTextBased: () => true,
    send: () => {
      sends.push(sends.length);
      return stalls === "send"
        ? new Promise(() => {})
        : Promise.resolve({ id: "sent" });
    },
  };
  const client = {
    channels: {
      fetch: () =>
        stalls === "channel-fetch"
          ? new Promise(() => {})
          : Promise.resolve(channel),
    },
  } as unknown as Client;
  return { client, sends };
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
    setBotClient(stubClient("channel-fetch").client);

    const pending = notifyTaskIdle("channel-1", IDLE_TASK);
    await vi.advanceTimersByTimeAsync(DISCORD_REST_TIMEOUT_MS);

    await expect(pending).resolves.toBeNull();
  });

  it("gives up on a send that never answers", async () => {
    const { client, sends } = stubClient("send");
    setBotClient(client);

    const pending = notifyTaskIdle("channel-1", IDLE_TASK);
    await vi.advanceTimersByTimeAsync(DISCORD_REST_TIMEOUT_MS);

    await expect(pending).resolves.toBeNull();
    // And does not try again: the abandoned attempt may still be delivered by
    // the library underneath us, so a retry risks two embeds for one event.
    expect(sends).toHaveLength(1);
  });

  it("leaves a prompt notification alone", async () => {
    setBotClient(stubClient("nothing").client);

    await expect(notifyTaskIdle("channel-1", IDLE_TASK)).resolves.toBe("sent");
  });
});
