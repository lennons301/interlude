"use client";

import { useCallback, useState } from "react";
import { TaskStream } from "./task-stream";
import { MessageInput } from "./message-input";
import { PreviewPane } from "./preview-pane";

interface TaskData {
  id: string;
  title: string;
  status: string;
  branch: string | null;
  containerStatus: string | null;
  totalCostUsd: number;
  githubIssue: string | null;
  pullRequestNumber: number | null;
  pullRequestUrl: string | null;
}

type TaskStatusUpdate = {
  containerStatus: string | null;
  status: string;
  totalCostUsd: number;
  devPort?: number | null;
  previewSubdomain?: string | null;
  githubIssue?: string | null;
  pullRequestNumber?: number | null;
  pullRequestUrl?: string | null;
};

const CONTAINER_STATUS_LABELS: Record<string, string> = {
  setup: "Setting up workspace...",
  running: "Agent working...",
  idle: "Agent idle",
  completing: "Pushing changes...",
};

export function TaskChat({ task: initialTask, domain }: { task: TaskData; domain: string | null }) {
  const [taskStatus, setTaskStatus] = useState({
    status: initialTask.status,
    containerStatus: initialTask.containerStatus,
    totalCostUsd: initialTask.totalCostUsd,
  });
  const [devPort, setDevPort] = useState<number | null>(null);
  const [previewSubdomain, setPreviewSubdomain] = useState<string | null>(null);
  const [githubIssue, setGithubIssue] = useState<string | null>(initialTask.githubIssue);
  const [pullRequestUrl, setPullRequestUrl] = useState<string | null>(initialTask.pullRequestUrl);
  const [pullRequestNumber, setPullRequestNumber] = useState<number | null>(initialTask.pullRequestNumber);
  const [activeTab, setActiveTab] = useState<"chat" | "preview">("chat");
  const [lastActivity, setLastActivity] = useState<number>(0);

  const handleStatusChange = useCallback(
    (status: TaskStatusUpdate) => {
      setTaskStatus(status);
      if (status.devPort !== undefined) {
        setDevPort(status.devPort);
      }
      if (status.previewSubdomain !== undefined) {
        setPreviewSubdomain(status.previewSubdomain);
      }
      if (status.githubIssue !== undefined) setGithubIssue(status.githubIssue);
      if (status.pullRequestUrl !== undefined) setPullRequestUrl(status.pullRequestUrl);
      if (status.pullRequestNumber !== undefined) setPullRequestNumber(status.pullRequestNumber);
    },
    []
  );

  const handleMessage = useCallback(
    (msg: { type: string; content: string }) => {
      if (msg.type === "tool_use") {
        try {
          const parsed = JSON.parse(msg.content);
          if (["Write", "Edit", "Bash"].includes(parsed.tool)) {
            setLastActivity(Date.now());
          }
        } catch {
          // ignore parse errors
        }
      }
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
        {(githubIssue || pullRequestUrl) && (
          <div className="flex items-center gap-3 mt-0.5">
            {githubIssue && (
              <a
                href={`https://github.com/${githubIssue.replace("#", "/issues/")}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-blue-400 hover:text-blue-300 font-mono"
              >
                {githubIssue}
              </a>
            )}
            {pullRequestUrl && (
              <a
                href={pullRequestUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-blue-400 hover:text-blue-300 font-mono"
              >
                PR #{pullRequestNumber}
              </a>
            )}
          </div>
        )}
      </div>

      {/* Mobile tabs — only when preview available */}
      {devPort && (
        <div className="flex border-b border-zinc-800 lg:hidden shrink-0">
          <button
            onClick={() => setActiveTab("chat")}
            className={`flex-1 py-2 text-sm font-medium ${
              activeTab === "chat"
                ? "text-zinc-100 border-b-2 border-purple-500"
                : "text-zinc-500"
            }`}
          >
            Chat
          </button>
          <button
            onClick={() => setActiveTab("preview")}
            className={`flex-1 py-2 text-sm font-medium ${
              activeTab === "preview"
                ? "text-zinc-100 border-b-2 border-purple-500"
                : "text-zinc-500"
            }`}
          >
            Preview
          </button>
        </div>
      )}

      {/* Content area — responsive */}
      <div className="flex-1 flex flex-col lg:flex-row min-h-0">
        {/* Chat pane */}
        <div
          className={`flex-1 flex flex-col min-h-0 ${
            devPort && activeTab !== "chat" ? "hidden lg:flex" : ""
          } ${devPort ? "lg:w-2/5 lg:border-r lg:border-zinc-800" : ""}`}
        >
          <TaskStream
            taskId={initialTask.id}
            onStatusChange={handleStatusChange}
            onMessage={handleMessage}
          />
          {!isTerminal && (
            <MessageInput
              taskId={initialTask.id}
              containerStatus={taskStatus.containerStatus}
              taskStatus={taskStatus.status}
            />
          )}
        </div>

        {/* Preview pane */}
        {devPort && (
          <div
            className={`flex-1 min-h-0 ${
              activeTab !== "preview" ? "hidden lg:flex" : "flex"
            } flex-col ${devPort ? "lg:w-3/5" : ""}`}
          >
            <PreviewPane
              taskId={initialTask.id}
              devPort={devPort}
              previewSubdomain={previewSubdomain}
              domain={domain}
              lastActivityTimestamp={lastActivity}
            />
          </div>
        )}
      </div>

      {/* Terminal state footer */}
      {isTerminal && (
        <div className="border-t border-zinc-800 px-4 py-3 text-center shrink-0">
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
