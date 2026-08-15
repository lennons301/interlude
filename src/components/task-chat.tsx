"use client";

import { useCallback, useState } from "react";
import { SlimShell } from "@/components/app-shell";
import { FOCUS_RING } from "@/components/fleet/fleet-bits";
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

  // The slim shell carries the task's identity and live status (issue #117);
  // what's left here is the task's references, restyled by its own ticket.
  const hasReferences = Boolean(
    initialTask.branch || githubIssue || pullRequestUrl
  );

  return (
    <SlimShell
      title={initialTask.title}
      accessory={
        <>
          {/* The label states what the container is doing; the dot beside it is
              what breathes. The fleet's one ambient animation belongs to the
              dot, so the running label reads green but holds still. */}
          {containerLabel && (
            <span
              className={`font-plex-mono text-[11px] ${
                taskStatus.containerStatus === "running"
                  ? "text-fl-green"
                  : "text-fl-ink-2"
              }`}
            >
              {containerLabel}
            </span>
          )}
          <StatusDot status={taskStatus.status} />
        </>
      }
    >
      {hasReferences && (
        <div className="shrink-0 border-b border-fl-line px-4 py-2">
          {initialTask.branch && (
            <p className="font-plex-mono text-[11px] text-fl-ink-2">
              {initialTask.branch}
            </p>
          )}
          {(githubIssue || pullRequestUrl) && (
            <div className="mt-0.5 flex items-center gap-3">
              {githubIssue && (
                <a
                  href={`https://github.com/${githubIssue.replace("#", "/issues/")}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`font-plex-mono text-[11px] text-fl-cool hover:text-fl-ink ${FOCUS_RING}`}
                >
                  {githubIssue}
                </a>
              )}
              {pullRequestUrl && (
                <a
                  href={pullRequestUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`font-plex-mono text-[11px] text-fl-cool hover:text-fl-ink ${FOCUS_RING}`}
                >
                  PR #{pullRequestNumber}
                </a>
              )}
            </div>
          )}
        </div>
      )}

      {/* Mobile tabs — only when preview available. The selected tab is marked
          the way the shell's nav marks the current section: full-strength ink
          over an ink rule, not a colour. Colour in this system is semantic, and
          "which pane am I looking at" means nothing about the run. */}
      {devPort && (
        <div className="flex shrink-0 border-b border-fl-line lg:hidden">
          {(["chat", "preview"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className={`flex-1 border-b-2 py-2 font-plex-mono text-[12px] lowercase ${FOCUS_RING} ${
                activeTab === tab
                  ? "border-fl-ink text-fl-ink"
                  : "border-transparent text-fl-ink-2 hover:text-fl-ink"
              }`}
            >
              {tab}
            </button>
          ))}
        </div>
      )}

      {/* Content area — responsive */}
      <div className="flex-1 flex flex-col lg:flex-row min-h-0">
        {/* Chat pane */}
        <div
          className={`flex-1 flex flex-col min-h-0 ${
            devPort && activeTab !== "chat" ? "hidden lg:flex" : ""
          } ${devPort ? "lg:w-2/5 lg:border-r lg:border-fl-line" : ""}`}
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
        <div className="shrink-0 border-t border-fl-line px-4 py-3 text-center">
          <span className="font-plex-mono text-[11px] tabular-nums text-fl-ink-2">
            Task {taskStatus.status}
            {taskStatus.totalCostUsd > 0 &&
              ` · $${taskStatus.totalCostUsd.toFixed(4)}`}
          </span>
        </div>
      )}
    </SlimShell>
  );
}

// Same neutral/green/red split as before, in fleet tokens: only failure and a
// live run earn a colour, and the two quiet neutrals keep their old ordering
// (queued and completed read louder than a cancelled run). `fleet-dot-live` is
// the system's one ambient animation, and it honours reduced-motion.
const STATUS_DOT: Record<string, string> = {
  queued: "bg-fl-ink-2",
  running: "bg-fl-green fleet-dot-live",
  completed: "bg-fl-ink-2",
  failed: "bg-fl-red",
  cancelled: "bg-fl-ink-3",
};

function StatusDot({ status }: { status: string }) {
  return (
    <span
      className={`inline-block h-1.5 w-1.5 rounded-full ${
        STATUS_DOT[status] ?? "bg-fl-ink-2"
      }`}
    />
  );
}
