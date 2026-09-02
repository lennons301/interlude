/**
 * The impure side of the fleet read model: assemble FleetRows from the
 * database and boot-time capacity, then hand them to the pure buildFleetView.
 * Everything here is a thin query layer — no fleet logic lives in this file.
 */

import { db } from "@/db";
import { messages, projects, runs, tasks } from "@/db/schema";
import { and, eq, gte, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { getConfig } from "../config";
import { getSettingsOverrides, isGlobalAutonomyPaused } from "../settings";
import { getCapacity } from "../orchestrator/capacity";
import { getBacklogByProject } from "./backlog";
import { getNeedsHumanByProject } from "./needs-human";
import { getFleetHealth } from "./health-store";
import { getFailingChecks } from "./failing-checks";
import { getQuotaObservation } from "../quota/quota-store";
import { getLaneCatalog } from "../lanes/catalog";
import { findLane } from "../lanes/lane-config";
import { choosePrimaryLane } from "../lanes/resolve";
import type { FleetLaneRow } from "./fleet-view";
import { DAILY_AUTONOMOUS_CAP_USD } from "../orchestrator/autonomy/budgets";
import {
  buildFleetView,
  type FleetRows,
  type FleetView,
} from "./fleet-view";

const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export async function loadFleetRows(now: Date): Promise<FleetRows> {
  const windowStart = new Date(now.getTime() - RECENT_WINDOW_MS);
  const primaryLane = primaryLaneRow();

  // Slots come from the boot-time derivation; if the Docker daemon is
  // unreachable the dashboard should still render, so fall back to the
  // explicit override or a single slot rather than erroring the stream.
  let slots: number;
  try {
    slots = (await getCapacity()).slots;
  } catch {
    slots = getConfig().capacitySlots ?? 1;
  }

  const projectRows = db.select().from(projects).all();

  const runRows = db
    .select()
    .from(runs)
    .where(or(isNull(runs.finishedAt), gte(runs.finishedAt, windowStart)))
    .all();

  const taskRows = db
    .select()
    .from(tasks)
    .where(
      or(
        isNotNull(tasks.containerStatus),
        isNotNull(tasks.runId),
        gte(tasks.updatedAt, windowStart)
      )
    )
    .all();

  // Turns = the initial prompt plus one per delivered follow-up, counted for
  // every started task — not just live containers, so a blocked run whose
  // container died across a restart still shows its real turn count.
  const startedIds = taskRows
    .filter((t) => t.status !== "queued")
    .map((t) => t.id);
  const deliveredCounts = new Map<string, number>();
  if (startedIds.length > 0) {
    const counted = db
      .select({
        taskId: messages.taskId,
        delivered: sql<number>`count(*)`,
      })
      .from(messages)
      .where(
        and(
          inArray(messages.taskId, startedIds),
          eq(messages.role, "user"),
          isNotNull(messages.deliveredAt)
        )
      )
      .groupBy(messages.taskId)
      .all();
    for (const row of counted) deliveredCounts.set(row.taskId, row.delivered);
  }

  return {
    now,
    slots,
    dailyCapUsd: DAILY_AUTONOMOUS_CAP_USD,
    // Read on every view build, exactly as the sweep reads it each tick — the
    // dashboard reflects a flip on its next SSE push, with no restart.
    globalAutonomyPaused: isGlobalAutonomyPaused(),
    // The env boot master (issue #148), from the same config the sweep gates
    // itself on: with it off no sweep ever starts, so the view must be able to
    // say so rather than rendering a fleet that reads healthy and claims nothing.
    autonomyEnabledAtBoot: getConfig().autonomyEnabled,
    discordGuildId: getConfig().discordGuildId,
    projects: projectRows.map((p) => ({
      id: p.id,
      name: p.name,
      autonomyEnabled: p.autonomyEnabled,
      preflightStatus: p.preflightStatus,
      preflightReason: p.preflightReason,
      discordChannelId: p.discordChannelId,
    })),
    runs: runRows,
    tasks: taskRows.map((t) => ({
      id: t.id,
      projectId: t.projectId,
      runId: t.runId,
      kind: t.kind,
      sessionSkill: t.sessionSkill,
      sessionIssue: t.sessionIssue,
      title: t.title,
      status: t.status,
      containerStatus: t.containerStatus,
      totalCostUsd: t.totalCostUsd,
      turns:
        t.status === "queued" ? 0 : 1 + (deliveredCounts.get(t.id) ?? 0),
      githubIssue: t.githubIssue,
      pullRequestNumber: t.pullRequestNumber,
      pullRequestUrl: t.pullRequestUrl,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    })),
    // The sweep's last tracker observation; null (never observed) renders
    // as "queue unknown" rather than a wrong zero.
    backlogByProject: getBacklogByProject(),
    // Open `ready-for-human` refs from the same sweep; null (never observed)
    // leaves the exhausted needs-you cards on the 7-day window alone.
    needsHumanByProject: getNeedsHumanByProject(),
    // The sweep's last fleet-health evaluation (issue #126); null until the
    // first sweep, which renders no health cards.
    fleetHealth: getFleetHealth(),
    // Failing check names per parked run from the same sweep (issue #130); null
    // until the first sweep, which renders no failing-checks cards.
    failingChecksByRun: getFailingChecks(),
    // The last rate-limit event a pass on the *primary lane* saw (issue #167,
    // per-lane since #175), from the durable row rather than an in-memory
    // store: the writer is the stream parser in the orchestrator's module
    // graph and this read happens in the app router's, which share nothing but
    // the database (issue #159).
    quota: getQuotaObservation(primaryLane?.id ?? null),
    quotaLane: primaryLane,
  };
}

/**
 * The lane a pass would run on right now (issue #175), or null when
 * `lanes.yaml` is unusable or names no lane.
 *
 * Resolved the same way a pass resolves it — the catalog, the environment
 * default, the stored override — because the dashboard reporting a *different*
 * lane's quota than the one the fleet is about to spend on would be worse than
 * reporting none. Deliberately `choosePrimaryLane` and not `resolveLane`: this
 * needs the lane's identity, not its credentials, and a lane whose secret is
 * missing still has a quota worth naming.
 */
function primaryLaneRow(): FleetLaneRow | null {
  const catalog = getLaneCatalog();
  if (!catalog.ok) return null;
  const choice = choosePrimaryLane({
    catalog: catalog.catalog,
    override: getSettingsOverrides().primaryLane ?? null,
    envLane: getConfig().agentLane,
    env: process.env,
  });
  const lane = findLane(catalog.catalog, choice.laneId);
  if (!lane) return null;
  return { id: lane.id, label: lane.label, billing: lane.billing };
}

export async function currentFleetView(now: Date): Promise<FleetView> {
  return buildFleetView(await loadFleetRows(now));
}
