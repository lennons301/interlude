/**
 * The fleet read model (Phase 5, issue #21). `buildFleetView(rows)` is pure:
 * every row it depends on is passed in — including `now` — so the dashboard
 * and the daily digest render one shared, table-testable structure and can
 * never disagree about the state of the fleet.
 */

import {
  DEFAULT_REVIEW_BUDGET_USD,
  DEFAULT_TRIAGE_BUDGET_USD,
  MAX_ATTEMPTS,
  MAX_INTEGRATION_ATTEMPTS,
} from "../orchestrator/autonomy/budgets";

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
  /** Tickets armed `ready-for-agent` and not yet claimed, keyed by project
   * id — the sweep's last tracker observation; null = never observed */
  backlogByProject: Record<string, number> | null;
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
  /** Integration repairs spent this conflict episode (issue #54): a gated run
   * at or past MAX_INTEGRATION_ATTEMPTS is a stalled merge conflict, not a
   * plain sign-off */
  integrationCount: number;
  /** The last verdict the orchestrator POSTED to GitHub for this run. A gated
   * run is a sign-off wait only once this is `approve` (the PR is one human
   * merge away) or `escalate` (the reviewer handed it to a human); until then
   * its review is still in flight (issue #90). */
  reviewVerdict: "approve" | "request-changes" | "escalate" | null;
  /** A finished review pass's parsed output, held until the orchestrator acts.
   * A stored `unparseable` result is terminal by design: the review couldn't be
   * read, the run is parked for a human, and it reads as its own needs-you
   * cause rather than an ordinary sign-off (issue #90). */
  reviewResult:
    | { kind: "approve" | "request-changes" | "escalate"; body: string }
    | { kind: "unparseable"; reason: string }
    | null;
  claimedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface FleetTaskRow {
  id: string;
  projectId: string;
  runId: string | null;
  kind: "interactive" | "implement" | "review" | "triage" | "repair";
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
  /** A run whose review verdict couldn't be read — parked for a human (#90) */
  | "unparseable"
  | "conflict"
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
  /** Card kind: afk = full autonomy, supervised = forced human-signoff,
   * interactive = a chat session, triage = a read-only triage pass (#90) */
  mode: "afk" | "supervised" | "interactive" | "triage";
  /** implement ▸ review ▸ merge pipeline; null for standalone interactive
   * sessions and triage passes, which sit outside the ticket pipeline */
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
  queue: {
    readyForAgent: number | null;
    /** Backlog depth per project, deepest first; null = never observed */
    byProject: { projectName: string; count: number }[] | null;
  };
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

/** A task in one of these statuses is finished — it can hold no slot and
 * renders as no active session, regardless of a stale container_status. */
const TERMINAL_TASK_STATUSES = new Set<FleetTaskRow["status"]>([
  "completed",
  "failed",
  "cancelled",
]);

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
  //
  // A task in a terminal status is never an active session, whatever
  // container_status says: cancellation and completion should null the column,
  // but a stale value (issue #46: a task cancelled months ago still carrying
  // container_status='idle') must not resurrect it as a running session here.
  const occupants = rows.tasks.filter(
    (t) =>
      !TERMINAL_TASK_STATUSES.has(t.status) &&
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
  // exempts them by construction rather than by a filter. The upper bound
  // matters only to the digest, which evaluates the view at the end of a
  // past day over live rows — the view must know nothing after `now`.
  const dayStart = startOfLocalDay(rows.now).getTime();
  const todayUsd = rows.runs
    .filter(
      (r) =>
        r.claimedAt.getTime() >= dayStart &&
        r.claimedAt.getTime() <= rows.now.getTime()
    )
    .reduce((sum, r) => sum + r.totalCostUsd, 0);
  const capPaused = todayUsd >= rows.dailyCapUsd;

  // A run's face in the UI is its latest task — the live container if one
  // exists, otherwise the most recently created pass. A finished pass with a
  // stale container_status is not "live" (issue #46), so the same terminal
  // guard applies here as in the occupants filter.
  const tasksOfRun = (runId: string) =>
    rows.tasks.filter((t) => t.runId === runId);
  const currentTaskOf = (runId: string) => {
    const owned = tasksOfRun(runId);
    return (
      owned.find(
        (t) =>
          t.containerStatus !== null && !TERMINAL_TASK_STATUSES.has(t.status)
      ) ??
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

  // Where a gated run's review stands — the single source of truth for both
  // its needs-you disposition and whether it still reads as fleet activity
  // (issue #90), so the two can never disagree. A gated run is exactly one of
  // these. Precedence: a spent-repairs conflict (issue #54) outranks a stored
  // verdict, an unreadable verdict outranks a posted one, and only a posted
  // approve/escalate is a sign-off wait; anything else means the review is
  // still in flight.
  type GatedDisposition =
    | { kind: "conflict" }
    | { kind: "unparseable" }
    | { kind: "signoff"; verdict: "approve" | "escalate" }
    | { kind: "in-flight" };
  const classifyGated = (run: FleetRunRow): GatedDisposition => {
    if (run.integrationCount >= MAX_INTEGRATION_ATTEMPTS) return { kind: "conflict" };
    if (run.reviewResult?.kind === "unparseable") return { kind: "unparseable" };
    if (run.reviewVerdict === "approve" || run.reviewVerdict === "escalate") {
      return { kind: "signoff", verdict: run.reviewVerdict };
    }
    return { kind: "in-flight" };
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

  // A gated run's needs-you disposition follows where its review stands
  // (issue #90). Repairs spent → a red merge-conflict stall (issue #54); an
  // unreadable verdict → a run parked for a human, its own distinct cause; a
  // posted approve/escalate → a genuine sign-off wait, the PR one human step
  // away. A gated run whose review is still in flight is fleet activity, not a
  // needs-you item — it appears under Running until a verdict lands, so the
  // sign-off bucket never fires prematurely on a still-reviewing PR.
  for (const run of rows.runs.filter((r) => r.status === "gated")) {
    const pr = run.pullRequestNumber;
    const link = (label: string): NeedsYouItem["action"] =>
      run.pullRequestUrl ? { label, href: run.pullRequestUrl } : null;
    const disposition = classifyGated(run);

    if (disposition.kind === "conflict") {
      needsYou.push({
        cause: "conflict",
        severity: "red",
        context: runContext(run),
        body: pr
          ? `PR #${pr} still conflicts with the default branch — resolve and merge`
          : "PR still conflicts with the default branch — resolve and merge",
        action: link(pr ? `Resolve PR #${pr}` : "Resolve PR"),
      });
    } else if (disposition.kind === "unparseable") {
      needsYou.push({
        cause: "unparseable",
        severity: "red",
        context: runContext(run),
        body: pr
          ? `Review verdict couldn't be read on PR #${pr} — parked, nothing merges until you look`
          : "Review verdict couldn't be read — parked, nothing merges until you look",
        action: link(pr ? `Open PR #${pr}` : "Open PR"),
      });
    } else if (disposition.kind === "signoff") {
      needsYou.push({
        cause: "signoff",
        severity: "amber",
        context: runContext(run),
        body:
          disposition.verdict === "escalate"
            ? pr
              ? `PR #${pr} — the reviewer escalated for your sign-off`
              : "PR — the reviewer escalated for your sign-off"
            : pr
              ? `PR #${pr} waits for your sign-off`
              : "PR waits for your sign-off",
        action: link(pr ? `Review PR #${pr}` : "Review PR"),
      });
    }
    // disposition.kind === "in-flight": review still running — fleet activity,
    // surfaced under Running, deliberately not a needs-you item.
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

  // Running = active fleet work. Every run mid-pipeline shows its
  // implement ▸ review ▸ merge phases; a gated run whose review is still in
  // flight (issue #90) is activity too, not a premature sign-off, so it appears
  // here until a verdict lands and moves it to needs-you. Interactive sessions
  // and triage passes are quiet standalone cards holding slots outside the
  // ticket pipeline.
  const ACTIVE_RUN_STATUSES = new Set<FleetRunRow["status"]>([
    "claimed",
    "implementing",
    "reviewing",
    "blocked",
  ]);
  // The pass a run is currently executing. A run under review keeps its
  // implement container parked (idle) for a possible fix-up while the review
  // pass runs, so prefer the actively-running (non-idle) pass — otherwise the
  // card would read as the paused implement rather than the live review.
  const activePassOf = (runId: string): FleetTaskRow | null => {
    const live = tasksOfRun(runId).filter(
      (t) => t.containerStatus !== null && !TERMINAL_TASK_STATUSES.has(t.status)
    );
    const busy = live.filter((t) => t.containerStatus !== "idle");
    const pool = busy.length > 0 ? busy : live;
    return (
      pool.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ??
      null
    );
  };
  // The review stage is live for both the armed path (status `reviewing`) and a
  // gated run whose review is still in flight (the only gated runs that reach
  // Running — a landed verdict routes them to needs-you instead).
  const phasePipeline = (
    reviewing: boolean
  ): NonNullable<RunningCard["phases"]> => [
    { name: "implement", state: reviewing ? "done" : "current" },
    { name: "review", state: reviewing ? "current" : "todo" },
    { name: "merge", state: "todo" },
  ];

  const running: RunningCard[] = rows.runs
    .filter(
      (r) =>
        ACTIVE_RUN_STATUSES.has(r.status) ||
        // A gated run reads as activity only while its review is genuinely in
        // flight — a live pass on a slot. Without one it is either between
        // sweeps or already resolved, not something to show as running.
        (r.status === "gated" &&
          classifyGated(r).kind === "in-flight" &&
          activePassOf(r.id) !== null)
    )
    .sort((a, b) => a.claimedAt.getTime() - b.claimedAt.getTime())
    .map((run) => {
      const pass = activePassOf(run.id);
      const reviewing = run.status === "reviewing" || run.status === "gated";
      // An in-flight review pass reads with its own spend against the review
      // budget (issue #90); the run's rolled-up spend against the attempt
      // budget would read as the implement pass and hide the review's cost.
      const spend =
        pass?.kind === "review"
          ? { usd: pass.totalCostUsd, budgetUsd: DEFAULT_REVIEW_BUDGET_USD }
          : { usd: run.totalCostUsd, budgetUsd: run.budgetUsd };
      return {
        taskId: pass?.id ?? null,
        runId: run.id,
        projectName: projectName(run.projectId),
        ticket: ticketLabel(run.githubIssue),
        title: pass?.title ?? run.githubIssue,
        mode: run.mode === "autonomous" ? ("afk" as const) : ("supervised" as const),
        phases: phasePipeline(reviewing),
        attempt: { current: run.attempt, max: MAX_ATTEMPTS },
        turns: pass?.turns ?? 0,
        startedAt: (run.startedAt ?? run.claimedAt).toISOString(),
        spend,
      };
    });

  // Standalone passes with no ticket pipeline: interactive chat sessions and
  // read-only triage passes (issue #90). Triage reads as its own kind of work
  // with the triage pass's spend against the triage budget; both take their
  // face straight from the occupying task.
  for (const task of occupants.filter(
    (t) => t.kind === "interactive" || t.kind === "triage"
  )) {
    const triage = task.kind === "triage";
    running.push({
      taskId: task.id,
      runId: null,
      projectName: projectName(task.projectId),
      ticket: ticketLabel(task.githubIssue),
      title: task.title,
      mode: triage ? "triage" : "interactive",
      phases: null,
      attempt: null,
      turns: task.turns,
      startedAt: task.createdAt.toISOString(),
      spend: {
        usd: task.totalCostUsd,
        budgetUsd: triage ? DEFAULT_TRIAGE_BUDGET_USD : null,
      },
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

  // Backlog entries answer to the projects table — an observation for a
  // since-deleted project counts nowhere.
  const backlog = rows.backlogByProject
    ? Object.entries(rows.backlogByProject)
        .filter(([projectId]) => projectById.has(projectId))
        .map(([projectId, count]) => ({
          projectName: projectName(projectId),
          count,
        }))
        .sort(
          (a, b) =>
            b.count - a.count || a.projectName.localeCompare(b.projectName)
        )
    : null;

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
    queue: {
      readyForAgent: backlog
        ? backlog.reduce((sum, b) => sum + b.count, 0)
        : null,
      byProject: backlog,
    },
    autonomyOn: rows.projects.some((p) => p.autonomyEnabled),
  };
}
