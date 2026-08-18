import { describe, it, expect } from "vitest";
import {
  evaluateFleetHealth,
  EMPTY_FLEET_HEALTH_STATE,
  type FleetHealthInput,
  type FleetHealthState,
  type FleetHealthThresholds,
  type OwedReviewObservation,
} from "../health";

const THRESHOLDS: FleetHealthThresholds = {
  owedReviewStallMs: 30 * 60_000,
  pickupWedgedMs: 3 * 60_000,
  heartbeatStaleMs: 2 * 60_000,
  occupancyDivergedMs: 10 * 60_000,
};

const T0 = new Date(2026, 7, 1, 12, 0, 0).getTime();
const min = (n: number) => n * 60_000;

function baseInput(overrides: Partial<FleetHealthInput> = {}): FleetHealthInput {
  const merged: FleetHealthInput = {
    nowMs: T0,
    owedReviews: [],
    slots: { total: 2, occupied: 0 },
    pickupPausedWithFreeSlot: false,
    queuedDispatchable: [],
    agentContainers: null,
    queueRunning: true,
    queueLastProgressMs: T0,
    ...overrides,
  };
  // Unless a test says otherwise, the daemon corroborates the slot count — so
  // only the tests that mean to exercise a divergence create one.
  return {
    ...merged,
    agentContainers:
      overrides.agentContainers !== undefined
        ? overrides.agentContainers
        : { live: merged.slots.occupied, stopped: 0 },
  };
}

function owed(overrides: Partial<OwedReviewObservation> = {}): OwedReviewObservation {
  return {
    runId: "run-1",
    issueRef: "lennons301/lemons#34",
    prNumber: 55,
    prUrl: "https://github.com/lennons301/lemons/pull/55",
    reason: "a slot is held by an interactive session (1/1 busy)",
    ...overrides,
  };
}

function evaluate(input: FleetHealthInput, prev: FleetHealthState = EMPTY_FLEET_HEALTH_STATE) {
  return evaluateFleetHealth(input, prev, THRESHOLDS);
}

describe("evaluateFleetHealth — owed-review stalled", () => {
  it("does not fire before the threshold, but seeds the since-timer", () => {
    const { signals, announce, state } = evaluate(
      baseInput({ owedReviews: [owed()], slots: { total: 1, occupied: 1 } })
    );
    expect(signals.owedReviewStalls).toEqual([]);
    expect(announce.owedReviewStalls).toEqual([]);
    expect(state.owedReviewSinceMs["run-1"]).toBe(T0);
  });

  it("fires — card + one-time ping — once the review has been owed past the threshold", () => {
    const first = evaluate(
      baseInput({ owedReviews: [owed()], slots: { total: 1, occupied: 1 } })
    );
    // 31 minutes later, still owed, slot still held.
    const { signals, announce } = evaluate(
      baseInput({
        nowMs: T0 + min(31),
        owedReviews: [owed()],
        slots: { total: 1, occupied: 1 },
      }),
      first.state
    );
    expect(signals.owedReviewStalls).toHaveLength(1);
    expect(signals.owedReviewStalls[0]).toMatchObject({
      runId: "run-1",
      prNumber: 55,
      prUrl: "https://github.com/lennons301/lemons/pull/55",
    });
    expect(signals.owedReviewStalls[0].stalledForMs).toBe(min(31));
    // First crossing announces exactly once.
    expect(announce.owedReviewStalls).toHaveLength(1);
  });

  it("keeps the card but does not re-ping on the next stalled sweep", () => {
    const s1 = evaluate(baseInput({ owedReviews: [owed()], slots: { total: 1, occupied: 1 } }));
    const s2 = evaluate(
      baseInput({ nowMs: T0 + min(31), owedReviews: [owed()], slots: { total: 1, occupied: 1 } }),
      s1.state
    );
    const s3 = evaluate(
      baseInput({ nowMs: T0 + min(32), owedReviews: [owed()], slots: { total: 1, occupied: 1 } }),
      s2.state
    );
    expect(s3.signals.owedReviewStalls).toHaveLength(1); // card persists
    expect(s3.announce.owedReviewStalls).toEqual([]); // ping is one-shot
  });

  it("clears the card and re-arms once the run is no longer owed (review landed/finalized)", () => {
    const s1 = evaluate(baseInput({ owedReviews: [owed()], slots: { total: 1, occupied: 1 } }));
    const s2 = evaluate(
      baseInput({ nowMs: T0 + min(31), owedReviews: [owed()], slots: { total: 1, occupied: 1 } }),
      s1.state
    );
    // Review lands: the run drops out of the owed set.
    const cleared = evaluate(baseInput({ nowMs: T0 + min(40), owedReviews: [] }), s2.state);
    expect(cleared.signals.owedReviewStalls).toEqual([]);
    expect(cleared.state.owedReviewSinceMs).toEqual({});
    expect(cleared.state.owedReviewAnnounced).toEqual([]);
    // If it becomes owed again later, its timer restarts (fresh 30-min clock).
    const reArmed = evaluate(
      baseInput({ nowMs: T0 + min(41), owedReviews: [owed()], slots: { total: 1, occupied: 1 } }),
      cleared.state
    );
    expect(reArmed.signals.owedReviewStalls).toEqual([]);
    expect(reArmed.state.owedReviewSinceMs["run-1"]).toBe(T0 + min(41));
  });

  it("times each owed run independently", () => {
    const a = owed({ runId: "run-a", prNumber: 1 });
    const b = owed({ runId: "run-b", prNumber: 2 });
    const s1 = evaluate(baseInput({ owedReviews: [a], slots: { total: 1, occupied: 1 } }));
    // run-b appears 20 min later.
    const s2 = evaluate(
      baseInput({ nowMs: T0 + min(20), owedReviews: [a, b], slots: { total: 1, occupied: 1 } }),
      s1.state
    );
    // At T0+31, run-a is stalled (31m) but run-b is not (11m).
    const s3 = evaluate(
      baseInput({ nowMs: T0 + min(31), owedReviews: [a, b], slots: { total: 1, occupied: 1 } }),
      s2.state
    );
    expect(s3.signals.owedReviewStalls.map((s) => s.runId)).toEqual(["run-a"]);
  });
});

