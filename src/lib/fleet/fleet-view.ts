/**
 * The fleet read model (Phase 5, issue #21). `buildFleetView(rows)` is pure:
 * every row it depends on is passed in — including `now` — so the dashboard
 * and the daily digest render one shared, table-testable structure and can
 * never disagree about the state of the fleet.
 */

export interface FleetRows {
  /** Current time — passed in, never read inside */
  now: Date;
  /** Total agent slots, from the boot-time capacity derivation */
  slots: number;
  /** Daily estate-wide autonomous spend cap in USD */
  dailyCapUsd: number;
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
  needsYou: never[];
  running: never[];
  recent: { windowDays: number; totalUsd: number; items: never[] };
  queue: { readyForAgent: number | null };
}

/** "owner/repo#34" -> "#34"; null when the ref has no issue number */
function ticketLabel(githubIssue: string | null): string | null {
  const match = githubIssue?.match(/#(\d+)$/);
  return match ? `#${match[1]}` : null;
}

export function buildFleetView(rows: FleetRows): FleetView {
  const projectById = new Map(rows.projects.map((p) => [p.id, p]));
  const runById = new Map(rows.runs.map((r) => [r.id, r]));
  const projectName = (id: string) => projectById.get(id)?.name ?? id;

  // A slot is a live container. Tasks are the container unit for every kind
  // of work, so occupancy — and what saturation is attributable to — reads
  // straight off tasks with a container status.
  const occupants = rows.tasks.filter((t) => t.containerStatus !== null);
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

  return {
    generatedAt: rows.now.toISOString(),
    slots: {
      total: rows.slots,
      used: occupants.length,
      saturated: occupants.length >= rows.slots,
      segments,
    },
    spend: { todayUsd: 0, capUsd: rows.dailyCapUsd, capPaused: false },
    needsYou: [],
    running: [],
    recent: { windowDays: 7, totalUsd: 0, items: [] },
    queue: { readyForAgent: rows.readyForAgentCount },
  };
}
