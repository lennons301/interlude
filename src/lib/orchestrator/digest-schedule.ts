/**
 * Scheduling shell for the daily digest (issue #22). Assembly is pure
 * queries: load the ledger rows, build the same FleetView the dashboard
 * renders — evaluated at the last instant of yesterday — and format it.
 * No model anywhere in the path.
 *
 * "Once each morning" survives restarts without a schema change: ticks are
 * idempotent because they first ask Discord whether today's digest already
 * exists (keyed on the title prefix). Merging an interlude PR redeploys
 * interlude, so a restart straddling the send is routine, not an edge case
 * — a rebooted orchestrator neither double-posts nor drops the morning.
 */

import { getConfig } from "../config";
import { buildFleetView, startOfLocalDay } from "../fleet/fleet-view";
import { previousLocalDay, renderDailyDigest } from "../fleet/digest";
import { loadFleetRows } from "../fleet/rows";
import {
  hasDigestPostedSince,
  postDailyDigest,
} from "../discord/notifications";

/** "Morning" in the orchestrator's local timezone (UTC on the VPS) */
const DIGEST_LOCAL_HOUR = 8;
/** A failed send retries on this cadence until the day runs out */
const RETRY_MS = 5 * 60 * 1000;

let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;

/** Called once at orchestrator init, after the Discord bot is connected */
export function startDailyDigest(): void {
  if (started) return;
  started = true;

  const channelId = getConfig().discordFleetChannelId;
  if (!channelId) {
    console.log("[digest] No DISCORD_FLEET_CHANNEL_ID — daily digest disabled");
    return;
  }

  console.log(`[digest] Daily digest at ${DIGEST_LOCAL_HOUR}:00 local`);
  void tick(channelId);
}

export function stopDailyDigest(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  started = false;
}

async function tick(channelId: string): Promise<void> {
  let nextDelayMs = msUntilNextDue(new Date());
  try {
    await sendIfDue(channelId, new Date());
  } catch (err) {
    console.error("[digest] Digest attempt failed, will retry:", err);
    nextDelayMs = Math.min(nextDelayMs, RETRY_MS);
  }
  timer = setTimeout(() => void tick(channelId), nextDelayMs);
}

/**
 * Post today's digest if it is due and not already posted. Due means we are
 * past this morning's send time — a boot later the same day catches up
 * (late beats missed), but a digest never rolls into the next day: by then
 * its window would no longer be "yesterday".
 */
async function sendIfDue(channelId: string, now: Date): Promise<void> {
  if (now < dueAt(now)) return;
  if (await hasDigestPostedSince(channelId, startOfLocalDay(now))) return;

  const window = previousLocalDay(now);
  // The read model evaluated at the covered day's last instant: its "today"
  // — spend, windows — is exactly the day the digest summarises.
  const viewAt = new Date(window.end.getTime() - 1);
  const view = buildFleetView(await loadFleetRows(viewAt));

  const domain = getConfig().domain ?? "interludes.co.uk";
  const content = renderDailyDigest(view, window, {
    appBaseUrl: `https://${domain}`,
  });

  await postDailyDigest(channelId, content);
  console.log(`[digest] Posted "${content.title}"`);
}

/** This morning's send time in local time */
function dueAt(now: Date): Date {
  const due = startOfLocalDay(now);
  due.setHours(DIGEST_LOCAL_HOUR);
  return due;
}

function msUntilNextDue(now: Date): number {
  const due = dueAt(now);
  if (now < due) return due.getTime() - now.getTime();
  due.setDate(due.getDate() + 1);
  return due.getTime() - now.getTime();
}
