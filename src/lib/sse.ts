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

  const stream = new ReadableStream({
    start(controller) {
      const send = (data: unknown, event?: string) => {
        try {
          controller.enqueue(encoder.encode(sseEvent(data, event)));
        } catch {
          // Stream closed
        }
      };

      const cleanup = handler(send);

      signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {
          // Already closed
        }
      });
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
