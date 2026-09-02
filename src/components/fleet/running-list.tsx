import Link from "next/link";
import type { FleetView, RunningCard } from "@/lib/fleet/fleet-view";
import {
  AttemptPips,
  Chip,
  Eyebrow,
  Gauge,
  Money,
  formatCountdown,
  formatElapsed,
} from "./fleet-bits";

// afk work is the green "the fleet is driving" state; supervised and
// interactive are cool (a human is in the loop); a triage pass is the lightest
// read-only work, so it stays quiet.
const MODE_TONE: Record<RunningCard["mode"], "green" | "cool" | "quiet"> = {
  afk: "green",
  supervised: "cool",
  interactive: "cool",
  triage: "quiet",
};

export function RunningList({ view, now }: { view: FleetView; now: number }) {
  return (
    <section aria-label="Running" className="space-y-3">
      <Eyebrow>Running</Eyebrow>
      {view.running.length === 0 ? (
        <p className="font-plex-mono text-[11px] text-fl-ink-3">nothing running</p>
      ) : (
        <ul className="space-y-2">
          {view.running.map((card) => (
            <li key={card.runId ?? card.taskId}>
              <RunCard card={card} now={now} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * When a quota-paused run comes back (issue #168) — counted down against the
 * client's own clock, like every other time on this screen.
 *
 * A reset that has already passed reads as "quota window has reset" rather than
 * a countdown to nothing: the run is then waiting on the fleet to pick it back
 * up, and saying "resumes in 0m" over and over would be the tile crying wolf in
 * the other direction.
 */
function PausedLine({ resumeAfter, now }: { resumeAfter: string; now: number }) {
  const resumesIn = formatCountdown(resumeAfter, now);
  return (
    <p className="font-plex-mono text-[11px] text-fl-ink-3">
      {resumesIn === null
        ? "rate limited — quota window has reset"
        : `rate limited — resumes in ${resumesIn}`}
    </p>
  );
}

function RunCard({ card, now }: { card: RunningCard; now: number }) {
  const inner = (
    <div className="space-y-2 rounded-[4px] border border-fl-line bg-fl-card px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-plex-mono text-[12px] text-fl-ink-2">
          {card.projectName}
          {card.ticket && <span className="text-fl-ink"> {card.ticket}</span>}
        </span>
        {/* A paused run says so where it sits, in place of its mode (issue
            #168): "afk" over a run waiting on a quota window would claim the
            fleet is driving it. Quiet, because nothing is asked of anyone —
            that is also why it never reaches "needs you".
            A generation session reads as "session · grill-me", not the bare
            "interactive" mode, so grilling is distinct from an agent driving
            (issue #61). */}
        <Chip tone={card.paused ? "quiet" : MODE_TONE[card.mode]}>
          {card.paused
            ? "paused"
            : card.sessionSkill
              ? `session · ${card.sessionSkill}`
              : card.mode}
        </Chip>
      </div>

      <p className="truncate text-sm text-fl-ink">{card.title}</p>

      {card.paused && <PausedLine resumeAfter={card.paused.resumeAfter} now={now} />}

      {card.phases && (
        <div className="flex items-center gap-1.5 font-plex-mono text-[11px]">
          {card.phases.map((phase, i) => (
            <span key={phase.name} className="inline-flex items-center gap-1.5">
              {i > 0 && <span className="text-fl-ink-3">▸</span>}
              <span
                className={
                  phase.state === "current"
                    ? // A paused run's current phase is not being worked, so it
                      // stays quiet: green here would say the agent is in it.
                      card.paused
                      ? "text-fl-ink-3"
                      : "text-fl-green"
                    : phase.state === "done"
                      ? "text-fl-ink-3 line-through"
                      : "text-fl-ink-3"
                }
              >
                {phase.name}
              </span>
            </span>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between gap-2 font-plex-mono text-[11px] tabular-nums text-fl-ink-2">
        <span className="flex items-center gap-2.5">
          {card.attempt && <AttemptPips current={card.attempt.current} max={card.attempt.max} />}
          <span>{card.turns} turn{card.turns === 1 ? "" : "s"}</span>
          {card.startedAt && <span>{formatElapsed(card.startedAt, now)}</span>}
        </span>
        <span>
          <Money usd={card.spend.usd} />
          {card.spend.budgetUsd !== null && (
            <span className="text-fl-ink-3">
              {" "}/ <Money usd={card.spend.budgetUsd} />
            </span>
          )}
        </span>
      </div>

      {card.spend.budgetUsd !== null && (
        <Gauge value={card.spend.usd} max={card.spend.budgetUsd} tone="green" />
      )}
    </div>
  );

  return card.taskId ? (
    <Link href={`/tasks/${card.taskId}`} className="block">
      {inner}
    </Link>
  ) : (
    inner
  );
}
