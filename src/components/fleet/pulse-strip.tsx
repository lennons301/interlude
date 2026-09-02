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
      {/* Real money, kept as its own row rather than folded into the gauge
          above (issue #174). The two measure different things — that one is
          autonomous work against a quota-funded plan, this one is cash — and
          they overlap, so one bar showing their sum would be a number that
          means nothing. Shown whenever the fleet is on a metered lane or has
          spent cash today, so a day that ran on OpenRouter this morning still
          says what it cost after switching back. */}
      {(spend.metered.active || spend.metered.todayUsd > 0) && (
        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-2 font-plex-mono text-[11px] tabular-nums text-fl-ink-2">
            <span className="flex items-baseline gap-1.5">
              <span>real money</span>
              {spend.metered.laneId !== null && (
                <span className="truncate text-fl-ink-3">
                  {spend.metered.laneId}
                </span>
              )}
            </span>
            <span>
              <Money usd={spend.metered.todayUsd} />
              <span className="text-fl-ink-3">
                {" "}
                / <Money usd={spend.metered.capUsd} />
              </span>
            </span>
          </div>
          <Gauge
            value={spend.metered.todayUsd}
            max={spend.metered.capUsd}
            tone={spend.metered.capPaused ? "red" : "amber"}
          />
        </div>
      )}
      <QuotaTile quota={view.quota} lane={view.quotaLane} now={now} />
    </section>
  );
}
