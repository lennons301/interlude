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
  return parts.join(" · ");
}

function backlogLines(byProject: FleetView["queue"]["byProject"]): string[] {
  if (byProject === null) {
    return ["Not observed — the tracker is only polled while autonomy is on."];
  }
  const withDepth = byProject.filter((b) => b.count > 0);
  return linesOr(
    withDepth.map((b) => `${b.projectName}: ${b.count}`),
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
 * fleet held all day must not arrive here reading like an ordinarily quiet one:
 * the hold leads the digest rather than hiding in a footnote to Spend.
 *
 * The two reasons carry their own copy *and their own tense*, because they are
 * not the same news. The daily cap was breached inside the covered day and
 * lifted itself at local midnight — past news, and the Spend section reports
 * the breach either way. The kill switch has no history to read: the flag comes
 * off the live settings row, so an engaged switch is engaged as the digest is
 * written, and a human is the only thing that lifts it. When both hold, the
 * switch leads (the view's own precedence — it is the one you can lift) and
 * Spend still names the breach, so neither fact is lost.
 */
function pickupLines(view: FleetView, appBaseUrl: string): string[] {
  switch (view.pickupPaused?.reason) {
    case "kill-switch":
      return [
        "⏸ Held — the kill switch is engaged: nothing new is being claimed " +
          "anywhere, and nothing will be until you lift it. Runs already in " +
          "flight and interactive work are unaffected. · " +
          `[Lift it](${appBaseUrl}/settings)`,
      ];
    case "daily-cap":
      return [
        `⏸ Paused — the ${usd(view.spend.capUsd)} daily cap was reached, so ` +
          "pickup stopped for the rest of the day; it lifted at midnight.",
      ];
    default:
      return [
        view.autonomyOn
          ? "Running — no fleet-wide hold."
          : "No project has autonomy enabled — nothing is claimed unattended.",
      ];
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
