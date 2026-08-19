import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  observeAgentContainers,
  AGENT_CONTAINER_NAME_PREFIX,
} from "../agent-containers";

const { listContainersSpy } = vi.hoisted(() => ({
  listContainersSpy: vi.fn(async () => [] as Array<{ State: string }>),
}));

vi.mock("@/lib/docker/client", () => ({
  getDocker: () => ({ listContainers: listContainersSpy }),
}));

// Issue #152: the watchdog corroborates the in-memory slot count against what
// the daemon actually reports, so this census is the "reality" half of the
// phantom-occupancy signal. It must answer or fail — never hang, and never
// invent a number, since an unknown answer and a zero answer mean opposite
// things to the evaluator.
describe("observeAgentContainers", () => {
  beforeEach(() => listContainersSpy.mockClear());
  afterEach(() => vi.restoreAllMocks());

  it("splits agent containers into running and stopped from one daemon call", async () => {
    listContainersSpy.mockResolvedValueOnce([
      { State: "running" },
      { State: "exited" },
      { State: "running" },
      { State: "created" },
    ]);

    const census = await observeAgentContainers();

    expect(census).toEqual({ live: 2, stopped: 2 });
    expect(listContainersSpy).toHaveBeenCalledTimes(1);
    expect(listContainersSpy).toHaveBeenCalledWith({
      all: true,
      filters: { name: [AGENT_CONTAINER_NAME_PREFIX] },
    });
  });

  it("returns null — unknown, not zero — when the daemon errors", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const census = await observeAgentContainers(async () => {
      throw new Error("daemon unreachable");
    });
    expect(census).toBeNull();
  });

  it("returns null when the daemon hangs past the timeout, and logs it", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // A listing that never resolves — the #125 daemon-freeze shape.
    const hanging = () => new Promise<never>(() => {});

    const census = await observeAgentContainers(hanging, 20);

    expect(census).toBeNull();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("timed out"));
  });
});
