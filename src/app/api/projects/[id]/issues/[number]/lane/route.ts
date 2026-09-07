import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { getLaneCatalog } from "@/lib/lanes/catalog";
import { checkLanePin } from "@/lib/lanes/lane-pin";
import { clearLanePin, readLanePin, setLanePin } from "@/lib/lanes/lane-pins";

/**
 * The operator surface for pinning one ticket-loop run to a lane (issue #241).
 *
 * `PUT { lane }` records that when the sweep claims this issue it runs on
 * `lane` — that run, not the fleet. `GET` reads the pending pin; `DELETE`
 * withdraws it. The pin is spent by the claim (copied onto the run, then
 * removed), so a `GET` after the claim finds nothing and the run card shows
 * the pin instead.
 *
 * This is an attended, trusted surface like the settings screen: a lane is
 * validated against the declared file and the environment exactly as the
 * fleet's primary is, and an issue body can never set one — the directive
 * parser has no lane key.
 */

type Project = typeof projects.$inferSelect;
type Resolved = { error: NextResponse } | { project: Project; issueNumber: number };

async function resolveParams(params: Promise<{ id: string; number: string }>): Promise<Resolved> {
  const { id, number } = await params;
  const project = db.select().from(projects).where(eq(projects.id, id)).get();
  if (!project) return { error: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  const issueNumber = Number.parseInt(number, 10);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    return { error: NextResponse.json({ error: "issue number must be a positive integer" }, { status: 400 }) };
  }
  return { project, issueNumber };
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; number: string }> }
): Promise<NextResponse> {
  const resolved = await resolveParams(params);
  if ("error" in resolved) return resolved.error;
  const pin = readLanePin(resolved.project.id, resolved.issueNumber);
  return NextResponse.json({ lane: pin?.lane ?? null, createdAt: pin?.createdAt ?? null });
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string; number: string }> }
): Promise<NextResponse> {
  const resolved = await resolveParams(params);
  if ("error" in resolved) return resolved.error;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const lane = (body as { lane?: unknown } | null)?.lane;
  const catalog = getLaneCatalog();
  const check = checkLanePin(lane, catalog.ok ? catalog.catalog : null, process.env);
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status });
  const pin = setLanePin(resolved.project.id, resolved.issueNumber, check.laneId);
  return NextResponse.json({ lane: pin.lane, createdAt: pin.createdAt });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; number: string }> }
): Promise<NextResponse> {
  const resolved = await resolveParams(params);
  if ("error" in resolved) return resolved.error;
  const removed = clearLanePin(resolved.project.id, resolved.issueNumber);
  return NextResponse.json({ removed });
}
