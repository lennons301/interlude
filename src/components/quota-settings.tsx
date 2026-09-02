"use client";

import {
  Chip,
  ChipRadio,
  PANEL_PLAIN,
  fallbackNote,
} from "@/components/fleet/fleet-bits";
import { FALL_THROUGH } from "@/components/settings-overrides";
import type { SettingCountView } from "@/lib/settings-resolver";

/**
 * How far a run may ride the account's quota (issue #169): how many times one
 * attempt may pause on a rate limit and be resumed before its ticket goes to a
 * human.
 *
 * Beside the model tiers rather than under Autonomy, because it is the same
 * kind of knob and answers to the same layer — an unset row follows the
 * deployment's own variable, a set one wins and says so. What differs is that
 * this one is a *count*, so the row names the number in force rather than the
 * model a tier resolves to.
 */
export function QuotaPanel({
  field,
  busy,
  disabled,
  saveError,
  onChoose,
}: {
  field: SettingCountView | null;
  busy: boolean;
  disabled: boolean;
  saveError: string | null;
  onChoose: (choice: string) => void;
}) {
  if (field === null) {
    return (
      <div className={PANEL_PLAIN}>
        <p className="font-plex-mono text-[11px] text-fl-ink-3">—</p>
      </div>
    );
  }

  const selected = field.override === null ? FALL_THROUGH : String(field.override);
  return (
    <div className={`${PANEL_PLAIN} space-y-4`}>
      <p className="text-[13px] text-fl-ink-3">
        A pass the account&apos;s quota refuses is paused, not failed, and
        resumes by itself once the window resets — continuing the same
        conversation on the same branch. This is how many times one attempt may
        do that before the ticket is handed to a human. A pause spends no
        attempt and no money, so the bound is on how long a ticket may sit
        crossing windows, not on what it costs.
      </p>

      <fieldset className="space-y-1.5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1.5">
          <legend className="contents">
            <span className="text-sm text-fl-ink">{field.label}</span>
          </legend>
          <div className="flex flex-wrap items-center gap-1.5">
            {[...field.options, FALL_THROUGH].map((option) => (
              <ChipRadio
                key={option}
                name={field.key}
                value={option}
                selected={selected === option}
                disabled={disabled}
                onSelect={() => onChoose(option)}
              />
            ))}
            {busy && (
              <span className="font-plex-mono text-[11px] text-fl-ink-3">…</span>
            )}
          </div>
        </div>

        <p className="text-[13px] text-fl-ink-3">{field.help}</p>

        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-plex-mono text-[11px] text-fl-ink-3">
          <Chip tone={field.source === "override" ? "cool" : "quiet"}>
            {field.source === "override" ? "ui override" : "environment"}
          </Chip>
          <span>{effective(field)}</span>
          <span aria-hidden>·</span>
          <span>
            {fallbackNote({
              envVar: field.envVar,
              envValue: field.envValue,
              overridden: field.source === "override",
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

/** What the fleet actually does — including the case the provenance line alone
 * would leave unexplained: with the variable unset, the number in force comes
 * from the built-in default, not from nowhere. */
function effective(field: SettingCountView): string {
  const plural = field.value === 1 ? "resume" : "resumes";
  const origin =
    field.source === "environment" && field.envValue === null
      ? " (built-in default)"
      : "";
  if (field.value === 0) {
    return `no resumes — a quota pause goes straight to a human${origin}`;
  }
  return `${field.value} ${plural} per attempt${origin}`;
}
