/**
 * The impure side of the fleet read model: assemble FleetRows from the
 * database and boot-time capacity, then hand them to the pure buildFleetView.
 * Everything here is a thin query layer — no fleet logic lives in this file.
 */

import { db } from "@/db";
import { messages, projects, runs, tasks } from "@/db/schema";
import { and, eq, gte, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { getConfig } from "../config";
import { getFleetSettings } from "../settings";
import { readMoneyGuards } from "../lanes/money-state";
import { resolveQuotaThreshold } from "../settings-resolver";
import { getCapacity } from "../orchestrator/capacity";
import { getBacklogByProject } from "./backlog";
import { getNeedsHumanByProject } from "./needs-human";
import { getFleetHealth } from "./health-store";
import { getFailingChecks } from "./failing-checks";
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
  // One read of the settings row per view build, for every runtime flag it
  // carries — the kill switch, the quota threshold override, the chosen
  // execution lane, the money guards' cap and confirmation — exactly as the
  // sweep reads it each tick, so the dashboard reflects a change on its next
  // SSE push with no restart. The money guards are read through the same
  // function the sweep and the settings panel use, and keyed on `now`, so the
  // digest's view of a past day reports that day's cash rather than this
  // morning's.
  const fleetSettings = getFleetSettings();
  const money = readMoneyGuards(now, fleetSettings);
  // The lane a pass would run on right now (issue #175): the quota row is
  // keyed by lane, so the dashboard must read the same lane's observation the
  // sweep's admission gate does. Deliberately the lane the money guards
  // already resolved rather than a second resolution of the same fact — the
  // two surfaces naming different lanes is the failure per-lane keying exists
  // to prevent.
  const primaryLane: FleetLaneRow | null =
    money.lane === null
      ? null
      : {
          id: money.lane.id,
          label: money.lane.label,
          billing: money.lane.billing,
          adapter: money.lane.adapter,
          // The harness's declared capability (issue #219), off the parsed
          // lane — what tells the tile "cannot report" from "not yet".
          quotaTelemetry: money.lane.capabilities.quotaTelemetry,
        };

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

  // Unfinished, or finished inside the window. The tier figures (issue #198)
  // window by `claimedAt` instead, and lean on this filter being no tighter:
  // a run claimed inside the window is either unfinished or finished inside
  // it, so every row they need is here — narrow this and coverage under-counts
  // silently.
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
    meteredCapUsd: money.cap.capUsd,
    meteredSpendTodayUsd: money.spentTodayUsd,
    primaryLaneId: money.lane?.id ?? null,
    // The *effective* kind, not the declared one (issue #173): an active
    // overage means the subscription lane is already being billed, and the
    // guards must see that.
    primaryLaneBilling: money.billing,
    primaryLaneOverage: money.overagePaying,
    meteredSpendConfirmedAt: fleetSettings.meteredSpendConfirmedAt,
    // Read on every view build, exactly as the sweep reads it each tick — the
    // dashboard reflects a flip on its next SSE push, with no restart.
    globalAutonomyPaused: fleetSettings.globalAutonomyPaused,
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
      harness: t.harness,
      lanePin: t.lanePin,
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
    // the database (issue #159). Taken from the guards' own read rather than
    // read again: they need the same row to tell quota from an active overage
    // (issue #173), and the tile and the gate must judge one instant of it.
    quota: money.quota,
    quotaLane: primaryLane,
    // The threshold that observation is judged against (issue #171), resolved
    // from the same row and the same config the sweep reads — so the banner
    // cannot say "claiming" while the reducer is refusing, or the reverse.
    quotaThresholdPercent: resolveQuotaThreshold(
      getConfig(),
      fleetSettings.overrides
    ).percent,
  };
}

export async function currentFleetView(now: Date): Promise<FleetView> {
  return buildFleetView(await loadFleetRows(now));
}
