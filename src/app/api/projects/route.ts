import { NextResponse } from "next/server";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { newId } from "@/lib/ulid";
import { desc } from "drizzle-orm";

export async function GET() {
  const rows = await db.select().from(projects).orderBy(desc(projects.createdAt));
  // A stored secret is never served, only whether one is set (issue #242) —
  // the same mask GET /api/projects/[id] has always applied. The settings UI
  // only tests the field against null, so the mask keeps it truthful.
  return NextResponse.json(
    rows.map((row) => ({
      ...row,
      dopplerToken: row.dopplerToken ? "••••••••" : null,
    }))
  );
}

export async function POST(request: Request) {
  const body = await request.json();
  const { name, githubRepo, gitUrl } = body as { name: string; githubRepo?: string; gitUrl?: string };

  if (!name?.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  const project = {
    id: newId(),
    name: name.trim(),
    githubRepo: githubRepo ?? null,
    gitUrl: gitUrl ?? null,
    createdAt: new Date(),
  };

  db.insert(projects).values(project).run();
  return NextResponse.json(project, { status: 201 });
}