describe("evaluateFleetHealth — pickup wedged", () => {
  const queued = [{ taskId: "task-9", label: "review: lennons301/lemons#34" }];

  it("does not fire before the debounce window", () => {
    const { signals, announce, state } = evaluate(
      baseInput({ slots: { total: 2, occupied: 1 }, queuedDispatchable: queued })
    );
    expect(signals.pickupWedged).toBeNull();
    expect(announce.pickupWedged).toBeNull();
    expect(state.pickupWedgedSinceMs).toBe(T0);
  });

  it("fires once a task has been queued past the threshold while a slot is free", () => {
    const s1 = evaluate(
      baseInput({ slots: { total: 2, occupied: 1 }, queuedDispatchable: queued })
    );
    const s2 = evaluate(
      baseInput({
        nowMs: T0 + min(4),
        slots: { total: 2, occupied: 1 },
        queuedDispatchable: queued,
      }),
      s1.state
    );
    expect(s2.signals.pickupWedged).not.toBeNull();
    expect(s2.signals.pickupWedged!.wedgedForMs).toBe(min(4));
    expect(s2.signals.pickupWedged!.detail).toContain("review: lennons301/lemons#34");
    expect(s2.signals.pickupWedged!.detail).toContain("1 slot free");
    expect(s2.announce.pickupWedged).not.toBeNull(); // one-time ping
    // Deduped on the next wedged sweep.
    const s3 = evaluate(
      baseInput({
        nowMs: T0 + min(5),
        slots: { total: 2, occupied: 1 },
        queuedDispatchable: queued,
      }),
      s2.state
    );
    expect(s3.signals.pickupWedged).not.toBeNull();
    expect(s3.announce.pickupWedged).toBeNull();
  });

  it("fires for pickup paused (no-slots) while a slot is free — the orphan-wedge shape", () => {
    const s1 = evaluate(
      baseInput({ slots: { total: 2, occupied: 1 }, pickupPausedWithFreeSlot: true })
    );
    const s2 = evaluate(
      baseInput({ nowMs: T0 + min(4), slots: { total: 2, occupied: 1 }, pickupPausedWithFreeSlot: true }),
      s1.state
    );
    expect(s2.signals.pickupWedged).not.toBeNull();
    expect(s2.signals.pickupWedged!.detail).toContain("pickup is paused (no-slots)");
  });

  it("does not fire when all slots are busy (no free slot to dispatch into)", () => {
    const { signals } = evaluate(
      baseInput({ slots: { total: 1, occupied: 1 }, queuedDispatchable: [] })
    );
    expect(signals.pickupWedged).toBeNull();
  });

  it("resets the timer and re-arms once the wedge clears", () => {
    const s1 = evaluate(
      baseInput({ slots: { total: 2, occupied: 1 }, queuedDispatchable: queued })
    );
    const s2 = evaluate(
      baseInput({ nowMs: T0 + min(4), slots: { total: 2, occupied: 1 }, queuedDispatchable: queued }),
      s1.state
    );
    // Queue drains — no longer wedged.
    const cleared = evaluate(
      baseInput({ nowMs: T0 + min(5), slots: { total: 2, occupied: 2 } }),
      s2.state
    );
    expect(cleared.signals.pickupWedged).toBeNull();
    expect(cleared.state.pickupWedgedSinceMs).toBeNull();
    expect(cleared.state.pickupWedgedAnnounced).toBe(false);
  });
});

