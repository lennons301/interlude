import { NextResponse } from "next/server";
import { db } from "@/db";
import { tasks } from "@/db/schema";
import { eq } from "drizzle-orm";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const task = db.select().from(tasks).where(eq(tasks.id, id)).get();

  if (!task) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  return NextResponse.json(task);
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json();
  const { title, status } = body as { title?: string; status?: string };

  const existing = db.select().from(tasks).where(eq(tasks.id, id)).get();
  if (!existing) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (title !== undefined) updates.title = title.trim();
  if (status !== undefined) updates.status = status;

  db.update(tasks).set(updates).where(eq(tasks.id, id)).run();

  const updated = db.select().from(tasks).where(eq(tasks.id, id)).get();
  return NextResponse.json(updated);
}
