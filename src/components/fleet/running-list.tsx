import Link from "next/link";
import type { FleetView, RunningCard } from "@/lib/fleet/fleet-view";
import { harnessLabel } from "@/lib/fleet/tier-prose";
import {
  AttemptPips,
  Chip,
  Eyebrow,
  Gauge,
  Money,
  formatCountdown,
  formatElapsed,
} from "./fleet-bits";
import { LaneMoveControl } from "./lane-move-control";

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
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-plex-mono text-[12px] text-fl-ink-2">
          {card.projectName}
          {card.ticket && <span className="text-fl-ink"> {card.ticket}</span>}
          {/* Who is doing the work (issue #223): the harness stamped on the
              current pass, quiet because it is a name and not a state. A row
              from before the stamp says "unknown harness" rather than reading
              one off the lane file. */}
          <span className="text-fl-ink-3"> · {harnessLabel(card.harness)}</span>
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

      {/* A run the quota ladder stepped down (issue #170). Stated where the
          work is, quietly: nothing is asked of anyone, but the result came from
          a cheaper model than the one this run was asked to use, and that is
          not recoverable from the card otherwise. */}
      {card.degraded && (
        <p className="font-plex-mono text-[11px] text-fl-ink-3">
          running at {card.degraded.to} — stepped down from {card.degraded.from}
        </p>
      )}

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
    </>
  );

  // The card's frame is its own element and the link sits *inside* it, so the
  // paused run's control (issue #202) can share the frame without sitting
  // inside the anchor — a button in a link is not a thing, and a press on it
  // must not also open the task.
  return (
    <div className="rounded-[4px] border border-fl-line bg-fl-card">
      {card.taskId ? (
        <Link href={`/tasks/${card.taskId}`} className="block space-y-2 px-3 py-2.5">
          {body}
        </Link>
      ) : (
        <div className="space-y-2 px-3 py-2.5">{body}</div>
      )}

      {/* Only a parked run can be moved, and only a run has a lane to move: the
          control is absent from every other card rather than present and
          inert, because the route would refuse it with "not parked" and a
          control that can only be refused is noise (issue #202). */}
      {card.paused && card.runId && (
        <div className="border-t border-fl-line px-3 py-2">
          <LaneMoveControl runId={card.runId} ticket={card.ticket} />
        </div>
      )}
    </div>
  );
}
