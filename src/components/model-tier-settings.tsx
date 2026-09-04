"use client";

import {
  Chip,
  ChipRadio,
  PANEL_PLAIN,
  fallbackNote,
  formatChanged,
} from "@/components/fleet/fleet-bits";
import { FALL_THROUGH } from "@/components/settings-overrides";
import type { SettingFieldView } from "@/lib/settings-resolver";

/**
 * Which tier each kind of pass runs on (issue #166) — the first fields of the
 * UI-editable settings layer, in the room where the owner already decides what
 * the fleet may do.
 *
 * Three things the panel is deliberately explicit about, because the whole
 * point of moving these out of Doppler is that a surprising effective value
 * should be debuggable from the screen:
 *
 * - the **tier**, not a model id, is what you pick — the durable choice, which
 *   survives a change of provider;
 * - every row says what is actually in force *and* whether that came from this
 *   screen or from the environment, naming the variable either way;
 * - clearing an override is a first-class option (`environment`), not a
 *   hidden reset, because falling back is the state a fresh deployment is in.
 *
 * The model id a row names is the one the **primary lane** gives that tier
 * (issue #172), which is why this panel is presentational and shares its state
 * with the lane panel below — see `SettingsOverrides`.
 *
 * Two of the rows are **ceilings** rather than fixed tiers (issue #201): a
 * review pass runs one rung above the tier the run's implement pass ran at,
 * and a repair pass does too, so the Review row bounds the review and the
 * Implement row bounds the repair's step. Which rows those are is the
 * resolver's to say (`caps`), not this component's — the pass and the screen
 * read one description of the same rule.
 *
 * A change lands on the settings row and is read fresh when the next pass
 * starts, so it takes effect at the next sweep with no restart. Runs already
 * in flight keep the tier they recorded.
 */
export function ModelTierPanel({
  fields,
  updatedAt,
  busyKey,
  disabled,
  saveError,
  onChoose,
}: {
  fields: SettingFieldView[];
  /** ISO-8601; null = no setting has ever been written on this install. */
  updatedAt: string | null;
  busyKey: string | null;
  disabled: boolean;
  saveError: string | null;
  onChoose: (key: string, choice: string) => void;
}) {
  return (
    <div className={`${PANEL_PLAIN} space-y-4`}>
      <p className="text-[13px] text-fl-ink-3">
        Which tier each kind of pass runs on. A tier is the durable choice —{" "}
        <span className="font-plex-mono">heavy</span>,{" "}
        <span className="font-plex-mono">standard</span>,{" "}
        <span className="font-plex-mono">light</span> — so it survives a change
        of provider; the model it names is whatever the lane below resolves it
        to. Left on <span className="font-plex-mono">{FALL_THROUGH}</span>, a
        row follows the deployment&apos;s own variable. A ticket&apos;s{" "}
        <span className="font-plex-mono">model:</span> directive still outranks
        both for the work it declares. Review and repair are not chosen here
        but derived — one rung above the tier the implement pass ran at — so
        their rows are <em>ceilings</em>: set, a row caps the derivation there;
        left on <span className="font-plex-mono">{FALL_THROUGH}</span> with
        the variable unset, the derivation runs free.
      </p>

      {fields.map((field) => (
        <TierRow
          key={field.key}
          field={field}
          busy={busyKey === field.key}
          disabled={disabled}
          onChoose={(choice) => onChoose(field.key, choice)}
        />
      ))}

      {saveError !== null && (
        <p role="alert" className="text-[13px] text-fl-red">
          {saveError}
        </p>
      )}

      {updatedAt !== null && (
        <p className="font-plex-mono text-[11px] text-fl-ink-3">
          settings last changed {formatChanged(updatedAt)}
        </p>
      )}
    </div>
  );
}

function TierRow({
  field,
  busy,
  disabled,
  onChoose,
}: {
  field: SettingFieldView;
  busy: boolean;
  disabled: boolean;
  onChoose: (choice: string) => void;
}) {
  const selected = field.override ?? FALL_THROUGH;
  return (
    <fieldset className="space-y-1.5 border-t border-fl-line pt-3 first:border-t-0 first:pt-0">
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
  );
}

/**
 * What the row means for the passes that read it. For a field that is simply a
 * tier, what the pass runs on — naming the model id beside the tier is the bit
 * that makes an override checkable against the harness's own logs. For a field
 * that is a **ceiling** on a derived kind (issue #201), the ceiling in force
 * or its absence, and — where the field also decides an underived pass, or
 * stands in when a run has no tier to derive from — what that runs.
 */
function effective(field: SettingFieldView): string {
  if (field.caps.length === 0) return runs(field);

  const derived = field.caps.join(" and ");
  const onlyCeiling = field.kinds.every((kind) => field.caps.includes(kind));
  const ceiling =
    field.ceiling === null
      ? `no ceiling — ${derived} runs one rung above the implement pass`
      : `ceiling ${field.ceiling} on ${derived} (${field.model})`;

  // The Review row: nothing but a ceiling, and what a review runs when the
  // run has no implement tier to step from is the fall-back, not the rule.
  // Except a pinned raw model id, which names no tier to bound with and is
  // the operator's whole answer on the reviewer's own field: the review runs
  // it and derives nothing (`resolveAgentModelChoice`).
  if (onlyCeiling) {
    if (field.tier === null && field.model !== null) {
      return `pinned — ${derived} runs ${field.model} and derives nothing`;
    }
    return `${ceiling} · with no implement tier to derive from, ${runs(field)}`;
  }
  // The Implement row: the tier its own pass runs at, and the ceiling on the
  // repair's step beside it.
  return `${runs(field)} · ${ceiling}`;
}

function runs(field: SettingFieldView): string {
  if (field.model === null) return "no --model — the account default";
  return field.tier === null
    ? `runs ${field.model}`
    : `runs ${field.tier} (${field.model})`;
}
