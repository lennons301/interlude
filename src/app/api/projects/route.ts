import { NextResponse } from "next/server";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { newId } from "@/lib/ulid";
import { desc } from "drizzle-orm";

export async function GET() {
  const rows = await db.select().from(projects).orderBy(desc(projects.createdAt));
  return NextResponse.json(rows);
}

export async function POST(request: Request) {
  const body = await request.json();
  const { name, githubRepo } = body as { name: string; githubRepo?: string };

  if (!name?.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  const project = {
    id: newId(),
    name: name.trim(),
    githubRepo: githubRepo ?? null,
    createdAt: new Date(),
  };

  db.insert(projects).values(project).run();
  return NextResponse.json(project, { status: 201 });
}
