"use client";

import { useState } from "react";
import { useLoad } from "@/lib/use-load";
import type { SettingFieldView } from "@/lib/settings-resolver";

/**
 * The plumbing every UI-editable settings panel shares (issues #166, #171):
 * one GET of the resolved state, one PATCH per press, and the chip radio the
 * control room speaks in.
 *
 * Extracted when the second panel arrived rather than copied, because the two
 * halves that must not drift are exactly the two a copy would fork: a
 * rejection has to be shown *as the server worded it* (the point of refusing
 * instead of clamping is that the operator learns what the fleet will do), and
 * the response body — the whole resolved state — has to replace local state, so
 * a panel shows what the fleet would run rather than what was asked for.
 */

export interface OverridesState {
  fields: SettingFieldView[];
  /** ISO-8601; null = no setting has ever been written on this install. */
  updatedAt: string | null;
}

/** The option that means "no override" — the fall-through every field starts
 * in, offered beside the real values so clearing is one press. */
export const FALL_THROUGH = "environment";

export function useSettingsOverrides() {
  const { data: state, error: loadError, reload, setData } =
    useLoad<OverridesState>("/api/settings/overrides");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function choose(key: string, choice: string) {
    setBusyKey(key);
    setSaveError(null);
    try {
      const res = await fetch("/api/settings/overrides", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: choice === FALL_THROUGH ? null : choice }),
      });
      const body = await res.json();
      if (!res.ok) {
        // The route answers a rejection with the reason it refused — show that
        // rather than a status code, since the reason is the whole point of
        // rejecting instead of quietly clamping.
        throw new Error(
          typeof body?.error === "string"
            ? body.error
            : `the server answered ${res.status}`
        );
      }
      // The endpoint answers with the whole resolved state, so the panel shows
      // what the fleet would actually run, not what was asked for.
      setData(body as OverridesState);
    } catch (err) {
      setSaveError(
        `That didn't stick — ${err instanceof Error ? err.message : "the request failed"}`
      );
    }
    setBusyKey(null);
  }

  return { state, loadError, reload, busyKey, saveError, choose };
}

/** One choice, in the chip voice the rest of the control room speaks. The radio
 * itself is the control — screen-reader-visible and keyboard-operable — with
 * the chip as its skin. */
export function OptionChip({
  name,
  option,
  label,
  selected,
  disabled,
  onSelect,
}: {
  name: string;
  /** The stored value this chip selects — also what the radio carries, so the
   * control is inspectable in the value the fleet would actually keep. */
  option: string;
  /** What the chip reads as, when that differs from the value (a percentage
   * wants its sign). Defaults to the value itself. */
  label?: string;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <label
      className={`cursor-pointer rounded-[4px] border px-1.5 py-px font-plex-mono text-[11px] lowercase transition-colors focus-within:border-fl-cool ${
        selected
          ? "border-fl-cool/45 bg-fl-cool/13 text-fl-cool"
          : "border-fl-line text-fl-ink-2 hover:border-fl-line-strong hover:text-fl-ink"
      } ${disabled ? "opacity-40" : ""}`}
    >
      <input
        type="radio"
        name={name}
        value={option}
        className="sr-only"
        checked={selected}
        disabled={disabled}
        onChange={onSelect}
      />
      {label ?? option}
    </label>
  );
}

/** Where a row would land if its override were cleared — named variable and
 * all, because "environment default" without the name is not something an
 * operator can go and check. */
export function fallbackLine(field: SettingFieldView): string {
  const value = field.envValue === null ? "unset" : `= ${field.envValue}`;
  return field.source === "override"
    ? `${field.envVar} ${value}, unused`
    : `from ${field.envVar} ${value}`;
}
