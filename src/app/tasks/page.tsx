import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { TaskFeed } from "@/components/task-feed";

// The list itself is reskinned by its own ticket; here it just moves inside the
// shared shell (issue #117).
export default function TasksPage() {
  return (
    <AppShell section="tasks">
      <div className="space-y-6 py-2">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Tasks</h1>
          <Link
            href="/tasks/new"
            className="inline-flex h-8 items-center justify-center rounded-lg bg-primary px-2.5 text-sm font-medium text-primary-foreground transition-all hover:bg-primary/80"
          >
            New Task
          </Link>
        </div>
        <TaskFeed />
      </div>
    </AppShell>
  );
}
