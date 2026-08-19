import { describe, it, expect } from "vitest";
import { raceWithTimeout, runBoundedProbe, TIMED_OUT } from "../timeout";

/** The shared bound behind the admission probe, the Discord REST calls and the
 * GitHub request wrapper (issue #151). What a timeout *means* is each caller's
 * decision, so this only answers "did it answer in time?". */
describe("raceWithTimeout", () => {
  it("gives back what the work resolved with, when it answers in time", async () => {
    await expect(raceWithTimeout(Promise.resolve("answered"), 50)).resolves.toBe(
      "answered"
    );
  });

  it("gives back the sentinel when the work outlives the bound", async () => {
    await expect(raceWithTimeout(new Promise(() => {}), 20)).resolves.toBe(
      TIMED_OUT
    );
  });

  it("still lets the work's own failure through — the bound is about waiting", async () => {
    await expect(
      raceWithTimeout(Promise.reject(new Error("refused")), 50)
    ).rejects.toThrow("refused");
  });
});

/** The outcome-returning wrapper the two Docker probes share (issue #152).
 * Built on `raceWithTimeout` above, so there is one race in the tree; what it
 * adds is folding a rejection into the return shape, because a probe's caller
 * has to decide what a *non-answer* means either way it arrives. */
describe("runBoundedProbe", () => {
  it("gives back the probe's value when it answers in time", async () => {
    await expect(runBoundedProbe(async () => 7, 50)).resolves.toEqual({
      ok: true,
      value: 7,
    });
  });

  it("reports a timeout when the probe outlives the bound", async () => {
    await expect(
      runBoundedProbe(() => new Promise(() => {}), 20)
    ).resolves.toEqual({ ok: false, reason: "timeout" });
  });

  it("reports a rejection as an error, carrying it for the caller to log", async () => {
    const refused = new Error("daemon refused");
    await expect(
      runBoundedProbe(() => Promise.reject(refused), 50)
    ).resolves.toEqual({ ok: false, reason: "error", error: refused });
  });

  it("treats a probe that throws synchronously as an error, not an escape", async () => {
    await expect(
      runBoundedProbe(() => {
        throw new Error("no socket");
      }, 50)
    ).resolves.toMatchObject({ ok: false, reason: "error" });
  });

  it("distinguishes a probe that legitimately answers with a falsy value", async () => {
    // `ok` is the outcome of asking, never the content of the answer — a probe
    // reporting `{ ok: false }` (admission refused) still *answered*.
    await expect(
      runBoundedProbe(async () => ({ ok: false, reason: "no memory" }), 50)
    ).resolves.toEqual({ ok: true, value: { ok: false, reason: "no memory" } });
  });

  it("swallows a timed-out probe's later rejection instead of leaving it unhandled", async () => {
    let reject: (error: Error) => void = () => {};
    const outcome = await runBoundedProbe(
      () => new Promise((_, r) => (reject = r)),
      20
    );
    expect(outcome).toEqual({ ok: false, reason: "timeout" });
    reject(new Error("arrived after nobody was listening"));
    // A surfaced unhandled rejection fails the run; getting here is the assertion.
    await new Promise((r) => setTimeout(r, 10));
  });
});
