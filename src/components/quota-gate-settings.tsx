"use client";

import {
  Chip,
  ChipRadio,
  PANEL_PLAIN,
  fallbackNote,
} from "@/components/fleet/fleet-bits";
import { FALL_THROUGH } from "@/components/settings-overrides";
import type { QuotaThresholdView } from "@/lib/settings-resolver";

/**
 * When the fleet stops claiming (issue #171) — the quota admission gate's one
 * control.
 *
 * Its own panel rather than a row among the model tiers, because it answers a
 * different question: that panel is "what does the fleet run on", this one is
 * "when does it stop starting things". The threshold is a policy the fleet
 * applies to an observation, not a decision like the kill switch, which is why
 * the copy leads with what the gate does *not* hold — a fleet that looks busy
 * while claiming nothing is the confusion this has to head off at the point the
 * number is chosen.
 *
 * The chips are a fixed set rather than a free number on purpose: the spread
 * offered is finer than the decision it feeds, so nothing useful is out of
 * reach; a value outside it is refused with the list rather than clamped; and
 * the control stays the one-press radio the rest of the room speaks, with
 * `environment` as the way back to the deployment's own default.
 *
 * Presentational, and sharing the other panels' state for the same reason they
 * share it with each other: one PATCH returns the whole resolved settings
 * state, so a write here cannot leave another panel showing a stale row.
 */
export function QuotaGatePanel({
  quota,
  busy,
  disabled,
  saveError,
  onChoose,
}: {
  quota: QuotaThresholdView;
  busy: boolean;
  disabled: boolean;
  saveError: string | null;
  onChoose: (choice: string) => void;
}) {
  const selected = quota.override ?? FALL_THROUGH;

  return (
    <div className={`${PANEL_PLAIN} space-y-4`}>
      <p className="text-[13px] text-fl-ink-3">
        Above this much of the account&apos;s quota window — or once the account
        is already being rejected — the fleet stops claiming new tickets, so it
        doesn&apos;t start work it can&apos;t finish. Work already in flight
        runs on, and a parked run still resumes. The kill switch and each
        project&apos;s own autonomy toggle still come first.
      </p>

      <fieldset className="space-y-1.5">
        <legend className="sr-only">{quota.label}</legend>
        <div className="flex flex-wrap items-center gap-1.5">
          {quota.options.map((option) => (
            <ChipRadio
              key={option}
              name="quotaPickupThresholdPercent"
              value={option}
              label={`${option}%`}
              selected={selected === option}
              disabled={disabled}
              onSelect={() => onChoose(option)}
            />
          ))}
          <ChipRadio
            name="quotaPickupThresholdPercent"
            value={FALL_THROUGH}
            selected={selected === FALL_THROUGH}
            disabled={disabled}
            onSelect={() => onChoose(FALL_THROUGH)}
          />
          {busy && (
            <span className="font-plex-mono text-[11px] text-fl-ink-3">…</span>
          )}
        </div>

        <p className="text-[13px] text-fl-ink-3">{quota.help}</p>

        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-plex-mono text-[11px] text-fl-ink-3">
          <Chip tone={quota.source === "override" ? "cool" : "quiet"}>
            {quota.source === "override" ? "ui override" : "environment"}
          </Chip>
          <span>holds pickup at {quota.percent}%</span>
          <span aria-hidden>·</span>
          <span>
            {fallbackNote({
              envVar: quota.envVar,
              envValue: quota.envValue,
              overridden: quota.source === "override",
            })}
          </span>
        </p>
      </fieldset>

      {saveError !== null && (
        <p role="alert" className="text-[13px] text-fl-red">
          {saveError}
        </p>
      )}
    </div>
  );
}
