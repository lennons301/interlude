import { NextResponse } from "next/server";
import { db } from "@/db";
import { messages } from "@/db/schema";
import { newId } from "@/lib/ulid";
import { asc, eq } from "drizzle-orm";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const rows = db
    .select()
    .from(messages)
    .where(eq(messages.taskId, id))
    .orderBy(asc(messages.createdAt))
    .all();

  return NextResponse.json(rows);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json();
  const { content, role } = body as { content: string; role?: string };

  if (!content?.trim()) {
    return NextResponse.json({ error: "content is required" }, { status: 400 });
  }

  const message = {
    id: newId(),
    taskId: id,
    role: (role ?? "user") as "user" | "agent" | "system",
    content: content.trim(),
    createdAt: new Date(),
  };

  db.insert(messages).values(message).run();
  return NextResponse.json(message, { status: 201 });
}
