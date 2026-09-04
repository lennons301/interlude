import { NextResponse } from "next/server";
import {
  moveParkedRunToLane,
  readManualLaneMove,
} from "@/lib/orchestrator/autonomy/paused-runs";

/**
 * The operator's manual move of a parked run onto another lane (issue #202),
 * behind the control on the fleet card.
 *
 * Two verbs over one decision. `GET` says what a press would do — the lane,
 * what it costs, which continuation of the attempt it would be — or why it
 * is refused, so the card can put a confirmation in front of the operator
 * that names the money before any is spent. `POST` decides again, freshly,
 * and makes the move; refused, it answers `409` with the same refusal shape,
 * because the fleet moves between the two (a sweep may have resumed the run
 * itself; another session may have spent the day's last dollar) and a press
 * has to be judged against the fleet as it is when the money is spent.
 *
 * Thin on purpose. The decision is the pure `decideManualLaneMove`, the read
 * and the move are `paused-runs.ts`'s, and both share the sweep's own resume
 * body — so what this route does is exactly what the sweep would have done
 * had the ranking chosen to, with an operator standing in for the ranking.
 * Nothing here touches orchestrator memory: this handler runs on the app
 * router's module graph (issue #159), and everything the move needs is in the
 * database.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const reading = readManualLaneMove(id);
  if (reading === null) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json(reading);
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const result = await moveParkedRunToLane(id);
  if (result === null) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (!result.ok) {
    // A stated reason, never a silent no-op: the refusal is the answer, and
    // the status says the fleet's state — not the request — is what refused it.
    return NextResponse.json(result, { status: 409 });
  }
  return NextResponse.json(result);
}
