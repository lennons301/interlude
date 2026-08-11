import { NextResponse } from "next/server";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { eq } from "drizzle-orm";
import { listOpenIssues } from "@/lib/github/issues";

/**
 * Open issues of a project's repo, for the mobile session issue-picker
 * (issue #64). Returns `[]` — not an error — when the project has no repo
 * configured or GitHub is unconfigured, so the picker degrades to
 * freeform-only rather than failing session creation.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = db.select().from(projects).where(eq(projects.id, id)).get();
  if (!project) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!project.githubRepo) {
    return NextResponse.json([]);
  }
  const issues = await listOpenIssues(project.githubRepo);
  return NextResponse.json(issues);
}
