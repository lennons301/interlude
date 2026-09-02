import { describe, it, expect } from "vitest";
import { isRecreatedNetworkFailure, planNetworkReattach } from "../stale-network";

/**
 * The daemon's own words, copied from the prod incident of 2026-09-02: a
 * deploy's `compose down`/`up -d` recreated the `interlude` network with a new
 * ID while a parked agent container still referenced the old one (issue #190).
 *
 * Note the misleading "no such container" prefix — the container was there. A
 * check on the 404 alone would be both wrong and unhelpful.
 */
const RECREATED_NETWORK = Object.assign(
  new Error(
    "(HTTP code 404) no such container - failed to set up container networking: " +
      "network f7385edc214ebf13e48ab7dc9f945572a4af3849f9b3e32b4d6a5e23cdd83728 not found "
  ),
  { statusCode: 404 }
);

describe("isRecreatedNetworkFailure", () => {
  it("recognises a start that failed because the network was recreated", () => {
    expect(isRecreatedNetworkFailure(RECREATED_NETWORK)).toBe(true);
  });

  it("does not claim a genuinely removed container", () => {
    const gone = Object.assign(new Error("(HTTP code 404) no such container - No such container: abc"), {
      statusCode: 404,
    });
    expect(isRecreatedNetworkFailure(gone)).toBe(false);
  });

  it("does not claim an unrelated start failure", () => {
    const oom = Object.assign(new Error("(HTTP code 500) server error - cannot allocate memory"), {
      statusCode: 500,
    });
    expect(isRecreatedNetworkFailure(oom)).toBe(false);
    expect(isRecreatedNetworkFailure(undefined)).toBe(false);
  });
});

/**
 * The `NetworkSettings.Networks` of the orphaned prod container, verbatim. The
 * point of the fixture is the pair of values: `NetworkID` has been emptied and
 * `Aliases` survives — so the aliases are recoverable from the container itself
 * and must be re-supplied, since a container network alias is what makes
 * subdomain preview routing resolve (`task-zkp2j671.interludes.co.uk`).
 */
const ORPHANED_NETWORKS = {
  interlude: {
    Aliases: ["task-zkp2j671"],
    NetworkID: "",
    EndpointID: "",
    DNSNames: [
      "interlude-task-01M1G8H04B2Z9BK5ABZKP2J671-1788325954623",
      "task-zkp2j671",
      "0a31acc66936",
    ],
  },
};

describe("planNetworkReattach", () => {
  it("restores the aliases the container recorded, on its own network", () => {
    expect(planNetworkReattach(ORPHANED_NETWORKS, "interlude")).toEqual({
      network: "interlude",
      aliases: ["task-zkp2j671"],
    });
  });

  it("reattaches with no aliases rather than refusing when none were recorded", () => {
    expect(planNetworkReattach({ interlude: {} }, "interlude")).toEqual({
      network: "interlude",
      aliases: [],
    });
  });

  it("declines when the container is not on that network at all", () => {
    expect(planNetworkReattach({ bridge: { Aliases: ["x"] } }, "interlude")).toBeNull();
    expect(planNetworkReattach(undefined, "interlude")).toBeNull();
  });
});
