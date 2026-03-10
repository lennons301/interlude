import Link from "next/link";
import { TaskFeed } from "@/components/task-feed";

export default function Home() {
  return (
    <div className="space-y-6">
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
  );
}