describe("evaluateFleetHealth — phantom slot occupancy", () => {
  // Issue #152: the wedge #126 could not see. In the #151 incident a leaked
  // reservation held the box's only slot for ~1.5h with no agent container
  // anywhere — occupancy itself was the lie, so every other pickup signal read
  // "legitimately saturated" and stayed silent.
  const phantom = {
    slots: { total: 1, occupied: 1 },
    agentContainers: { live: 0, stopped: 0 },
  };

  it("fires — card + one-time ping — once occupancy has been uncorroborated past the threshold", () => {
    const s1 = evaluate(baseInput(phantom));
    expect(s1.signals.pickupWedged).toBeNull(); // debounced

    const s2 = evaluate(baseInput({ nowMs: T0 + min(11), ...phantom }), s1.state);
    expect(s2.signals.pickupWedged).not.toBeNull();
    expect(s2.signals.pickupWedged!.wedgedForMs).toBe(min(11));
    expect(s2.signals.pickupWedged!.detail).toContain("occupancy says 1 slot busy");
    expect(s2.signals.pickupWedged!.detail).toContain("0 agent containers live");
    expect(s2.signals.pickupWedged!.remedy).toContain("restart");
    expect(s2.announce.pickupWedged).not.toBeNull(); // one-time ping

    // Deduped on the next diverged sweep — the card stays, the ping does not.
    const s3 = evaluate(baseInput({ nowMs: T0 + min(12), ...phantom }), s2.state);
    expect(s3.signals.pickupWedged).not.toBeNull();
    expect(s3.announce.pickupWedged).toBeNull();
  });

  it("surfaces the starved task even at occupied == total, and clears once the count is real again", () => {
    const queued = [{ taskId: "task-9", label: "review: lennons301/lemons#34" }];
    const s1 = evaluate(baseInput({ ...phantom, queuedDispatchable: queued }));
    const s2 = evaluate(
      baseInput({ nowMs: T0 + min(11), ...phantom, queuedDispatchable: queued }),
      s1.state
    );
    // No slot reads free — the classic wedge cannot see this — yet the starved
    // review is named because occupancy could not be corroborated.
    expect(s2.signals.pickupWedged!.detail).toContain("review: lennons301/lemons#34");

    // A restart clears the phantom: one container for one counted slot.
    const cleared = evaluate(
      baseInput({
        nowMs: T0 + min(12),
        slots: { total: 1, occupied: 1 },
        agentContainers: { live: 1, stopped: 0 },
      }),
      s2.state
    );
    expect(cleared.signals.pickupWedged).toBeNull();
    expect(cleared.state.occupancyDivergedSinceMs).toBeNull();
    expect(cleared.state.pickupWedgedAnnounced).toBe(false);
  });

  it("never alarms for a task still provisioning its container (uncorroborated, but briefly)", () => {
    // A pickup reserves its slot before `createWorkspaceContainer` returns, so
    // the count legitimately leads the daemon for as long as provisioning takes.
    const s1 = evaluate(baseInput(phantom));
    const s2 = evaluate(baseInput({ nowMs: T0 + min(4), ...phantom }), s1.state);
    expect(s2.signals.pickupWedged).toBeNull();
    // The container appears — the divergence closes without ever having fired.
    const s3 = evaluate(
      baseInput({
        nowMs: T0 + min(5),
        slots: { total: 1, occupied: 1 },
        agentContainers: { live: 1, stopped: 0 },
      }),
      s2.state
    );
    expect(s3.signals.pickupWedged).toBeNull();
    expect(s3.state.occupancyDivergedSinceMs).toBeNull();
  });

  it("never alarms for a parked autonomous container (holds no slot, runs nothing)", () => {
    // A parked implement pass is stopped to free memory (#93): it is absent
    // from `occupiedSlots()` and absent from the daemon's running set, so it
    // cancels on both sides however long it stays parked.
    const parked = {
      slots: { total: 2, occupied: 1 },
      agentContainers: { live: 1, stopped: 1 },
    };
    const s1 = evaluate(baseInput(parked));
    const s2 = evaluate(baseInput({ nowMs: T0 + min(90), ...parked }), s1.state);
    expect(s2.signals.pickupWedged).toBeNull();
  });

  it("never alarms when the daemon could not be asked (probe failed or timed out)", () => {
    const unknown = { slots: { total: 1, occupied: 1 }, agentContainers: null };
    const s1 = evaluate(baseInput(unknown));
    const s2 = evaluate(baseInput({ nowMs: T0 + min(30), ...unknown }), s1.state);
    expect(s2.signals.pickupWedged).toBeNull();
    expect(s2.state.occupancyDivergedSinceMs).toBeNull();
  });

  it("never alarms when the daemon reports more containers than the counter claims", () => {
    // Over-count is a parked pass mid-transition or a leaked container — the
    // memory-admission probe's problem, not a pickup wedge.
    const over = {
      slots: { total: 2, occupied: 1 },
      agentContainers: { live: 2, stopped: 0 },
    };
    const s1 = evaluate(baseInput(over));
    const s2 = evaluate(baseInput({ nowMs: T0 + min(30), ...over }), s1.state);
    expect(s2.signals.pickupWedged).toBeNull();
  });

  it("advises going to look, not restarting, when the count is corroborated", () => {
    const queued = [{ taskId: "task-9", label: "review: lennons301/lemons#34" }];
    const s1 = evaluate(
      baseInput({
        slots: { total: 2, occupied: 1 },
        agentContainers: { live: 1, stopped: 0 },
        queuedDispatchable: queued,
      })
    );
    const s2 = evaluate(
      baseInput({
        nowMs: T0 + min(4),
        slots: { total: 2, occupied: 1 },
        agentContainers: { live: 1, stopped: 0 },
        queuedDispatchable: queued,
      }),
      s1.state
    );
    expect(s2.signals.pickupWedged!.remedy).toContain("check the orchestrator");
    expect(s2.signals.pickupWedged!.remedy).not.toContain("restart");
  });
});

