"use client";

import {
  Chip,
  LoadFailure,
  PANEL_PLAIN,
} from "@/components/fleet/fleet-bits";
import {
  FALL_THROUGH,
  OptionChip,
  fallbackLine,
  useSettingsOverrides,
} from "@/components/settings-overrides";
import type { SettingDetail, SettingFieldView } from "@/lib/settings-resolver";

/**
 * The quota admission threshold (issue #171): how full the account's quota
 * window may get before the fleet stops claiming new tickets.
 *
 * Its own panel rather than a row among the model tiers, because it answers a
 * different question — that panel is "what does the fleet run on", this one is
 * "when does it stop starting things" — and it belongs beside the kill switch
 * in the reader's mind even though it is not one: the switch is a decision, the
 * threshold is a policy the fleet applies to an observation.
 *
 * The chips are a fixed set rather than a free number on purpose. The spread
 * offered is finer than the decision it feeds, so nothing useful is out of
 * reach; a value outside it is refused with the list rather than clamped; and
 * the control stays the one-press radio the rest of the room speaks, with
 * `environment` as the way back to the deployment's own default.
 */

type PercentDetail = Extract<SettingDetail, { kind: "percent" }>;
type PercentFieldView = SettingFieldView & { detail: PercentDetail };

function isQuotaThresholdField(
  field: SettingFieldView
): field is PercentFieldView {
  return (
    field.key === "quotaPickupThresholdPercent" &&
    field.detail.kind === "percent"
  );
}

export function QuotaGateSettings() {
  const { state, loadError, reload, busyKey, saveError, choose } =
    useSettingsOverrides();

  if (state === null) {
    return (
      <div className={PANEL_PLAIN}>
        {loadError === null ? (
          <p className="font-plex-mono text-[11px] text-fl-ink-3">checking…</p>
        ) : (
          <LoadFailure
            what="the quota gate"
            error={loadError}
            onRetry={reload}
          />
        )}
      </div>
    );
  }

  const field = state.fields.find(isQuotaThresholdField);
  if (!field) return null;

  const selected = field.override ?? FALL_THROUGH;

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
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1.5">
          <legend className="contents">
            <span className="text-sm text-fl-ink">{field.label}</span>
          </legend>
          <div className="flex flex-wrap items-center gap-1.5">
            {[...field.options, FALL_THROUGH].map((option) => (
              <OptionChip
                key={option}
                name={field.key}
                option={option}
                label={option === FALL_THROUGH ? option : `${option}%`}
                selected={selected === option}
                disabled={busyKey !== null}
                onSelect={() => choose(field.key, option)}
              />
            ))}
            {busyKey === field.key && (
              <span className="font-plex-mono text-[11px] text-fl-ink-3">…</span>
            )}
          </div>
        </div>

        <p className="text-[13px] text-fl-ink-3">{field.help}</p>

        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-plex-mono text-[11px] text-fl-ink-3">
          <Chip tone={field.source === "override" ? "cool" : "quiet"}>
            {field.source === "override" ? "ui override" : "environment"}
          </Chip>
          <span>holds pickup at {field.detail.percent}%</span>
          <span aria-hidden>·</span>
          <span>{fallbackLine(field)}</span>
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
