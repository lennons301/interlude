import { NextResponse } from "next/server";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { eq } from "drizzle-orm";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = db.select().from(projects).where(eq(projects.id, id)).get();
  if (!project) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  // Redact doppler token in GET responses
  return NextResponse.json({
    ...project,
    dopplerToken: project.dopplerToken ? "••••••••" : null,
  });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json();
  const { name, gitUrl, githubRepo, dopplerToken } = body as {
    name?: string;
    gitUrl?: string;
    githubRepo?: string | null;
    dopplerToken?: string | null;
  };

  const project = db.select().from(projects).where(eq(projects.id, id)).get();
  if (!project) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const updates: Record<string, unknown> = {};
  if (name !== undefined) updates.name = name.trim();
  if (gitUrl !== undefined) updates.gitUrl = gitUrl;
  if (githubRepo !== undefined) updates.githubRepo = githubRepo;
  if (dopplerToken !== undefined) updates.dopplerToken = dopplerToken;

  if (Object.keys(updates).length > 0) {
    db.update(projects).set(updates).where(eq(projects.id, id)).run();
  }

  const updated = db.select().from(projects).where(eq(projects.id, id)).get();
  return NextResponse.json({
    ...updated,
    dopplerToken: updated?.dopplerToken ? "••••••••" : null,
  });
}
