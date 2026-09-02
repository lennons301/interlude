/**
 * The deterministic daily digest (Phase 5, issue #22): a pure renderer over
 * the same FleetView the dashboard shows, evaluated over the previous local
 * day. No model anywhere in its path — it queries the ledger and formats
 * what it finds, so it cannot hallucinate its summary and costs nothing.
 */

import {
  startOfLocalDay,
  type FleetView,
  type NeedsYouItem,
  type PickupPause,
  type ProjectPickupHold,
  type RecentItem,
  type RunningCard,
} from "./fleet-view";

/** Half-open interval [start, end) — one local calendar day */
export interface DigestWindow {
  start: Date;
  end: Date;
}

/** The full local calendar day before `now` — what a morning digest covers */
export function previousLocalDay(now: Date): DigestWindow {
  const end = startOfLocalDay(now);
  const start = new Date(end);
  start.setDate(start.getDate() - 1);
  return { start, end };
}

/** Every digest title starts with this — the once-a-morning dedup check in
 * the Discord layer keys on it, so keep it stable. */
export const DIGEST_TITLE_PREFIX = "Daily digest";

// Hand-rolled short names: locale formatting varies by ICU build, and the
// title must be byte-stable for the dedup check.
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function shortDate(date: Date): string {
  return `${DAY_NAMES[date.getDay()]} ${date.getDate()} ${MONTH_NAMES[date.getMonth()]}`;
}

/** "Wed 2 Sep 03:02" — an instant in the fleet's own timezone, hand-rolled for
 * the same reason shortDate is (locale formatting varies by ICU build). */
function shortDateTime(iso: string): string {
  const at = new Date(iso);
  const hours = String(at.getHours()).padStart(2, "0");
  const minutes = String(at.getMinutes()).padStart(2, "0");
  return `${shortDate(at)} ${hours}:${minutes}`;
}

export interface DigestSection {
  heading: string;
  lines: string[];
}

/** Renderer-agnostic digest: the Discord layer maps sections to embed fields */
export interface DigestContent {
  title: string;
  sections: DigestSection[];
}

const OUTCOME_ICON: Record<RecentItem["outcome"], string> = {
  merged: "✅",
  completed: "✅",
  failed: "❌",
  exhausted: "⛔",
};

function usd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/** Discord embed fields hold ~1024 chars; 8 digest lines fit comfortably.
 * Fold the overflow into a count so truncation never reads as "that was
 * everything". */
const MAX_SECTION_LINES = 8;

/** A section never renders empty — silence reads as breakage in a push-only
 * channel, so an empty list becomes an explicit all-quiet line. Busy
 * sections fold beyond MAX_SECTION_LINES. */
function linesOr(lines: string[], whenEmpty: string): string[] {
  if (lines.length === 0) return [whenEmpty];
  if (lines.length <= MAX_SECTION_LINES) return lines;
  return [
    ...lines.slice(0, MAX_SECTION_LINES),
    `…and ${lines.length - MAX_SECTION_LINES} more`,
  ];
}

function runningLine(card: RunningCard): string {
  const where = card.ticket
    ? `${card.projectName} ${card.ticket}`
    : card.projectName;
  const parts = [where, card.title];
  if (card.mode === "interactive") {
    // A generation session reads as "session grill-me", not "interactive", so
    // the digest distinguishes grilling from a plain chat task (issue #61).
    parts.push(
      card.sessionSkill ? `session ${card.sessionSkill}` : "interactive",
      usd(card.spend.usd)
    );
  } else {
    if (card.attempt) {
      parts.push(`attempt ${card.attempt.current}/${card.attempt.max}`);
    }
    parts.push(
      card.spend.budgetUsd === null
        ? usd(card.spend.usd)
        : `${usd(card.spend.usd)} of ${usd(card.spend.budgetUsd)}`
    );
    if (card.mode === "supervised") parts.push("supervised");
  }
  // A paused run is listed with the others but never as one of them (issue
  // #168): the digest reads the same `paused` field the dashboard does, so the
  // two surfaces cannot disagree about whether a run is being worked. The reset
  // is stated, not counted down — a digest is read hours after it is written.
  if (card.paused) {
    parts.push(`paused, quota resets ${shortDateTime(card.paused.resumeAfter)}`);
  }
  // Same argument, one ticket later (issue #170): the digest reads the same
  // `degraded` field the dashboard does, so neither can claim a run is on a
  // tier the other says it left.
  if (card.degraded) {
    parts.push(`at ${card.degraded.to}, stepped down from ${card.degraded.from}`);
  }
  return parts.join(" · ");
}

