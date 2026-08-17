import { describe, expect, it } from "vitest";
import {
  composerState,
  isTerminalTaskStatus,
  queuedCount,
  resolvePrimary,
  type ComposerPhase,
} from "../composer";

const state = (
  taskStatus: string,
  containerStatus: string | null,
  queued = 0
) => composerState({ taskStatus, containerStatus, queued });

describe("composerState — what the agent is doing", () => {
  const cases: Array<[string, string | null, ComposerPhase]> = [
    ["queued", null, "waiting"],
    ["running", null, "starting"],
    ["running", "setup", "starting"],
    ["running", "running", "working"],
    ["running", "idle", "idle"],
    ["running", "completing", "closing"],
    // A parked run's container is stopped, so its status says nothing — the
    // task's own status is what makes this a question waiting on the owner.
    ["blocked", "idle", "blocked"],
    ["blocked", null, "blocked"],
    ["completed", "idle", "closed"],
    ["failed", null, "closed"],
    ["cancelled", null, "closed"],
  ];

  for (const [taskStatus, containerStatus, phase] of cases) {
    it(`${taskStatus}/${containerStatus ?? "no container"} is ${phase}`, () => {
      expect(state(taskStatus, containerStatus).phase).toBe(phase);
    });
  }
});

describe("composerState — what the composer allows", () => {
  it("takes a message while the agent is working, to be queued behind the turn", () => {
    const working = state("running", "running");

    expect(working.accepting).toBe(true);
    expect(working.placeholder).toContain("queued");
    // Telling a working agent to "continue" is noise, so an empty draft is not
    // sendable until it falls idle.
    expect(working.allowsContinue).toBe(false);
  });

  it("takes an answer to a blocked run, but not a bare continue", () => {
    const blocked = state("blocked", null);

    expect(blocked.accepting).toBe(true);
    expect(blocked.allowsContinue).toBe(false);
  });

  it("takes nothing before the task has started or once it is closing", () => {
    expect(state("queued", null).accepting).toBe(false);
    expect(state("running", "completing").accepting).toBe(false);
    expect(state("completed", null).accepting).toBe(false);
  });

  it("offers completion only between turns", () => {
    expect(state("running", "idle").canComplete).toBe(true);
    expect(state("running", "running").canComplete).toBe(false);
    expect(state("running", "setup").canComplete).toBe(false);
    // The API refuses a task that is not running, so the button must not offer
    // what the server will reject.
    expect(state("blocked", "idle").canComplete).toBe(false);
    expect(state("queued", null).canComplete).toBe(false);
  });

  it("offers a bare continue only when the agent is idle", () => {
    expect(state("running", "idle").allowsContinue).toBe(true);
    expect(state("running", "setup").allowsContinue).toBe(false);
  });
});

describe("composerState — queue feedback", () => {
  it("says nothing about a queue when there isn't one", () => {
    expect(state("running", "running", 0).queuedNote).toBeNull();
  });

  it("counts the owner's undelivered messages", () => {
    expect(state("running", "running", 1).queuedNote).toBe("1 queued");
    expect(state("running", "running", 3).queuedNote).toBe("3 queued");
  });

  it("reports a queue even once the agent has fallen idle", () => {
    // The queue poll delivers on its own cadence, so an idle agent with a
    // message still in hand is a real, brief state — and the honest thing to
    // show is that the message has not landed yet.
    expect(state("running", "idle", 1).queuedNote).toBe("1 queued");
  });
});

describe("isTerminalTaskStatus", () => {
  it("agrees with the phase the state machine reports", () => {
    // The live view gates the whole composer on this predicate, so the two must
    // not drift: everything terminal is `closed`, and nothing else is.
    for (const status of ["queued", "running", "blocked", "completed", "failed", "cancelled"]) {
      expect(state(status, "idle").phase === "closed").toBe(isTerminalTaskStatus(status));
    }
  });
});

describe("queuedCount", () => {
  const row = (role: string, deliveredAt: string | null) => ({ role, deliveredAt });

  it("counts only the owner's undelivered messages", () => {
    expect(
      queuedCount([
        row("user", "2026-08-16T10:00:00.000Z"),
        row("user", null),
        row("user", null),
        row("agent", null), // agent output is never queued
        row("system", null),
      ])
    ).toBe(2);
  });

  it("is zero for an empty transcript", () => {
    expect(queuedCount([])).toBe(0);
  });

  it("treats an undefined delivery as undelivered", () => {
    // A row streamed before the column existed, or serialized without it.
    expect(queuedCount([{ role: "user", deliveredAt: undefined as never }])).toBe(1);
  });
});

describe("resolvePrimary", () => {
  it("sends the draft, trimmed", () => {
    expect(resolvePrimary("  colder  ", true)).toEqual({ label: "send", text: "colder" });
  });

  it("turns an empty draft into an explicit continue where that is offered", () => {
    expect(resolvePrimary("", true)).toEqual({ label: "continue", text: "continue" });
    expect(resolvePrimary("   \n ", true)).toEqual({
      label: "continue",
      text: "continue",
    });
  });

  it("stays a send when continuing is not on offer", () => {
    // Mid-turn the button is disabled anyway; labelling it "continue" would
    // name something the composer will not do.
    expect(resolvePrimary("", false)).toEqual({ label: "send", text: "" });
  });
});
