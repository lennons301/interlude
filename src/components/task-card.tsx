"use client";

import Link from "next/link";
import { Card, CardHeader } from "@/components/ui/card";
import { StatusBadge } from "./status-badge";

type Task = {
  id: string;
  title: string;
  status: string;
  description: string;
  containerStatus: string | null;
  updatedAt: string;
};

export function TaskCard({ task }: { task: Task }) {
  const isActive = task.status === "running";
  const isCancelled = task.status === "cancelled";

  return (
    <Card
      className={`transition-colors hover:bg-accent/50 ${isCancelled ? "opacity-50" : ""}`}
    >
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <Link
          href={`/tasks/${task.id}`}
          className="font-medium hover:underline"
        >
          {task.title}
        </Link>
        <div className="flex items-center gap-2">
          {isActive && task.containerStatus && (
            <span className="text-xs text-zinc-500">
              {task.containerStatus}
            </span>
          )}
          <StatusBadge status={task.status} />
        </div>
      </CardHeader>
    </Card>
  );
}
