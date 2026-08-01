import { createSSEStream } from "@/lib/sse";
import { currentFleetView } from "@/lib/fleet/rows";

export const dynamic = "force-dynamic";

/**
 * The dashboard's live channel: the full FleetView, re-sent whenever it
 * changes. Same poll-and-diff pattern as the per-task stream — the view is
 * small enough that diffing the serialized whole keeps the client trivial.
 */
export async function GET(request: Request) {
  return createSSEStream(request.signal, (send) => {
    let lastSent = "";

    const push = async () => {
      try {
        const view = await currentFleetView(new Date());
        // generatedAt changes every poll; exclude it from the change check
        const { generatedAt, ...comparable } = view;
        void generatedAt;
        const body = JSON.stringify(comparable);
        if (body !== lastSent) {
          lastSent = body;
          send(view, "fleet");
        }
      } catch (err) {
        console.error("[fleet] stream poll failed:", err);
      }
    };

    void push();
    const poll = setInterval(push, 2000);
    return () => clearInterval(poll);
  });
}
