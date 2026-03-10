"use client";

import { useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { StatusBadge } from "./status-badge";
import { TaskStream } from "./task-stream";
import { MessageInput } from "./message-input";

type Task = {
  id: string;
  title: string;
  status: string;
  description: string;
  updatedAt: string;
};

const EXPANDED_STATUSES = new Set(["running", "blocked"]);

export function TaskCard({ task }: { task: Task }) {
  const autoExpand = EXPANDED_STATUSES.has(task.status);
  const [expanded, setExpanded] = useState(autoExpand);
  const isCancelled = task.status === "cancelled";

  return (
    <Card
      className={`cursor-pointer transition-colors hover:bg-accent/50 ${isCancelled ? "opacity-50" : ""}`}
      onClick={() => !expanded && setExpanded(true)}
    >
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <Link
          href={`/tasks/${task.id}`}
          className="font-medium hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {task.title}
        </Link>
        <StatusBadge status={task.status} />
      </CardHeader>

      {expanded && (
        <CardContent className="space-y-3 pt-0">
          <TaskStream taskId={task.id} />
          {(task.status === "running" || task.status === "blocked") && (
            <MessageInput taskId={task.id} />
          )}
          <button
            className="text-xs text-muted-foreground hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(false);
            }}
          >
            Collapse
          </button>
        </CardContent>
      )}
    </Card>
  );
}
