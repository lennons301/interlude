import { describe, it, expect, vi, afterEach } from "vitest";
import { boundedFetch, GITHUB_REQUEST_TIMEOUT_MS } from "../request-timeout";

/**
 * The bound every outbound GitHub call runs under (issue #151). A stalled call
 * is not a failed call: the helpers in this directory all catch errors and
 * return null, but nothing bounded a request that simply never answered — and
 * one that never answered held the box's only queue slot until a restart.
 */

/** A fetch that never answers, recording the init it was handed so the test can
 * see whether the request was actually aborted or merely abandoned. */
function stalledFetch() {
  const calls: RequestInit[] = [];
  const impl = ((_input: unknown, init: RequestInit) => {
    calls.push(init);
    return new Promise<Response>(() => {});
  }) as unknown as typeof globalThis.fetch;
  return { impl, calls };
}

describe("boundedFetch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects a request that never answers, naming the request and the bound", async () => {
    const { impl } = stalledFetch();
    const fetch = boundedFetch(20, impl);

    await expect(
      fetch("https://api.github.com/repos/owner/repo/pulls")
    ).rejects.toThrow(/repos\/owner\/repo\/pulls.*20ms/s);
  });

  it("aborts the stalled request rather than abandoning its socket", async () => {
    const { impl, calls } = stalledFetch();
    const fetch = boundedFetch(20, impl);

    await expect(fetch("https://api.github.com/rate_limit")).rejects.toThrow();

    expect(calls).toHaveLength(1);
    expect(calls[0].signal?.aborted).toBe(true);
  });

  it("logs the timeout", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { impl } = stalledFetch();

    await expect(
      boundedFetch(20, impl)("https://api.github.com/rate_limit")
    ).rejects.toThrow();

    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining("[github]")
    );
  });

  it("passes a prompt response straight through", async () => {
    const answered = new Response('{"ok":true}', { status: 200 });
    const impl = vi.fn(async () => answered) as unknown as typeof globalThis.fetch;

    const res = await boundedFetch(20, impl)("https://api.github.com/rate_limit");

    expect(res).toBe(answered);
  });

  it("composes a caller's own abort signal with the bound rather than replacing it", async () => {
    const { impl, calls } = stalledFetch();
    const caller = new AbortController();
    // A bound far beyond the test's patience, so the caller's abort is the only
    // thing that can end this request.
    void boundedFetch(60_000, impl)("https://api.github.com/rate_limit", {
      signal: caller.signal,
    }).catch(() => {});
    await Promise.resolve();

    expect(calls[0].signal?.aborted).toBe(false);

    caller.abort(new Error("caller changed its mind"));

    expect(calls[0].signal?.aborted).toBe(true);
  });

  it("defaults to a bound in the tens of seconds — generous for GitHub, finite", () => {
    expect(GITHUB_REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
    expect(GITHUB_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });
});
