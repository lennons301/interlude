import { describe, it, expect, vi } from "vitest";
import { createSSEStream } from "@/lib/sse";

describe("createSSEStream", () => {
  it("runs cleanup when the consumer cancels the stream, even if the request never aborts", async () => {
    const cleanup = vi.fn();
    const res = createSSEStream(new AbortController().signal, () => cleanup);

    await res.body!.cancel();

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("runs cleanup once when the request aborts", () => {
    const cleanup = vi.fn();
    const ac = new AbortController();
    createSSEStream(ac.signal, () => cleanup);

    ac.abort();

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("does not run cleanup twice when cancel follows abort", async () => {
    const cleanup = vi.fn();
    const ac = new AbortController();
    const res = createSSEStream(ac.signal, () => cleanup);

    ac.abort();
    await res.body!.cancel();

    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
