import { db } from "@/db";
import { runs, tasks } from "@/db/schema";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { TaskChat } from "@/components/task-chat";
import { getConfig } from "@/lib/config";

export default async function TaskDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const task = db.select().from(tasks).where(eq(tasks.id, id)).get();

  if (!task) notFound();

  // A pass spends against its run's budget (which a ticket's `budget:`
  // directive may have raised); an interactive session has no run and spends
  // against the per-attempt default. Either way the header meters against the
  // ceiling this task will actually stop at.
  const run = task.runId
    ? db.select().from(runs).where(eq(runs.id, task.runId)).get()
    : null;

  return (
    <TaskChat
      task={{
        id: task.id,
        title: task.title,
        status: task.status,
        branch: task.branch,
        containerStatus: task.containerStatus,
        totalCostUsd: task.totalCostUsd ?? 0,
        budgetUsd: run?.budgetUsd ?? getConfig().maxBudgetUsd,
        githubIssue: task.githubIssue ?? null,
        pullRequestNumber: task.pullRequestNumber ?? null,
        pullRequestUrl: task.pullRequestUrl ?? null,
      }}
      domain={process.env.DOMAIN ?? null}
    />
  );
}
