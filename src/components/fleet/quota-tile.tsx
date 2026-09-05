import type { QuotaGlance, QuotaLaneGlance } from "@/lib/fleet/fleet-view";
import type { QuotaSeverity } from "@/lib/quota/rate-limit-event";
import { Chip, Gauge, TONES, formatCountdown, formatElapsed } from "./fleet-bits";

/**
 * Where the fleet's quota stands, as last reported by a pass (issue #167).
 *
 * Sits under the spend gauge because it answers the neighbouring question:
 * spend is what the fleet has cost, quota is whether it may keep going at all.
 * Purely a readout — nothing in the fleet acts on this yet.
 *
 * Five states, all of them ordinary:
 *
 *  - **A lane that cannot report quota at all.** One whose *harness* declares
 *    no quota telemetry (issue #219) — keyed on the adapter's capability,
 *    whatever the lane's billing kind, because a subscription lane on such a
 *    harness is subscription-billed and still cannot report. That is a
 *    *different sentence* from "nothing observed yet" (issue #175): one is
 *    permanent and by design, the other is pending. Saying the wrong one would
 *    have an operator waiting for a reading that will never come.
 *  - **Nothing observed.** A lane whose harness could report one and has not.
 *    Said plainly rather than drawn as an empty gauge, which would read as
 *    "0% used". On a metered lane the tile adds that the lane is bounded by
 *    spend: the unified-window machinery is an Anthropic-subscription construct
 *    (#165, finding 6; re-confirmed against OpenRouter on 2026-09-02), so a
 *    metered provider is unlikely ever to emit one — but that is a fact about
 *    the provider, not the harness, and this tile only vouches for the harness.
 *  - **Observed without a utilization.** The *usual* shape on the owner's
 *    account: the figure only appears when the reported window has a
 *    claim-scoped utilization header. The gauge is omitted rather than drawn
 *    at zero, for the same reason.
 *  - **Observed, and its own reset time has since passed.** The reading is
 *    history: the window it describes has turned over, so the words stay and
 *    the colour goes. A red `rejected` chip standing over a wall that lifted
 *    hours ago is the tile crying wolf, and this fleet's other watchdogs are
 *    built not to (see the fleet-health signals' debounce).
 *  - **Observed and current.** Gauge, in the tone of the status.
 *
 * The observed-at stamp is not decoration: a five-hour window reported nine
 * hours ago says nothing about now, and only the reader can judge that.
 */

/**
 * One tone per severity, shared by the chip and the bar so the two can never
 * disagree about how alarming the same reading is. `quiet` is the tone for a
 * reading this build cannot vouch for — a status it has never heard of, or one
 * whose window has since reset — and it is also the tone that draws no bar at
 * all, because a grey gauge would still be a claim about how full the window is.
 */
const QUOTA_TONE: Record<QuotaSeverity, keyof typeof TONES> = {
  ok: "green",
  warning: "amber",
  blocked: "red",
  // Guessing green would be the dangerous guess.
  unknown: "quiet",
};

export function QuotaTile({
  quota,
  lane,
  now,
}: {
  quota: QuotaGlance | null;
  /** The lane the reading belongs to (issue #175); null when no lane resolves. */
  lane: QuotaLaneGlance | null;
  now: number;
}) {
  if (quota === null) {
    // A lane whose harness emits no quota telemetry is not an unobserved one —
    // no reading is ever coming (issue #219). Naming the lane and its harness
    // matters here: it is the one thing that would tell an operator why the
    // tile went quiet after they switched lanes.
    const cannotReport = lane !== null && !lane.reportsQuota;
    return (
      <section aria-label="Quota" className="space-y-1.5">
        <div className="flex items-baseline justify-between gap-2 font-plex-mono text-[11px] text-fl-ink-2">
          <span>quota</span>
          <span className="truncate text-fl-ink-3">
            {cannotReport ? "cannot report" : "nothing observed yet"}
          </span>
        </div>
        <p className="font-plex-mono text-[11px] text-fl-ink-3">
          {cannotReport
            ? `${lane.label} runs on ${lane.adapter}, a harness that emits no quota telemetry`
            : lane?.billing === "metered"
              ? `no pass has reported a limit window — ${lane.label} is metered and bounded by spend`
              : "no pass has reported a limit window"}
        </p>
      </section>
    );
  }

  const resetsIn = quota.resetsAt ? formatCountdown(quota.resetsAt, now) : null;
  // The one thing the tile can work out for itself: an observation that named
  // its own reset, which has since passed, describes a window that no longer
  // exists. Judged against the client's ticking clock, so a tile left open
  // goes quiet the moment it should.
  const spent = quota.resetsAt !== null && resetsIn === null;
  const tone = spent ? "quiet" : QUOTA_TONE[quota.severity];

  return (
    <section aria-label="Quota" className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2 font-plex-mono text-[11px] tabular-nums text-fl-ink-2">
        <span className="flex items-baseline gap-1.5">
          <span>quota</span>
          <Chip tone={tone}>{quota.status.replace(/_/g, " ")}</Chip>
          {quota.limitLabel && (
            <span className="truncate text-fl-ink-3">{quota.limitLabel}</span>
          )}
        </span>
        <span>
          {quota.utilization === null ? (
            <span className="text-fl-ink-3">utilization not reported</span>
          ) : (
            `${Math.round(quota.utilization)}%`
          )}
        </span>
      </div>
      {quota.utilization !== null && tone !== "quiet" && (
        <Gauge value={quota.utilization} max={100} tone={tone} />
      )}
      <div className="flex items-baseline justify-between gap-2 font-plex-mono text-[11px] text-fl-ink-3">
        <span>
          {quota.resetsAt === null
            ? "no reset reported"
            : spent
              ? "reset time passed"
              : `resets in ${resetsIn}`}
        </span>
        <span className="truncate">
          {/* Whose quota: with more than one lane declared, a reading with no
              owner is a reading an operator cannot act on (issue #175). */}
          {lane && <span className="mr-1.5">{lane.label}</span>}
          seen {formatElapsed(quota.observedAt, now)} ago
        </span>
      </div>
    </section>
  );
}
