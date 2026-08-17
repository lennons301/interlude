"use client";

import { useCallback, useState } from "react";
import type { SessionSkill } from "@/db/schema";
import { SlimShell } from "@/components/app-shell";
import { FOCUS_RING, Gauge, Money } from "@/components/fleet/fleet-bits";
import { toChatView, type ChatMessageRow } from "@/lib/chat/chat-view";
import { isTerminalTaskStatus } from "@/lib/chat/composer";
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
  /** What this task is allowed to spend — its run's budget, or the
   * per-attempt default for an interactive session. */
  budgetUsd: number;
  githubIssue: string | null;
  pullRequestNumber: number | null;
  pullRequestUrl: string | null;
  /** Non-null on a generation session — the composer offers its slash menu
   * only where the orchestrator re-frames a typed skill slash (issue #63). */
  sessionSkill: SessionSkill | null;
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
  branch?: string | null;
};

const PREVIEW_MOVING_TOOLS = new Set(["Write", "Edit", "MultiEdit", "Bash"]);

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
  const [branch, setBranch] = useState<string | null>(initialTask.branch);
  const [activeTab, setActiveTab] = useState<"chat" | "preview">("chat");
  const [lastActivity, setLastActivity] = useState<number>(0);
  const [queued, setQueued] = useState(0);

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
      if (status.branch !== undefined) setBranch(status.branch);
    },
    []
  );

  // What might have changed what the preview is showing: a write, or a command
  // that could have restarted the dev server. Deliberately not the mapper's
  // edit-tool set — a `Bash` call moves the preview without writing a file.
  const handleMessage = useCallback((msg: ChatMessageRow) => {
    const [item] = toChatView([msg]);
    if (item?.kind === "tool-event" && PREVIEW_MOVING_TOOLS.has(item.verb)) {
      setLastActivity(Date.now());
    }
  }, []);

  const containerLabel = taskStatus.containerStatus
    ? CONTAINER_STATUS_LABELS[taskStatus.containerStatus] ??
      taskStatus.containerStatus
    : null;

  const isTerminal = isTerminalTaskStatus(taskStatus.status);

  // The slim shell carries the task's identity and live status (issue #117);
  // the row below it carries where the work lives and what it has cost.
  return (
    <SlimShell
      title={initialTask.title}
      accessory={
        <>
          {/* The label says what the container is doing and the dot beside it
              carries the liveness, so the label itself stays neutral ink: green
              at 11px on the bare light ground is 3.8:1, and the places this
              system does tint text green all sit on a wash or a card. */}
          {containerLabel && (
            <span className="font-plex-mono text-[11px] text-fl-ink-2">
              {containerLabel}
            </span>
          )}
          <StatusDot
            status={taskStatus.status}
            live={taskStatus.containerStatus === "running"}
          />
        </>
      }
    >
      <div className="flex shrink-0 items-end justify-between gap-4 border-b border-fl-line px-4 py-2">
        <div className="min-w-0">
          {/* The branch is where the work actually lives, so its absence is
              worth saying rather than leaving a gap. */}
          <p className="truncate font-plex-mono text-[11px] text-fl-ink-2">
            {branch ?? <span className="text-fl-ink-3">no branch yet</span>}
          </p>
          {(githubIssue || pullRequestUrl) && (
            <div className="mt-0.5 flex items-center gap-3">
              {githubIssue && (
                <a
                  href={`https://github.com/${githubIssue.replace("#", "/issues/")}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`font-plex-mono text-[11px] text-fl-cool underline decoration-fl-cool/45 underline-offset-2 hover:decoration-fl-cool ${FOCUS_RING}`}
                >
                  {githubIssue}
                </a>
              )}
              {pullRequestUrl && (
                <a
                  href={pullRequestUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`font-plex-mono text-[11px] text-fl-cool underline decoration-fl-cool/45 underline-offset-2 hover:decoration-fl-cool ${FOCUS_RING}`}
                >
                  PR #{pullRequestNumber}
                </a>
              )}
            </div>
          )}
        </div>

        {/* Spend against this task's ceiling, in the dashboard's metering
            language rather than a second vocabulary invented for this screen:
            money in tabular mono over the hairline gauge, tick at the ceiling.
            It reads red once the ceiling is reached — the point at which a run
            stops, so it is the one thing here that earns a colour. */}
        <div className="w-28 shrink-0 space-y-1">
          <p className="text-right font-plex-mono text-[11px] whitespace-nowrap tabular-nums text-fl-ink-2">
            <Money usd={taskStatus.totalCostUsd} />
            <span className="text-fl-ink-3">
              {" "}
              / <Money usd={initialTask.budgetUsd} />
            </span>
          </p>
          <Gauge
            value={taskStatus.totalCostUsd}
            max={initialTask.budgetUsd}
            tone={
              taskStatus.totalCostUsd >= initialTask.budgetUsd ? "red" : "green"
            }
          />
        </div>
      </div>

      {/* Mobile tabs — only when preview available. Selection is marked in ink,
          not a colour: colour in this system is semantic, and which pane you are
          looking at says nothing about the run. The rule is heavier than the
          shell nav's hairline because this is a thumb-sized control on a phone,
          not a header link. `aria-current` carries the same state the underline
          does, so it survives without sight of the underline. */}
      {devPort && (
        <div className="flex shrink-0 border-b border-fl-line lg:hidden">
          {(["chat", "preview"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              aria-current={activeTab === tab ? "true" : undefined}
              className={`flex-1 border-b-2 py-2.5 font-plex-mono text-[12px] lowercase ${FOCUS_RING} ${
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
            containerStatus={taskStatus.containerStatus}
            onStatusChange={handleStatusChange}
            onMessage={handleMessage}
            onQueuedChange={setQueued}
          />
          {!isTerminal && (
            <MessageInput
              taskId={initialTask.id}
              containerStatus={taskStatus.containerStatus}
              taskStatus={taskStatus.status}
              queued={queued}
              sessionSkill={initialTask.sessionSkill}
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

      {/* Terminal state footer. Cost is not repeated here: it lives in the
          header, against its ceiling, where it means something. */}
      {isTerminal && (
        <div className="shrink-0 border-t border-fl-line px-4 py-3 text-center">
          <span className="font-plex-mono text-[11px] lowercase text-fl-ink-2">
            task {taskStatus.status}
          </span>
        </div>
      )}
    </SlimShell>
  );
}

// Same neutral/green/red split as before, in fleet tokens: only failure and a
// live run earn a colour, and the two quiet neutrals keep their old ordering
// (queued and completed read louder than a cancelled run).
const STATUS_DOT: Record<string, string> = {
  queued: "bg-fl-ink-2",
  running: "bg-fl-green",
  completed: "bg-fl-ink-2",
  failed: "bg-fl-red",
  cancelled: "bg-fl-ink-3",
};

/**
 * `live` is the container working, not the task being open — the two part
 * company constantly. A task sits at status `running` while its agent is idle
 * between turns waiting on you, which is precisely the moment the view should
 * stop moving. Keying the breath to the task's status instead would leave it
 * running forever on every open task. `fleet-dot-live` is the system's one
 * ambient animation and it honours reduced-motion, which `animate-pulse` —
 * what this replaces — did not.
 */
function StatusDot({ status, live }: { status: string; live: boolean }) {
  return (
    <span
      className={`inline-block h-1.5 w-1.5 rounded-full ${
        STATUS_DOT[status] ?? "bg-fl-ink-2"
      } ${live ? "fleet-dot-live" : ""}`}
    />
  );
}
