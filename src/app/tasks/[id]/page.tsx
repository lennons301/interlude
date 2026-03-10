import { db } from "@/db";
import { tasks } from "@/db/schema";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { StatusBadge } from "@/components/status-badge";
import { TaskStream } from "@/components/task-stream";
import { MessageInput } from "@/components/message-input";

export default async function TaskDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const task = db.select().from(tasks).where(eq(tasks.id, id)).get();

  if (!task) notFound();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{task.title}</h1>
        <StatusBadge status={task.status} />
      </div>

      {task.description && (
        <p className="text-muted-foreground">{task.description}</p>
      )}

      <TaskStream taskId={task.id} />

      {(task.status === "running" || task.status === "blocked") && (
        <MessageInput taskId={task.id} />
      )}
    </div>
  );
}
