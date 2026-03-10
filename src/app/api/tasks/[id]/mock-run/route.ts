import { NextResponse } from "next/server";
import { db } from "@/db";
import { tasks } from "@/db/schema";
import { eq } from "drizzle-orm";
import { runMockAgent } from "@/lib/mock-agent";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const { simulateBlock } = body as { simulateBlock?: boolean };

  const task = db.select().from(tasks).where(eq(tasks.id, id)).get();
  if (!task) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Fire-and-forget: catch errors to avoid unhandled rejection
  runMockAgent(id, { simulateBlock }).catch(console.error);

  return NextResponse.json({ started: true });
}
