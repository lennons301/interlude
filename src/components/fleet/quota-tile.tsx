import type { QuotaGlance } from "@/lib/fleet/fleet-view";
import type { QuotaSeverity } from "@/lib/quota/rate-limit-event";
import { Chip, Gauge, TONES, formatCountdown, formatElapsed } from "./fleet-bits";

/**
 * Where the fleet's quota stands, as last reported by a pass (issue #167).
 *
 * Sits under the spend gauge because it answers the neighbouring question:
 * spend is what the fleet has cost, quota is whether it may keep going at all.
 * Purely a readout — nothing in the fleet acts on this yet.
 *
 * Three states, all of them ordinary:
 *
 *  - **Nothing observed.** A fresh install, and also the permanent state of a
 *    fleet on API-key auth, where the CLI emits no quota telemetry at all
 *    (#165, finding 6). Said plainly rather than drawn as an empty gauge,
 *    which would read as "0% used".
 *  - **Observed without a utilization.** The *usual* shape on the owner's
 *    account: the figure only appears when the reported window has a
 *    claim-scoped utilization header. The gauge is omitted rather than drawn
 *    at zero, for the same reason.
 *  - **Observed with one.** Gauge, in the tone of the status.
 *
 * The observed-at stamp is not decoration: a five-hour window reported nine
 * hours ago says nothing about now, and only the reader can judge that.
 */

const SEVERITY_TONE: Record<QuotaSeverity, keyof typeof TONES> = {
  ok: "green",
  warning: "amber",
  blocked: "red",
  // A status this build has never heard of is shown, in the tone that claims
  // nothing about it — guessing green would be the dangerous guess.
  unknown: "quiet",
};

const GAUGE_TONE: Record<QuotaSeverity, "green" | "amber" | "red" | "cool"> = {
  ok: "green",
  warning: "amber",
  blocked: "red",
  unknown: "cool",
};

export function QuotaTile({
  quota,
  now,
}: {
  quota: QuotaGlance | null;
  now: number;
}) {
  if (quota === null) {
    return (
      <section aria-label="Quota" className="space-y-1.5">
        <div className="flex items-baseline justify-between font-plex-mono text-[11px] text-fl-ink-2">
          <span>quota</span>
          <span className="text-fl-ink-3">not observed yet</span>
        </div>
        <p className="font-plex-mono text-[11px] text-fl-ink-3">
          no pass has reported a limit window
        </p>
      </section>
    );
  }

  const resetsIn = quota.resetsAt ? formatCountdown(quota.resetsAt, now) : null;

  return (
    <section aria-label="Quota" className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2 font-plex-mono text-[11px] tabular-nums text-fl-ink-2">
        <span className="flex items-baseline gap-1.5">
          <span>quota</span>
          <Chip tone={SEVERITY_TONE[quota.severity]}>
            {quota.status.replace(/_/g, " ")}
          </Chip>
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
      {quota.utilization !== null && (
        <Gauge
          value={quota.utilization}
          max={100}
          tone={GAUGE_TONE[quota.severity]}
        />
      )}
      <div className="flex items-baseline justify-between gap-2 font-plex-mono text-[11px] text-fl-ink-3">
        <span>
          {quota.resetsAt === null
            ? "no reset reported"
            : resetsIn === null
              ? "reset time passed"
              : `resets in ${resetsIn}`}
        </span>
        <span>seen {formatElapsed(quota.observedAt, now)} ago</span>
      </div>
    </section>
  );
}
