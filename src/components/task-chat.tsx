"use client";

import { useCallback, useState } from "react";
import { TaskStream } from "./task-stream";
import { MessageInput } from "./message-input";

interface TaskData {
  id: string;
  title: string;
  status: string;
  branch: string | null;
  containerStatus: string | null;
  totalCostUsd: number;
}

const CONTAINER_STATUS_LABELS: Record<string, string> = {
  setup: "Setting up workspace...",
  running: "Agent working...",
  idle: "Agent idle",
  completing: "Pushing changes...",
};

export function TaskChat({ task: initialTask }: { task: TaskData }) {
  const [taskStatus, setTaskStatus] = useState({
    status: initialTask.status,
    containerStatus: initialTask.containerStatus,
    totalCostUsd: initialTask.totalCostUsd,
  });

  const handleStatusChange = useCallback(
    (status: {
      containerStatus: string | null;
      status: string;
      totalCostUsd: number;
    }) => {
      setTaskStatus(status);
    },
    []
  );

  const containerLabel = taskStatus.containerStatus
    ? CONTAINER_STATUS_LABELS[taskStatus.containerStatus] ??
      taskStatus.containerStatus
    : null;

  const isTerminal = ["completed", "failed", "cancelled"].includes(
    taskStatus.status
  );

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)]">
      {/* Header */}
      <div className="border-b border-zinc-800 px-4 py-3 shrink-0">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold text-zinc-100 truncate">
            {initialTask.title}
          </h1>
          <div className="flex items-center gap-2">
            {containerLabel && (
              <span
                className={`text-xs ${
                  taskStatus.containerStatus === "running"
                    ? "text-green-400 animate-pulse"
                    : "text-zinc-400"
                }`}
              >
                {containerLabel}
              </span>
            )}
            <StatusDot status={taskStatus.status} />
          </div>
        </div>
        {initialTask.branch && (
          <p className="text-xs text-zinc-500 mt-0.5 font-mono">
            {initialTask.branch}
          </p>
        )}
      </div>

      {/* Messages */}
      <TaskStream
        taskId={initialTask.id}
        onStatusChange={handleStatusChange}
      />

      {/* Input */}
      {!isTerminal && (
        <MessageInput
          taskId={initialTask.id}
          containerStatus={taskStatus.containerStatus}
          taskStatus={taskStatus.status}
        />
      )}

      {/* Terminal state footer */}
      {isTerminal && (
        <div className="border-t border-zinc-800 px-4 py-3 text-center">
          <span className="text-xs text-zinc-500">
            Task {taskStatus.status}
            {taskStatus.totalCostUsd > 0 &&
              ` · $${taskStatus.totalCostUsd.toFixed(4)}`}
          </span>
        </div>
      )}
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const colors: Record<string, string> = {
    queued: "bg-zinc-400",
    running: "bg-green-400",
    completed: "bg-zinc-400",
    failed: "bg-red-400",
    cancelled: "bg-zinc-600",
  };

  return (
    <span
      className={`inline-block h-2 w-2 rounded-full ${
        colors[status] ?? "bg-zinc-400"
      }`}
    />
  );
}