describe("evaluateFleetHealth — stale queue heartbeat", () => {
  it("does not fire for a healthy idle loop (fresh heartbeat)", () => {
    const { signals, announce } = evaluate(
      baseInput({ nowMs: T0 + min(5), queueLastProgressMs: T0 + min(5) - 10_000 })
    );
    expect(signals.queueStale).toBeNull();
    expect(announce.queueStale).toBeNull();
  });

  it("fires once the heartbeat is stale past the threshold", () => {
    const { signals, announce } = evaluate(
      baseInput({ nowMs: T0 + min(5), queueLastProgressMs: T0 + min(2) })
    );
    expect(signals.queueStale).not.toBeNull();
    expect(signals.queueStale!.staleForMs).toBe(min(3));
    expect(announce.queueStale).not.toBeNull();
  });

  it("keeps the card but does not re-ping while stale, then re-arms on recovery", () => {
    const s1 = evaluate(baseInput({ nowMs: T0 + min(5), queueLastProgressMs: T0 + min(2) }));
    const s2 = evaluate(
      baseInput({ nowMs: T0 + min(6), queueLastProgressMs: T0 + min(2) }),
      s1.state
    );
    expect(s2.signals.queueStale).not.toBeNull();
    expect(s2.announce.queueStale).toBeNull(); // deduped
    // Loop recovers — heartbeat fresh again.
    const recovered = evaluate(
      baseInput({ nowMs: T0 + min(7), queueLastProgressMs: T0 + min(7) }),
      s2.state
    );
    expect(recovered.signals.queueStale).toBeNull();
    expect(recovered.state.queueStaleAnnounced).toBe(false);
    // A later stall re-pings.
    const again = evaluate(
      baseInput({ nowMs: T0 + min(12), queueLastProgressMs: T0 + min(7) }),
      recovered.state
    );
    expect(again.announce.queueStale).not.toBeNull();
  });

  it("never alarms when the queue loop is not running (boot/shutdown, not a wedge)", () => {
    const { signals } = evaluate(
      baseInput({ nowMs: T0 + min(10), queueRunning: false, queueLastProgressMs: T0 })
    );
    expect(signals.queueStale).toBeNull();
  });

  it("never alarms before the loop's first tick (null heartbeat)", () => {
    const { signals } = evaluate(
      baseInput({ nowMs: T0 + min(10), queueRunning: true, queueLastProgressMs: null })
    );
    expect(signals.queueStale).toBeNull();
  });
});
