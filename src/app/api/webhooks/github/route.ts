import { NextResponse } from "next/server";
import { db } from "@/db";
import { tasks, projects } from "@/db/schema";
import { eq } from "drizzle-orm";
import { newId } from "@/lib/ulid";
import { verifyWebhookSignature } from "@/lib/github/webhooks";
import { commentOnIssue } from "@/lib/github/issues";
import { isGitHubConfigured } from "@/lib/github/client";

export const dynamic = "force-dynamic";

const TRIGGER_LABEL = "interlude";

export async function POST(request: Request) {
  if (!isGitHubConfigured()) {
    return NextResponse.json({ error: "GitHub App not configured" }, { status: 404 });
  }

  const body = await request.text();
  const signature = request.headers.get("x-hub-signature-256");

  if (!verifyWebhookSignature(body, signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const event = request.headers.get("x-github-event");
  const payload = JSON.parse(body);

  if (event === "issues" && payload.action === "labeled") {
    const label = payload.label?.name;
    if (label !== TRIGGER_LABEL) {
      return NextResponse.json({ ok: true, skipped: "wrong label" });
    }

    const issue = payload.issue;
    const repo = payload.repository;
    const repoFullName = repo.full_name; // "owner/repo"
    const issueRef = `${repoFullName}#${issue.number}`;

    // Check for duplicate
    const existing = db
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.githubIssue, issueRef))
      .get();

    if (existing) {
      return NextResponse.json({ ok: true, skipped: "duplicate" });
    }

    // Find matching project
    const project = db
      .select()
      .from(projects)
      .where(eq(projects.githubRepo, repoFullName))
      .get();

    if (!project) {
      await commentOnIssue(
        issueRef,
        `This repo (\`${repoFullName}\`) is not connected to an Interlude project. Add it first.`
      );
      return NextResponse.json({ ok: true, skipped: "no project" });
    }

    // Extract prompt: use ## Prompt section if present, otherwise title + body
    let description = issue.body || "";
    const promptMatch = description.match(/## Prompt\s*\n([\s\S]*?)(?=\n## |\n$|$)/);
    if (promptMatch) {
      description = promptMatch[1].trim();
    }

    const domain = process.env.DOMAIN ?? "interludes.co.uk";
    const taskId = newId();
    const now = new Date();

    db.insert(tasks)
      .values({
        id: taskId,
        projectId: project.id,
        title: issue.title,
        description,
        status: "queued",
        githubIssue: issueRef,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    await commentOnIssue(
      issueRef,
      `Task queued -- agent will pick this up shortly.\n\n[View in Interlude](https://${domain}/tasks/${taskId})`
    );

    console.log(`[github] Issue ${issueRef} -> task ${taskId} (queued)`);
    return NextResponse.json({ ok: true, taskId });
  }

  return NextResponse.json({ ok: true, skipped: "unhandled event" });
}