/** What a per-project hold reads as beside its backlog depth (issue #148).
 * Keyed by the union, so a new hold fails the build instead of printing a
 * depth that silently reads as work about to start. */
const HOLD_NOTE: Record<ProjectPickupHold, string> = {
  "autonomy-off": "autonomy is off for this project",
  "preflight-failing": "preflight is failing",
  "preflight-unchecked": "preflight has never passed",
};

/**
 * Backlog depth per project — and, per project, whether that depth is going
 * anywhere. A count on its own reads as work about to start, which for a
 * disarmed or preflight-failing repo it is not; preflight is per-project, so
 * this is where it is said, rather than over-claiming a fleet-wide hold
 * (issue #148).
 */
function backlogLines(byProject: FleetView["queue"]["byProject"]): string[] {
  if (byProject === null) {
    return ["Not observed — the tracker is only polled while autonomy is on."];
  }
  const withDepth = byProject.filter((b) => b.count > 0);
  return linesOr(
    withDepth.map((b) =>
      b.hold === null
        ? `${b.projectName}: ${b.count}`
        : `${b.projectName}: ${b.count} — not picked up: ${HOLD_NOTE[b.hold]}`
    ),
    "No tickets ready-for-agent."
  );
}

function needsYouLine(item: NeedsYouItem, appBaseUrl: string): string {
  let line = `${item.context} — ${item.body}`;
  if (item.action) {
    const href = item.action.href.startsWith("/")
      ? `${appBaseUrl}${item.action.href}`
      : item.action.href;
    line += ` · [${item.action.label}](${href})`;
  }
  return line;
}

/**
 * What is holding autonomous pickup — said first, and every morning (issue
 * #143). The dashboard is pull and the digest is the one push surface, so a
 * held fleet must not arrive here reading like an ordinarily quiet one: the
 * hold leads the digest rather than hiding in a footnote to Spend.
 *
 * Each reason carries its own copy *and its own tense*, because they are not
 * the same news and are not even about the same moment. The daily cap was
 * breached inside the covered day and lifted itself at local midnight — past
 * news, and the Spend section reports the breach either way. The kill switch
 * and the boot master have no history to read: `loadFleetRows` takes the flag
 * off the live settings row and the master off the running process's config, so
 * both say how the fleet stands *as the digest is written*, which is why their
 * lines say so out loud rather than implying anything about yesterday. When
 * several hold, the view's own precedence picks the line (the boot master over
 * the switch, because lifting the switch under it would change nothing) and
 * Spend still names any breach, so no fact is lost.
 *
 * The unheld line claims only what the read model actually knows: that no
 * fleet-wide hold applies. It still does not promise every project was picking
 * up — preflight is per-project, and the Backlog section is where that is said.
 */
