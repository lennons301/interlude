/**
 * The fleet read model (Phase 5, issue #21). `buildFleetView(rows)` is pure:
 * every row it depends on is passed in — including `now` — so the dashboard
 * and the daily digest render one shared, table-testable structure and can
 * never disagree about the state of the fleet.
 */

import { MAX_ATTEMPTS } from "../orchestrator/autonomy/budgets";

export interface FleetRows {
  /** Current time — passed in, never read inside */
  now: Date;
  /** Total agent slots, from the boot-time capacity derivation */
  slots: number;
  /** Daily estate-wide autonomous spend cap in USD */
  dailyCapUsd: number;
  /** Discord guild for deep links into project channels; null = no Discord */
  discordGuildId: string | null;
  projects: FleetProjectRow[];
  runs: FleetRunRow[];
  tasks: FleetTaskRow[];
  /** Tickets armed `ready-for-agent` and not yet claimed; null = unknown */
  readyForAgentCount: number | null;
}

export interface FleetProjectRow {
  id: string;
  name: string;
  autonomyEnabled: boolean;
  preflightStatus: "passing" | "failing" | null;
  preflightReason: string | null;
  discordChannelId: string | null;
}

export interface FleetRunRow {
  id: string;
  projectId: string;
  githubIssue: string; // owner/repo#n
  attempt: number;
  mode: "autonomous" | "supervised";
  status:
    | "claimed"
    | "implementing"
    | "reviewing"
    | "gated"
    | "blocked"
    | "merged"
    | "failed"
    | "exhausted"
    | "interrupted"
    | "cancelled";
  budgetUsd: number;
  totalCostUsd: number;
  pullRequestNumber: number | null;
  pullRequestUrl: string | null;
  blockedQuestion: string | null;
  claimedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface FleetTaskRow {
  id: string;
  projectId: string;
  runId: string | null;
  kind: "interactive" | "implement" | "review" | "triage";
  title: string;
  status: "queued" | "running" | "blocked" | "completed" | "failed" | "cancelled";
  containerStatus: "setup" | "running" | "idle" | "completing" | null;
  totalCostUsd: number;
  /** Claude turns run so far — counted by the caller from delivered messages */
  turns: number;
  githubIssue: string | null;
  pullRequestNumber: number | null;
  pullRequestUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Re-exported from the budgets leaf so the view and the loop can't drift */
export { MAX_ATTEMPTS };

export type NeedsYouCause =
  | "blocked"
  | "signoff"
  | "exhausted"
  | "cap"
  | "preflight";

export interface NeedsYouItem {
  cause: NeedsYouCause;
  /** Severity stripe: amber = waiting on you, red = cap breached / exhausted */
  severity: "amber" | "red";
  /** Mono context line, e.g. "lemons #34 · attempt 2/3" */
  context: string;
  /** One-line body */
  body: string;
  /** Read-and-route v1: exactly one link out, or none */
  action: { label: string; href: string } | null;
}

export type PhaseState = "done" | "current" | "todo";

export interface RunningCard {
  /** The run's current task — the in-app chat/stream to open */
  taskId: string | null;
  runId: string | null;
  projectName: string;
  ticket: string | null;
  title: string;
  /** Mode chip: afk = full autonomy, supervised = forced human-signoff */
  mode: "afk" | "supervised" | "interactive";
  /** implement ▸ review ▸ merge pipeline; null for interactive sessions */
  phases: { name: "implement" | "review" | "merge"; state: PhaseState }[] | null;
  attempt: { current: number; max: number } | null;
  turns: number;
  startedAt: string | null;
  /** budgetUsd null = unbudgeted (interactive sessions) */
  spend: { usd: number; budgetUsd: number | null };
}

export interface RecentItem {
  title: string;
  projectName: string;
  costUsd: number;
  finishedAt: string;
  prNumber: number | null;
  prUrl: string | null;
  outcome: "merged" | "completed" | "failed" | "exhausted";
}

export type SlotSegment =
  | { occupant: "free" }
  | {
      occupant: "autonomous" | "interactive";
      projectName: string;
      taskId: string;
      /** "#34" for ticket-bound work, null for interactive sessions */
      ticket: string | null;
    };

export interface FleetView {
  generatedAt: string;
  slots: {
    total: number;
    used: number;
    saturated: boolean;
    segments: SlotSegment[];
  };
  spend: {
    todayUsd: number;
    capUsd: number;
    capPaused: boolean;
  };
  needsYou: NeedsYouItem[];
  running: RunningCard[];
  recent: { windowDays: number; totalUsd: number; items: RecentItem[] };
  queue: { readyForAgent: number | null };
  /** True when any project has autonomy enabled */
  autonomyOn: boolean;
}

/** Start of the local calendar day containing `now` — the daily autonomous
 * spend cap resets at local midnight. */
export function startOfLocalDay(now: Date): Date {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start;
}

/** "owner/repo#34" -> "#34"; null when the ref has no issue number */
function ticketLabel(githubIssue: string | null): string | null {
  const match = githubIssue?.match(/#(\d+)$/);
  return match ? `#${match[1]}` : null;
}

/** "owner/repo#34" -> "https://github.com/owner/repo/issues/34" */
function issueUrl(githubIssue: string): string | null {
  const match = githubIssue.match(/^([^/#]+)\/([^/#]+)#(\d+)$/);
  return match
    ? `https://github.com/${match[1]}/${match[2]}/issues/${match[3]}`
    : null;
}

const RECENT_WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export function buildFleetView(rows: FleetRows): FleetView {
  const projectById = new Map(rows.projects.map((p) => [p.id, p]));
  const runById = new Map(rows.runs.map((r) => [r.id, r]));
  const projectName = (id: string) => projectById.get(id)?.name ?? id;

  // A slot is a live container running (or setting up) an agent process.
  // Tasks are the container unit for every kind of work, so occupancy — and
  // what saturation is attributable to — reads straight off tasks with a
  // container status. A parked autonomous container (an implement pass
  // idling while its PR is reviewed, issue #17) stays alive but runs no
  // agent and holds no slot; an idle interactive session does hold its slot.
  const occupants = rows.tasks.filter(
    (t) =>
      t.containerStatus !== null &&
      !(t.kind !== "interactive" && t.containerStatus === "idle")
  );
  const segments: SlotSegment[] = occupants.map((t) => {
    const run = t.runId ? runById.get(t.runId) : undefined;
    return {
      occupant: t.kind === "interactive" ? ("interactive" as const) : ("autonomous" as const),
      projectName: projectName(t.projectId),
      taskId: t.id,
      ticket: ticketLabel(run?.githubIssue ?? t.githubIssue),
    };
  });
  while (segments.length < rows.slots) segments.push({ occupant: "free" });

  // Today's autonomous spend mirrors todayAutonomousSpendUsd: a sum over
  // runs claimed since local midnight. Interactive tasks have no run, which
  // exempts them by construction rather than by a filter.
  const dayStart = startOfLocalDay(rows.now).getTime();
  const todayUsd = rows.runs
    .filter((r) => r.claimedAt.getTime() >= dayStart)
    .reduce((sum, r) => sum + r.totalCostUsd, 0);
  const capPaused = todayUsd >= rows.dailyCapUsd;

  // A run's face in the UI is its latest task — the live container if one
  // exists, otherwise the most recently created pass.
  const tasksOfRun = (runId: string) =>
    rows.tasks.filter((t) => t.runId === runId);
  const currentTaskOf = (runId: string) => {
    const owned = tasksOfRun(runId);
    return (
      owned.find((t) => t.containerStatus !== null) ??
      owned.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ??
      null
    );
  };

  const runContext = (run: FleetRunRow) =>
    `${projectName(run.projectId)} ${ticketLabel(run.githubIssue) ?? run.githubIssue} · attempt ${run.attempt}/${MAX_ATTEMPTS}`;

  // Decision locked in review: actions are read-and-route in v1. A blocked
  // question deep-links to the Discord channel where a reply becomes the next
  // turn; without a Discord route it falls back to the in-app task chat.
  const blockedAction = (run: FleetRunRow): NeedsYouItem["action"] => {
    const channelId = projectById.get(run.projectId)?.discordChannelId;
    if (rows.discordGuildId && channelId) {
      return {
        label: "Answer in Discord",
        href: `https://discord.com/channels/${rows.discordGuildId}/${channelId}`,
      };
    }
    const task = currentTaskOf(run.id);
    return task ? { label: "Open task", href: `/tasks/${task.id}` } : null;
  };

  // Ordered by what to do next: the fleet-wide pause first, then a parked
  // agent waiting on an answer, then reviews, then post-mortems, then config.
  const needsYou: NeedsYouItem[] = [];

  if (capPaused) {
    needsYou.push({
      cause: "cap",
      severity: "red",
      context: `$${todayUsd.toFixed(2)} / $${rows.dailyCapUsd.toFixed(2)} today`,
      body: "Autonomous pickup paused until midnight — interactive work unaffected",
      action: null,
    });
  }

  for (const run of rows.runs.filter((r) => r.status === "blocked")) {
    needsYou.push({
      cause: "blocked",
      severity: "amber",
      context: runContext(run),
      body: run.blockedQuestion ?? "Agent asked a question",
      action: blockedAction(run),
    });
  }

  for (const run of rows.runs.filter((r) => r.status === "gated")) {
    needsYou.push({
      cause: "signoff",
      severity: "amber",
      context: runContext(run),
      body: run.pullRequestNumber
        ? `PR #${run.pullRequestNumber} waits for your sign-off`
        : "PR waits for your sign-off",
      action: run.pullRequestUrl
        ? {
            label: run.pullRequestNumber
              ? `Review PR #${run.pullRequestNumber}`
              : "Review PR",
            href: run.pullRequestUrl,
          }
        : null,
    });
  }

  // An exhausted ticket needs a human until either they re-arm it (a newer
  // run exists for the issue) or it ages out of the recent window — the DB
  // can't see the tracker, so the window is the release valve.
  const windowStart = rows.now.getTime() - RECENT_WINDOW_DAYS * DAY_MS;
  const exhausted = rows.runs.filter(
    (r) =>
      r.status === "exhausted" &&
      (r.finishedAt?.getTime() ?? 0) >= windowStart &&
      !rows.runs.some(
        (newer) =>
          newer.githubIssue === r.githubIssue &&
          newer.claimedAt.getTime() > r.claimedAt.getTime()
      )
  );
  for (const run of exhausted) {
    const href = issueUrl(run.githubIssue);
    needsYou.push({
      cause: "exhausted",
      severity: "red",
      context: runContext(run),
      body: "Attempts exhausted — ticket is ready-for-human",
      action: href
        ? { label: `Open issue ${ticketLabel(run.githubIssue)}`, href }
        : null,
    });
  }

  // Running = every run holding (or waiting on) a slot, then interactive
  // sessions as quiet, unbudgeted cards — they hold slots too (review
  // decision 2), they just answer to no ledger.
  const ACTIVE_RUN_STATUSES = new Set([
    "claimed",
    "implementing",
    "reviewing",
    "blocked",
  ]);
  const phasePipeline = (
    status: FleetRunRow["status"]
  ): NonNullable<RunningCard["phases"]> => {
    const reviewReached = status === "reviewing";
    return [
      { name: "implement", state: reviewReached ? "done" : "current" },
      { name: "review", state: reviewReached ? "current" : "todo" },
      { name: "merge", state: "todo" },
    ];
  };

  const running: RunningCard[] = rows.runs
    .filter((r) => ACTIVE_RUN_STATUSES.has(r.status))
    .sort((a, b) => a.claimedAt.getTime() - b.claimedAt.getTime())
    .map((run) => {
      const task = currentTaskOf(run.id);
      return {
        taskId: task?.id ?? null,
        runId: run.id,
        projectName: projectName(run.projectId),
        ticket: ticketLabel(run.githubIssue),
        title: task?.title ?? run.githubIssue,
        mode: run.mode === "autonomous" ? ("afk" as const) : ("supervised" as const),
        phases: phasePipeline(run.status),
        attempt: { current: run.attempt, max: MAX_ATTEMPTS },
        turns: task?.turns ?? 0,
        startedAt: (run.startedAt ?? run.claimedAt).toISOString(),
        spend: { usd: run.totalCostUsd, budgetUsd: run.budgetUsd },
      };
    });

  for (const task of occupants.filter((t) => t.kind === "interactive")) {
    running.push({
      taskId: task.id,
      runId: null,
      projectName: projectName(task.projectId),
      ticket: ticketLabel(task.githubIssue),
      title: task.title,
      mode: "interactive",
      phases: null,
      attempt: null,
      turns: task.turns,
      startedAt: task.createdAt.toISOString(),
      spend: { usd: task.totalCostUsd, budgetUsd: null },
    });
  }

  // Preflight only matters where autonomy is asked for — a dormant project
  // failing preflight needs nothing from anyone.
  for (const project of rows.projects.filter(
    (p) => p.autonomyEnabled && p.preflightStatus === "failing"
  )) {
    needsYou.push({
      cause: "preflight",
      severity: "amber",
      context: project.name,
      body: `Preflight failing: ${project.preflightReason ?? "reason unknown"}`,
      action: { label: "Open settings", href: "/settings" },
    });
  }

  // The quiet 7-day ledger: terminal runs plus completed interactive
  // sessions. Run-owned tasks are represented by their run, never listed
  // twice; cancelled work was a deliberate human act, not a completion.
  const RUN_OUTCOMES: Partial<Record<FleetRunRow["status"], RecentItem["outcome"]>> = {
    merged: "merged",
    failed: "failed",
    exhausted: "exhausted",
  };
  const recentItems: RecentItem[] = [];
  for (const run of rows.runs) {
    const outcome = RUN_OUTCOMES[run.status];
    const finishedAt = run.finishedAt;
    if (!outcome || !finishedAt || finishedAt.getTime() < windowStart) continue;
    const task = currentTaskOf(run.id);
    recentItems.push({
      title: task?.title ?? run.githubIssue,
      projectName: projectName(run.projectId),
      costUsd: run.totalCostUsd,
      finishedAt: finishedAt.toISOString(),
      prNumber: run.pullRequestNumber,
      prUrl: run.pullRequestUrl,
      outcome,
    });
  }
  for (const task of rows.tasks) {
    if (task.runId !== null) continue;
    if (task.status !== "completed" && task.status !== "failed") continue;
    if (task.updatedAt.getTime() < windowStart) continue;
    recentItems.push({
      title: task.title,
      projectName: projectName(task.projectId),
      costUsd: task.totalCostUsd,
      finishedAt: task.updatedAt.toISOString(),
      prNumber: task.pullRequestNumber,
      prUrl: task.pullRequestUrl,
      outcome: task.status === "completed" ? "completed" : "failed",
    });
  }
  recentItems.sort((a, b) => b.finishedAt.localeCompare(a.finishedAt));
  const recentTotalUsd = recentItems.reduce((sum, i) => sum + i.costUsd, 0);

  return {
    generatedAt: rows.now.toISOString(),
    slots: {
      total: rows.slots,
      used: occupants.length,
      saturated: occupants.length >= rows.slots,
      segments,
    },
    spend: { todayUsd, capUsd: rows.dailyCapUsd, capPaused },
    needsYou,
    running,
    recent: {
      windowDays: RECENT_WINDOW_DAYS,
      totalUsd: recentTotalUsd,
      items: recentItems,
    },
    queue: { readyForAgent: rows.readyForAgentCount },
    autonomyOn: rows.projects.some((p) => p.autonomyEnabled),
  };
}
