"use client";

import {
  Chip,
  LoadFailure,
  PANEL_PLAIN,
  formatChanged,
} from "@/components/fleet/fleet-bits";
import {
  FALL_THROUGH,
  OptionChip,
  fallbackLine,
  useSettingsOverrides,
} from "@/components/settings-overrides";
import type { SettingDetail, SettingFieldView } from "@/lib/settings-resolver";

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
 * A change lands on the settings row and is read fresh when the next pass
 * starts, so it takes effect at the next sweep with no restart. Runs already
 * in flight keep the tier they recorded.
 *
 * The endpoint answers with *every* settable field, so the panel selects its
 * own by what the value means rather than by naming keys: a field whose detail
 * is a model tier belongs here, and one that isn't belongs to whichever panel
 * speaks its language (issue #171's quota threshold is the first).
 */

type ModelTierDetail = Extract<SettingDetail, { kind: "model-tier" }>;
type ModelTierFieldView = SettingFieldView & { detail: ModelTierDetail };

function isModelTierField(field: SettingFieldView): field is ModelTierFieldView {
  return field.detail.kind === "model-tier";
}

export function ModelTierSettings() {
  const { state, loadError, reload, busyKey, saveError, choose } =
    useSettingsOverrides();

  if (state === null) {
    return (
      <div className={PANEL_PLAIN}>
        {loadError === null ? (
          <p className="font-plex-mono text-[11px] text-fl-ink-3">checking…</p>
        ) : (
          <LoadFailure what="the model tiers" error={loadError} onRetry={reload} />
        )}
      </div>
    );
  }

  return (
    <div className={`${PANEL_PLAIN} space-y-4`}>
      <p className="text-[13px] text-fl-ink-3">
        Which tier each kind of pass runs on. A tier is the durable choice —{" "}
        <span className="font-plex-mono">heavy</span>,{" "}
        <span className="font-plex-mono">standard</span>,{" "}
        <span className="font-plex-mono">light</span> — so it survives a change
        of provider. Left on{" "}
        <span className="font-plex-mono">{FALL_THROUGH}</span>, a row follows
        the deployment&apos;s own variable. A ticket&apos;s{" "}
        <span className="font-plex-mono">model:</span> directive still outranks
        both.
      </p>

      {state.fields.filter(isModelTierField).map((field) => (
        <TierRow
          key={field.key}
          field={field}
          busy={busyKey === field.key}
          disabled={busyKey !== null}
          onChoose={(choice) => choose(field.key, choice)}
        />
      ))}

      {saveError !== null && (
        <p role="alert" className="text-[13px] text-fl-red">
          {saveError}
        </p>
      )}

      {state.updatedAt !== null && (
        <p className="font-plex-mono text-[11px] text-fl-ink-3">
          settings last changed {formatChanged(state.updatedAt)}
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
  field: ModelTierFieldView;
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
            <OptionChip
              key={option}
              name={field.key}
              option={option}
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
        <span>{fallbackLine(field)}</span>
      </p>
    </fieldset>
  );
}

/** What the pass actually runs on. Naming the model id beside the tier is the
 * bit that makes an override checkable against the harness's own logs. */
function effective(field: ModelTierFieldView): string {
  const { tier, model } = field.detail;
  if (model === null) return "no --model — the account default";
  return tier === null ? `runs ${model}` : `runs ${tier} (${model})`;
}