function pickupLines(view: FleetView, appBaseUrl: string): string[] {
  const reason: PickupPause["reason"] | null = view.pickupPaused?.reason ?? null;
  switch (reason) {
    case "autonomy-off-at-boot":
      return [
        "⏸ Off right now — autonomy is disabled on this install " +
          "(AUTONOMY_ENABLED), so no sweep runs at all and nothing is claimed " +
          "for any project. The kill switch cannot lift this one: it takes a " +
          "config change and a restart.",
      ];
    case "kill-switch":
      return [
        "⏸ Held right now — the kill switch is engaged: nothing new is being " +
          "claimed anywhere, and nothing will be until you lift it. Runs " +
          "already in flight and interactive work are unaffected. · " +
          `[Lift it](${appBaseUrl}/settings)`,
      ];
    case "daily-cap":
      return [
        `⏸ Paused — yesterday's spend reached the ${usd(view.spend.capUsd)} ` +
          "daily cap, so pickup stopped for the rest of the day; the pause " +
          "lifted at midnight.",
      ];
    case "quota-gate":
      // Said as it stands when the digest is written, like the switch and the
      // master above it: the gate is computed from the latest observation and
      // has no history, so a window that reset overnight leaves the covered day
      // reading quiet. The view's own line already names both numbers.
      return [
        `⏸ Paused right now — ${view.pickupPaused?.body ?? "the quota gate is closed"}. ` +
          "It lifts itself when the window resets; there is nothing to press.",
      ];
    case null:
      return [
        view.autonomyOn
          ? "No fleet-wide hold — autonomy is on, the kill switch is lifted and the day stayed inside the cap."
          : "No project has autonomy enabled — nothing is claimed unattended.",
      ];
    default: {
      // A hold this renderer hasn't been taught is still a hold. The `never`
      // fails the build when PickupPause grows a further reason — the
      // dashboard's own Record<PickupPause["reason"], …> maps already do — and
      // until someone teaches it, the line says held rather than reassuring.
      const unhandled: never = reason;
      return [`⏸ Held — autonomous pickup is paused (${String(unhandled)}).`];
    }
  }
}

function completedLine(item: RecentItem): string {
  const parts = [
    `${OUTCOME_ICON[item.outcome]} ${item.title} — ${item.projectName}`,
    usd(item.costUsd),
  ];
  if (item.prUrl) {
    parts.push(`[PR #${item.prNumber}](${item.prUrl})`);
  }
  return parts.join(" · ");
}

/**
 * Render the digest over a FleetView built at the last instant of `window`
 * (`buildFleetView({...rows, now: window.end - 1ms})`), so the view's own
 * "today" is the covered day. `appBaseUrl` absolutizes the view's in-app
 * links, which are relative for the dashboard.
 */
export function renderDailyDigest(
  view: FleetView,
  window: DigestWindow,
  opts: { appBaseUrl: string }
): DigestContent {
  // view.recent windows 7 days back but has no upper bound — work finished
  // after the covered day (this morning, pre-send) waits for tomorrow.
  const finishedYesterday = view.recent.items.filter((item) => {
    const at = new Date(item.finishedAt).getTime();
    return at >= window.start.getTime() && at < window.end.getTime();
  });

  // The cap card describes a pause that lapsed at midnight — the spend
  // section reports the breach; the blocked list keeps only real waits.
  const waits = view.needsYou.filter((item) => item.cause !== "cap");

  return {
    title: `${DIGEST_TITLE_PREFIX} — ${shortDate(window.start)}`,
    sections: [
      {
        // First, always: whether the fleet was allowed to pick anything up is
        // the frame every other section is read through (issue #143).
        heading: "Autonomous pickup",
        lines: pickupLines(view, opts.appBaseUrl),
      },
      {
        heading: "Completed yesterday",
        lines: linesOr(finishedYesterday.map(completedLine), "Nothing finished."),
      },
      {
        heading: "In flight",
        lines: linesOr(view.running.map(runningLine), "Nothing running."),
      },
      {
        heading: "Blocked on you",
        lines: linesOr(
          waits.map((item) => needsYouLine(item, opts.appBaseUrl)),
          "Nothing waits on you."
        ),
      },
      {
        heading: "Backlog (ready-for-agent)",
        lines: backlogLines(view.queue.byProject),
      },
      {
        // Built at the covered day's last instant, the view's "today" spend
        // IS the day being summarised — the dashboard's own definition:
        // runs claimed since that day's midnight, interactive work exempt.
        heading: "Spend",
        lines: [
          `${usd(view.spend.todayUsd)} of ${usd(view.spend.capUsd)} daily cap` +
            (view.spend.capPaused ? " — cap hit, pickup was paused" : ""),
        ],
      },
    ],
  };
}
