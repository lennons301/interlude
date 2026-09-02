import type { FleetView, NeedsYouItem } from "@/lib/fleet/fleet-view";
import { ActionLink, Chip, Eyebrow, PAUSE_DOT } from "./fleet-bits";

const CAUSE_LABEL: Record<NeedsYouItem["cause"], string> = {
  blocked: "blocked question",
  signoff: "sign-off",
  unparseable: "verdict error",
  conflict: "merge conflict",
  "checks-failing": "checks failing",
  exhausted: "exhausted",
  cap: "cap pause",
  "metered-cap": "cash cap",
  "metered-confirm": "confirm spend",
  preflight: "preflight",
  "review-stalled": "review stalled",
  "pickup-wedged": "pickup wedged",
  "queue-stale": "queue stalled",
};

const CAUSE_TONE: Record<NeedsYouItem["cause"], "amber" | "red"> = {
  blocked: "amber",
  signoff: "amber",
  unparseable: "red",
  conflict: "red",
  "checks-failing": "red",
  exhausted: "red",
  cap: "red",
  "metered-cap": "red",
  "metered-confirm": "amber",
  preflight: "amber",
  "review-stalled": "red",
  "pickup-wedged": "red",
  "queue-stale": "red",
};

/**
 * Quiet confirmation sub-line: "No active runs · queue empty · autonomy on".
 *
 * Its last part is the one place this panel could contradict the dot above it.
 * `autonomyOn` is only "some project is armed", so under a fleet-wide hold it
 * would read "autonomy on" while nothing can be claimed at all — the exact
 * blindness issue #148 closes. When something holds pickup it says so instead,
 * in the dot's own word (off / held / paused), off the same map.
 */
function quietSubline(view: FleetView): string {
  const parts = [
    view.running.length === 0
      ? "No active runs"
      : `${view.running.length} active run${view.running.length === 1 ? "" : "s"}`,
  ];
  if (view.queue.readyForAgent !== null) {
    parts.push(
      view.queue.readyForAgent === 0
        ? "queue empty"
        : `${view.queue.readyForAgent} ticket${view.queue.readyForAgent === 1 ? "" : "s"} still ready-for-agent`
    );
  }
  parts.push(
    view.pickupPaused
      ? `pickup ${PAUSE_DOT[view.pickupPaused.reason]}`
      : view.autonomyOn
        ? "autonomy on"
        : "autonomy off"
  );
  return parts.join(" · ");
}

export function NeedsYou({ view }: { view: FleetView }) {
  const items = view.needsYou;
  return (
    <section aria-label="Needs you" className="space-y-3">
      <div className="flex items-center gap-2">
        <Eyebrow>Needs you</Eyebrow>
        {items.length > 0 && (
          <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-[4px] bg-fl-amber px-1 font-plex-mono text-[11px] font-medium tabular-nums text-fl-on-amber">
            {items.length}
          </span>
        )}
      </div>

      {items.length === 0 ? (
        <div>
          <p className="text-sm text-fl-ink">Nothing needs you.</p>
          <p className="mt-0.5 font-plex-mono text-[11px] text-fl-ink-3">
            {quietSubline(view)}
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {items.map((item, i) => (
            <li
              key={i}
              className={`rounded-[4px] border border-fl-line bg-fl-card border-l-[3px] ${
                item.severity === "red" ? "border-l-fl-red" : "border-l-fl-amber"
              }`}
            >
              <div className="space-y-1.5 px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <Chip tone={CAUSE_TONE[item.cause]}>{CAUSE_LABEL[item.cause]}</Chip>
                  <span className="truncate font-plex-mono text-[11px] tabular-nums text-fl-ink-3">
                    {item.context}
                  </span>
                </div>
                <p className="text-sm leading-snug text-fl-ink">{item.body}</p>
                {item.action && (
                  <ActionLink href={item.action.href}>
                    {item.action.label} →
                  </ActionLink>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
