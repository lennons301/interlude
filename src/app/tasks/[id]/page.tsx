import { db } from "@/db";
import { tasks } from "@/db/schema";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { TaskChat } from "@/components/task-chat";

export default async function TaskDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const task = db.select().from(tasks).where(eq(tasks.id, id)).get();

  if (!task) notFound();

  return (
    <TaskChat
      task={{
        id: task.id,
        title: task.title,
        status: task.status,
        branch: task.branch,
        containerStatus: task.containerStatus,
        totalCostUsd: task.totalCostUsd ?? 0,
        githubIssue: task.githubIssue ?? null,
        pullRequestNumber: task.pullRequestNumber ?? null,
        pullRequestUrl: task.pullRequestUrl ?? null,
      }}
      domain={process.env.DOMAIN ?? null}
    />
  );
}
