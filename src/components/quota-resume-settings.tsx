"use client";

import {
  Chip,
  ChipRadio,
  PANEL_PLAIN,
  fallbackNote,
} from "@/components/fleet/fleet-bits";
import { FALL_THROUGH } from "@/components/settings-overrides";
import type { ResumeBoundView } from "@/lib/settings-resolver";

/**
 * How far a run may ride the account's quota (issue #169): how many times one
 * attempt may pause on a rate limit and be resumed before its ticket goes to a
 * human.
 *
 * Under **Quota**, beneath the admission gate (issue #171), because the two are
 * the same subject read in order: the gate is when the fleet stops *starting*
 * work on a spent window, this is how long work it already started may keep
 * riding one. Its own panel rather than a row in that one, because they are
 * separate decisions with separate consequences — the gate delays a claim, this
 * one eventually hands a ticket to a human.
 *
 * Presentational and sharing the other panels' state, for the reason they share
 * it with each other: one PATCH returns the whole resolved settings state.
 */
export function QuotaResumePanel({
  bound: field,
  busy,
  disabled,
  saveError,
  onChoose,
}: {
  bound: ResumeBoundView | null;
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

  const selected = field.override ?? FALL_THROUGH;
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
                name="maxResumesPerAttempt"
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
function effective(field: ResumeBoundView): string {
  const plural = field.resumes === 1 ? "resume" : "resumes";
  const origin =
    field.source === "environment" && field.envValue === null
      ? " (built-in default)"
      : "";
  if (field.resumes === 0) {
    return `no resumes — a quota pause goes straight to a human${origin}`;
  }
  return `${field.resumes} ${plural} per attempt${origin}`;
}
