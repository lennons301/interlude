export function sseEvent(data: unknown, event?: string): string {
  let message = "";
  if (event) message += `event: ${event}\n`;
  message += `data: ${JSON.stringify(data)}\n\n`;
  return message;
}

export function createSSEStream(
  signal: AbortSignal,
  handler: (send: (data: unknown, event?: string) => void) => () => void
): Response {
  const encoder = new TextEncoder();
  let cleanup: (() => void) | null = null;
  // Idempotent: abort and cancel can both fire for one disconnect.
  const stop = () => {
    cleanup?.();
    cleanup = null;
  };

  const stream = new ReadableStream({
    start(controller) {
      const send = (data: unknown, event?: string) => {
        try {
          controller.enqueue(encoder.encode(sseEvent(data, event)));
        } catch {
          // Stream closed
        }
      };

      cleanup = handler(send);

      signal.addEventListener("abort", () => {
        stop();
        try {
          controller.close();
        } catch {
          // Already closed
        }
      });
    },
    // The consumer went away. Don't rely on request.signal alone — if a proxy
    // in front never closes the upstream request, abort never fires and the
    // handler's poll leaks (prod 2026-11-02).
    cancel() {
      stop();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
