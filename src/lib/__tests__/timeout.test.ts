import { describe, it, expect } from "vitest";
import { raceWithTimeout, TIMED_OUT } from "../timeout";

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
