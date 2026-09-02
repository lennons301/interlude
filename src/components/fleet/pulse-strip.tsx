import type { FleetView } from "@/lib/fleet/fleet-view";
import { Gauge, Money } from "./fleet-bits";
import { QuotaTile } from "./quota-tile";

/**
 * The two-second glance: slots as equal segments naming their occupants,
 * today's autonomous spend against the daily cap underneath, and beneath that
 * the quota the fleet is spending it out of (issue #167).
 *
 * `now` is the dashboard's ticking clock, not the view's `generatedAt`: the
 * quota tile's "seen 4m ago" has to keep counting between SSE pushes, exactly
 * as the running cards' elapsed times do.
 */
export function PulseStrip({ view, now }: { view: FleetView; now: number }) {
  const { slots, spend } = view;
  return (
    <section aria-label="Fleet pulse" className="space-y-3">
      <div className="flex gap-1.5">
        {slots.segments.map((segment, i) =>
          segment.occupant === "free" ? (
            <div
              key={i}
              className="flex h-9 flex-1 items-center justify-center rounded-[4px] border border-dashed border-fl-line"
            >
              <span className="font-plex-mono text-[11px] text-fl-ink-3">free</span>
            </div>
          ) : (
            <div
              key={i}
              className={`flex h-9 flex-1 items-center justify-center rounded-[4px] border px-2 ${
                segment.occupant === "autonomous"
                  ? "border-fl-green/45 bg-fl-green/13"
                  : "border-fl-cool/45 bg-fl-cool/13"
              }`}
            >
              <span
                className={`truncate font-plex-mono text-[11px] ${
                  segment.occupant === "autonomous" ? "text-fl-green" : "text-fl-cool"
                }`}
              >
                {segment.occupant === "autonomous"
                  ? `${segment.projectName} ${segment.ticket ?? ""}`.trim()
                  : `you · ${segment.projectName}`}
              </span>
            </div>
          )
        )}
      </div>
      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between font-plex-mono text-[11px] tabular-nums text-fl-ink-2">
          <span>
            today <Money usd={spend.todayUsd} />
          </span>
          <span className="text-fl-ink-3">
            cap <Money usd={spend.capUsd} />
          </span>
        </div>
        <Gauge
          value={spend.todayUsd}
          max={spend.capUsd}
          tone={spend.capPaused ? "red" : "green"}
        />
      </div>
      <QuotaTile quota={view.quota} lane={view.quotaLane} now={now} />
    </section>
  );
}
