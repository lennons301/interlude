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
 * One row is a **ceiling** rather than a fixed tier (issue #201): a review
 * pass runs one rung above the tier the run's implement pass ran at, so the
 * Review row bounds the review. Repair is deliberately not derived (issue
 * #211) — it runs at the run's own tier, so the Implement row is a chosen tier
 * for both the implement pass and its repair. Which row is the ceiling, and
 * whether it caps, frees or pins its derived pass, is the resolver's to say
 * (`derived`), not this component's — the pass and the screen read one
 * description of the same rule, and this only puts it into words.
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
        both for the work it declares — its implement pass, and the repair
        that continues it at the same tier. Review alone is not chosen here
        but derived — one rung above the tier the implement pass ran at — so
        its row is a <em>ceiling</em>: set, it caps the derivation there; left
        on <span className="font-plex-mono">{FALL_THROUGH}</span> with the
        variable unset, the derivation runs free.
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
 * or its absence, and — since the field also stands in when a run has no tier
 * to derive from — what that runs.
 */
function effective(field: SettingFieldView): string {
  if (field.derived.length === 0) return runsLine(field);

  const clauses = field.derived.map((entry) => {
    switch (entry.rule) {
      case "capped":
        return `ceiling ${entry.ceiling} on ${entry.kind} (${field.model})`;
      case "pinned":
        return `pinned — ${entry.kind} runs ${field.model} and derives nothing`;
      case "free":
        return `no ceiling — ${entry.kind} runs one rung above the implement pass`;
    }
  });

  // A row that is a ceiling (Review, the only derived kind — issue #211)
  // chooses no tier of its own and leads with the rule; what a review runs
  // when the run has no implement tier to step from is the fall-back, and a
  // pinned row has already said what it runs. The type still permits a row
  // that both chooses and derives; none exists, so `chooses` is deliberately
  // not read here — a kind added to both lists would need its own line.
  const pinned = field.derived.every((entry) => entry.rule === "pinned");
  return pinned
    ? clauses.join(" · ")
    : `${clauses.join(" · ")} · with no implement tier to derive from, ${runsLine(field)}`;
}

/** What a pass resolving through the row alone runs. Naming the model id
 * beside the tier is the bit that makes an override checkable against the
 * harness's own logs. A tier with no model beside it means the lane file is
 * unusable (issue #226) — there is no primary lane to say what the tier means
 * — and the row says the tier rather than a model off some other map. */
function runsLine(field: SettingFieldView): string {
  if (field.tier === null && field.model === null) {
    return "no model named — the harness picks its own default";
  }
  if (field.tier === null) return `runs ${field.model}`;
  if (field.model === null) return `runs ${field.tier}`;
  return `runs ${field.tier} (${field.model})`;
}
