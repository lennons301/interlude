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
  MAX_CI_REPAIR_ATTEMPTS,
  MAX_INTEGRATION_ATTEMPTS,
} from "../orchestrator/autonomy/budgets";
import { formatDuration, type FleetHealthSignals } from "./health";

export interface FleetRows {
  /** Current time — passed in, never read inside */
  now: Date;
  /** Total agent slots, from the boot-time capacity derivation */
  slots: number;
  /** Daily estate-wide autonomous spend cap in USD */
  dailyCapUsd: number;
  /** The global kill switch (issue #118), from the durable settings row: while
   * engaged the sweep claims nothing new, so the dashboard has to say so — a
   * held fleet and an idle one look identical otherwise */
  globalAutonomyPaused: boolean;
  /** The env boot master `AUTONOMY_ENABLED` (issue #148), fixed at boot: false
   * and no sweep starts at all, so nothing anywhere can be picked up however
   * the runtime holds read. Carried here because the surfaces were otherwise
   * blind to it — a fleet with autonomy off at boot rendered as a running one.
   * Distinct from `globalAutonomyPaused` in what lifts it: a config change and
   * a restart, not a press on /settings. */
  autonomyEnabledAtBoot: boolean;
  /** Discord guild for deep links into project channels; null = no Discord */
  discordGuildId: string | null;
  projects: FleetProjectRow[];
  runs: FleetRunRow[];
  tasks: FleetTaskRow[];
  /** Tickets armed `ready-for-agent` and not yet claimed, keyed by project
   * id — the sweep's last tracker observation; null = never observed */
  backlogByProject: Record<string, number> | null;
  /** Open `ready-for-human` issue refs, keyed by project id — the sweep's last
   * tracker observation of tickets still awaiting a human. An exhausted run
   * whose project was observed but whose issue is absent has been dealt with
   * (closed, or the label dropped) and stops needing you. null = never
   * observed; a project absent from the map = not yet observed (both fall back
   * to the 7-day window). See {@link buildFleetView}'s exhausted filter. */
  needsHumanByProject: Record<string, string[]> | null;
  /** The sweep's last fleet-health evaluation (issue #126) — owed-review
   * stalls, a wedged pickup, a stale queue heartbeat. null = never evaluated
   * (no sweep yet), which renders no health cards. Computed by the sweep, not
   * derivable from DB rows alone (it needs live orchestrator state: the queue
   * heartbeat and occupied-vs-total slots), so it arrives via a store like the
   * backlog/needs-human observations. */
  fleetHealth: FleetHealthSignals | null;
  /** Failing check names keyed by run id (issue #130) — the sweep's last rollup
   * observation for each parked PR it saw red. A run absent from the map has no
   * red rollup right now, so a spent CI-repair counter alone never raises a card
   * (the window after a repair pushes, while the new head's checks run, is not a
   * stall). null = never observed (no sweep yet), which renders no such cards. */
  failingChecksByRun: Record<string, string[]> | null;
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
  /** CI repairs spent this failing-checks episode (issue #130): a gated run at
   * or past MAX_CI_REPAIR_ATTEMPTS whose rollup is still observed red is a
   * stalled red build, not a plain sign-off */
  ciRepairCount: number;
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

/** Generation-session skills (issue #61) — kept as a decoupled union here, in
 * step with the row types the view defines rather than importing from the DB
 * schema. Its single runtime source of truth is SESSION_SKILLS in the schema. */
export type SessionSkill =
  | "grill-me"
  | "grill-with-docs"
  | "triage"
  | "to-spec"
  | "to-tickets"
  | "wayfinder";

export interface FleetTaskRow {
  id: string;
  projectId: string;
  runId: string | null;
  kind: "interactive" | "implement" | "review" | "triage" | "repair";
  /** Non-null marks an interactive task as a generation session (issue #61) */
  sessionSkill: SessionSkill | null;
  /** GitHub issue the session is anchored to (owner/repo#n), or null */
  sessionIssue: string | null;
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
  /** A parked PR whose checks stayed red through its repairs (issue #130) */
  | "checks-failing"
  | "exhausted"
  | "cap"
  | "preflight"
  /** Fleet-health watchdog (issue #126): an owed review that never started, a
   * wedged pickup, a queue poll loop gone quiet. */
  | "review-stalled"
  | "pickup-wedged"
  | "queue-stale";

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

/**
 * A fleet-wide hold on new autonomous pickup (issues #118, #148). Three things
 * hold it, and no two are lifted the same way: the boot master
 * (`AUTONOMY_ENABLED`) takes a config change and a restart, the kill switch is
 * a press on /settings, and the daily cap lifts itself at local midnight. So
 * each carries its own reason and its own copy — telling an owner to lift a
 * switch that would change nothing is the failure this field exists to remove.
 *
 * Per-project holds are deliberately NOT here (issue #148): a fleet of six
 * armed projects, one of them failing preflight, is not a held fleet, and
 * saying so here would over-claim. Those ride {@link ProjectPickupHold}, said
 * beside the project they belong to.
 *
 * Deliberately its own union rather than the reducer's `PauseReason` (which also
 * covers per-project and no-slots holds, neither of them fleet-wide) — the same
 * decoupling this file states for SessionSkill: the read model answers to what
 * the dashboard renders, not to another module's enum.
 */
export interface PickupPause {
  reason: "autonomy-off-at-boot" | "kill-switch" | "daily-cap";
  /** One-line banner copy */
  body: string;
}

/**
 * Why one project can't have its tickets claimed right now (issue #148), for
 * the surfaces that already list projects. The reducer fails closed on
 * preflight — a repo whose preflight has never run is as ineligible as one
 * that failed — so "never checked" is its own hold rather than a silent pass.
 *
 * The project's own autonomy toggle is here for the same reason preflight is:
 * a backlog depth printed with nothing beside it reads as work about to
 * start. A hold this union omitted would be exactly the blindness the ticket
 * closes, so it states every reason `decideNext` refuses a project for.
 */
export type ProjectPickupHold =
  | "autonomy-off"
  | "preflight-failing"
  | "preflight-unchecked";

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
  /** Non-null on a generation session (issue #61): the dashboard and digest
   * label it "session · <skill>" to distinguish it from a plain chat task.
   * Always null for afk/supervised/triage cards. */
  sessionSkill: SessionSkill | null;
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
  /** Why no new autonomous work is being picked up, or null while nothing
   * fleet-wide holds it (issues #118, #148) — the live dot, the banner and the
   * digest all read this one field, so the surfaces cannot disagree about
   * whether the fleet is running. More than one cause can hold at once; they
   * are named in the order of what a reader must act on first (see the
   * precedence at the assignment). The cap's own `spend.capPaused` is
   * untouched — the gauge and the digest's Spend section read that. */
  pickupPaused: PickupPause | null;
  needsYou: NeedsYouItem[];
  running: RunningCard[];
  recent: { windowDays: number; totalUsd: number; items: RecentItem[] };
  queue: {
    readyForAgent: number | null;
    /** Backlog depth per project, deepest first; null = never observed. `hold`
     * (issue #148) is why that project's tickets can't be claimed — null means
     * only that nothing *project-specific* holds them, since a fleet-wide hold
     * is said once in `pickupPaused` rather than repeated per row. */
    byProject:
      | { projectName: string; count: number; hold: ProjectPickupHold | null }[]
      | null;
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

/**
 * Why `decideNext` would refuse this project's tickets, or null when nothing
 * project-specific would (issue #148). Preflight fails closed exactly as the
 * reducer does: only `passing` clears, so a preflight that has never run holds
 * pickup just as a failing one does — and says which, because "we never
 * checked" and "we checked and it's broken" ask different things of a reader.
 */
function projectHold(project: FleetProjectRow): ProjectPickupHold | null {
  if (!project.autonomyEnabled) return "autonomy-off";
  if (project.preflightStatus === "passing") return null;
  return project.preflightStatus === "failing"
    ? "preflight-failing"
    : "preflight-unchecked";
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

/** "owner/repo#34" -> "repo #34" — a compact context label for a fleet-health
 * card, which has no run/project row to hand (the signal carries only a ref). */
function repoTicket(issueRef: string): string {
  const match = issueRef.match(/^[^/#]+\/([^/#]+)#(\d+)$/);
  return match ? `${match[1]} #${match[2]}` : issueRef;
}

const RECENT_WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/** "an automated repair" / "2 automated repairs" — a spent repair bound reads
 * as prose in the card, not as a bare number. */
function repairCount(n: number): string {
  return n === 1 ? "an automated repair" : `${n} automated repairs`;
}

/** How many failing checks a needs-you body names before summarising the rest —
 * one broken build matrix must not push a card off the screen. */
const NAMED_CHECK_LIMIT = 3;

function namedChecks(checks: string[]): string {
  const rest = checks.length - NAMED_CHECK_LIMIT;
  const shown = checks.slice(0, NAMED_CHECK_LIMIT).join(", ");
  return rest > 0 ? `${shown} +${rest} more` : shown;
}

/** A task in one of these statuses is finished — it can hold no slot and
 * renders as no active session, regardless of a stale container_status. */
const TERMINAL_TASK_STATUSES = new Set<FleetTaskRow["status"]>([
  "completed",
  "failed",
  "cancelled",
]);

/** A live task still has a container and hasn't reached a terminal status — a
 * stale container_status on a finished task (issue #46) is not "live". The one
 * predicate behind slot occupancy and every run's card face. */
const isLiveTask = (t: FleetTaskRow): boolean =>
  t.containerStatus !== null && !TERMINAL_TASK_STATUSES.has(t.status);

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
      isLiveTask(t) && !(t.kind !== "interactive" && t.containerStatus === "idle")
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

  // What the live dot, the banner and the digest all say (issues #118, #148).
  // Precedence is by what a reader must act on, and it is why the boot master
  // leads: with `AUTONOMY_ENABLED` off no sweep runs at all, so naming the kill
  // switch there would send an owner to press a control that changes nothing.
  // Below it the switch outranks the cap — both can hold, but the switch is the
  // one a human engaged and the one they can lift, while midnight lifts the cap
  // on its own. Whichever wins, the others keep their own surfaces: the cap's
  // gauge and needs-you card are untouched by being outranked here.
  const pickupPaused: PickupPause | null = !rows.autonomyEnabledAtBoot
    ? {
        reason: "autonomy-off-at-boot",
        body: "Autonomy is off on this install (AUTONOMY_ENABLED) — no sweep runs at all, so nothing is claimed; the kill switch cannot start one",
      }
    : rows.globalAutonomyPaused
      ? {
          reason: "kill-switch",
          body: "Kill switch engaged — no new autonomous pickup; runs already in flight continue",
        }
      : capPaused
        ? {
            reason: "daily-cap",
            body: "Daily cap reached — autonomous pickup paused until midnight",
          }
        : null;

  const tasksOfRun = (runId: string) =>
    rows.tasks.filter((t) => t.runId === runId);

  // Newest pass first, with a stable id tiebreak so a createdAt collision
  // between two passes can't resolve arbitrarily (ULIDs sort by creation time).
  const byNewest = (a: FleetTaskRow, b: FleetTaskRow) =>
    b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id);

  // A pass whose container is actually executing: live (issue #46's terminal
  // guard) and not parked idle. The one predicate behind both pickPass's busy
  // preference and the gated-run activity gate (hasBusyPass).
  const isBusyPass = (t: FleetTaskRow): boolean =>
    isLiveTask(t) && t.containerStatus !== "idle";

  // The pass kinds that make up a run's current phase: a reviewing or gated run
  // is on its review pass; every other status is on its implement/repair pass.
  // This mirrors the orchestrator's own workingTaskOf, which selects the working
  // pass by kind — the view must resolve a run's face by phase, not by inferring
  // it from container_status races (issue #96).
  const phaseKinds = (status: FleetRunRow["status"]): FleetTaskRow["kind"][] =>
    status === "reviewing" || status === "gated"
      ? ["review"]
      : ["implement", "repair"];

  // Pick a run's face from the passes of its current phase: prefer the container
  // actually executing, else the newest. When the review pass has finished but
  // the run is still reviewing (its container gone, or idle between turns), no
  // pass is busy, so the newest — deliberately including that finished review
  // pass — is returned. That is the point: the card stays on the review pass
  // rather than the parked implement beside it (issue #96, symptom 1).
  const pickPass = (pool: FleetTaskRow[]): FleetTaskRow | null => {
    const busy = pool.filter(isBusyPass);
    return (busy.length > 0 ? busy : pool).sort(byNewest)[0] ?? null;
  };

  // A run's live face — the task its card shows and links to — resolved within
  // the run's current phase only. If that phase owns no pass yet (a brief window
  // after the status flips to reviewing, before the review pass is queued), the
  // card links nowhere rather than falling back to the wrong-phase implement
  // pass: a non-clickable review card, not a link to the finished implement task
  // (issue #96). It also resolves duplicate review passes (issue #95) to the one
  // really running.
  const currentPassOf = (run: FleetRunRow): FleetTaskRow | null =>
    pickPass(
      tasksOfRun(run.id).filter((t) => phaseKinds(run.status).includes(t.kind))
    );

  // Whether a run has a container actually executing right now — a live,
  // non-idle pass on a slot. A gated run reads as fleet activity only while this
  // holds; without it the run is between sweeps or already resolved (issue #90).
  const hasBusyPass = (runId: string): boolean =>
    tasksOfRun(runId).some(isBusyPass);

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
    const task = currentPassOf(run);
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
    | { kind: "checks-failing"; checks: string[] }
    | { kind: "unparseable" }
    | { kind: "signoff"; verdict: "approve" | "escalate" }
    | { kind: "in-flight" };
  const classifyGated = (run: FleetRunRow): GatedDisposition => {
    if (run.integrationCount >= MAX_INTEGRATION_ATTEMPTS) return { kind: "conflict" };
    // Red checks (issue #130) take both facts: the repairs are spent AND the
    // sweep still sees the rollup red. The counter alone would raise a card in
    // the window after a repair pushes, while the new head's checks are pending.
    const failingChecks = rows.failingChecksByRun?.[run.id];
    if (run.ciRepairCount >= MAX_CI_REPAIR_ATTEMPTS && failingChecks?.length) {
      return { kind: "checks-failing", checks: failingChecks };
    }
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

  // Fleet-health watchdog (issue #126): the machinery itself has stalled, so
  // these outrank any single run's question or sign-off. A dead queue or a
  // wedged pickup halts the whole frontier (the parent #115 incident hid one for
  // ~1.5h behind a dashboard that read healthy); an owed review that never
  // started strands a specific PR. All red — nothing progresses until you look.
  const health = rows.fleetHealth;
  if (health?.queueStale) {
    needsYou.push({
      cause: "queue-stale",
      severity: "red",
      context: "queue loop",
      body: `Queue poll loop hasn't made progress for ${formatDuration(
        health.queueStale.staleForMs
      )} — dispatch is likely wedged`,
      action: null,
    });
  }
  if (health?.pickupWedged) {
    needsYou.push({
      cause: "pickup-wedged",
      severity: "red",
      context: "pickup",
      body: `${health.pickupWedged.detail} for ${formatDuration(
        health.pickupWedged.wedgedForMs
      )}`,
      action: null,
    });
  }
  for (const stall of health?.owedReviewStalls ?? []) {
    const prTag = `PR #${stall.prNumber}`;
    needsYou.push({
      cause: "review-stalled",
      severity: "red",
      context: `${repoTicket(stall.issueRef)} · ${prTag}`,
      body: `Review hasn't started for ${formatDuration(
        stall.stalledForMs
      )} — ${stall.reason}`,
      action: stall.prUrl ? { label: `Open ${prTag}`, href: stall.prUrl } : null,
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
    // "PR #55" when the number is known, a bare "PR" otherwise — the copy and
    // the action label share it, so neither has to re-branch on the number.
    const prTag = run.pullRequestNumber ? `PR #${run.pullRequestNumber}` : "PR";
    const link = (label: string): NeedsYouItem["action"] =>
      run.pullRequestUrl ? { label, href: run.pullRequestUrl } : null;
    const disposition = classifyGated(run);

    if (disposition.kind === "conflict") {
      needsYou.push({
        cause: "conflict",
        severity: "red",
        context: runContext(run),
        body: `${prTag} still conflicts with the default branch — resolve and merge`,
        action: link(`Resolve ${prTag}`),
      });
    } else if (disposition.kind === "checks-failing") {
      needsYou.push({
        cause: "checks-failing",
        severity: "red",
        context: runContext(run),
        body:
          `${prTag} checks still failing after ${repairCount(run.ciRepairCount)}: ` +
          namedChecks(disposition.checks),
        action: link(`Open ${prTag}`),
      });
    } else if (disposition.kind === "unparseable") {
      needsYou.push({
        cause: "unparseable",
        severity: "red",
        context: runContext(run),
        body: `Review verdict couldn't be read on ${prTag} — parked, nothing merges until you look`,
        action: link(`Open ${prTag}`),
      });
    } else if (disposition.kind === "signoff") {
      needsYou.push({
        cause: "signoff",
        severity: "amber",
        context: runContext(run),
        body:
          disposition.verdict === "escalate"
            ? `${prTag} — the reviewer escalated for your sign-off`
            : `${prTag} waits for your sign-off`,
        action: link(`Review ${prTag}`),
      });
    }
    // disposition.kind === "in-flight": review still running — fleet activity,
    // surfaced under Running, deliberately not a needs-you item.
  }

  // An exhausted ticket needs a human until they re-arm it (a newer run
  // exists for the issue), until the tracker shows they've dealt with it, or
  // — the backstop — until it ages out of the recent window. The DB can't see
  // the tracker on its own, so the sweep records which issues are still open
  // and `ready-for-human` (needsHumanByProject); an exhausted run whose
  // project was observed but whose issue has left that set was resolved
  // outside a fresh loop (a human merged the fix or dropped the label) and no
  // longer names an outstanding action. Only the window applies to a project
  // the sweep hasn't observed — clearing on absence there would be guessing.
  const windowStart = rows.now.getTime() - RECENT_WINDOW_DAYS * DAY_MS;
  const resolvedOnTracker = (r: FleetRunRow): boolean => {
    const observed = rows.needsHumanByProject?.[r.projectId];
    return observed !== undefined && !observed.includes(r.githubIssue);
  };
  const exhausted = rows.runs.filter(
    (r) =>
      r.status === "exhausted" &&
      (r.finishedAt?.getTime() ?? 0) >= windowStart &&
      !resolvedOnTracker(r) &&
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
          hasBusyPass(r.id))
    )
    .sort((a, b) => a.claimedAt.getTime() - b.claimedAt.getTime())
    .map((run) => {
      const pass = currentPassOf(run);
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
        sessionSkill: null,
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
      // A generation session shows the issue it's anchored to (issue #61); the
      // anchor lives in sessionIssue, never githubIssue, on an interactive task.
      ticket: ticketLabel(task.githubIssue ?? task.sessionIssue),
      title: task.title,
      mode: triage ? "triage" : "interactive",
      // Only an interactive session carries a skill; the autonomous triage pass
      // (kind=triage) is never a generation session.
      sessionSkill: triage ? null : task.sessionSkill,
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
  // failing preflight needs nothing from anyone. Read through the same
  // projectHold the backlog rows use, so a card and a backlog line can never
  // disagree about whether a project is pickable; and each card says the
  // consequence, not just the state, because "preflight failing" alone leaves
  // the reader to infer that nothing is being claimed there (issue #148).
  for (const project of rows.projects) {
    if (!project.autonomyEnabled) continue;
    const hold = projectHold(project);
    if (hold === null) continue;
    needsYou.push({
      cause: "preflight",
      severity: "amber",
      context: project.name,
      body:
        hold === "preflight-failing"
          ? `Preflight failing, so none of its tickets are picked up: ${project.preflightReason ?? "reason unknown"}`
          : "Preflight has never run, so none of its tickets are picked up — pickup fails closed until it passes.",
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
    const task = currentPassOf(run);
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
          hold: projectHold(projectById.get(projectId)!),
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
    pickupPaused,
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
