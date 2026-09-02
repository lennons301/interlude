"use client";

import {
  Chip,
  ChipRadio,
  PANEL_PLAIN,
  fallbackNote,
} from "@/components/fleet/fleet-bits";
import { FALL_THROUGH } from "@/components/settings-overrides";
import type { LaneBilling } from "@/lib/lanes/lane-config";
import type { LaneSettingsView } from "@/lib/lanes/resolve";
import type { MinLaneFieldView } from "@/lib/settings-resolver";

/**
 * Cost routing, and the one control over it (issue #176).
 *
 * The lane panel above chooses whether the fleet is *pinned*. Left unpinned,
 * every pass is routed onto the cheapest lane that can serve it — and this is
 * where "can serve it" is bounded per pass kind: a **minimum lane** is a
 * capability floor, so naming a paid lane for implement work still allows the
 * (free, first-party) subscription above it, while triage and review are left
 * free to run on the cheapest thing declared.
 *
 * The rows are half control and half report, and the report is what makes the
 * control usable: each pass kind says which lane it would be routed onto right
 * now and what that lane charges per million tokens, read through the same
 * ranking a pass is routed by — so the row cannot claim a lane the pass would
 * not run on.
 *
 * Presentational, sharing the other panels' single state for the reason they
 * share it with each other: one PATCH returns the whole resolved settings
 * state, and a separately-fetched panel would show a row that is no longer the
 * row.
 */

/** What cost routing would pick for one pass kind right now, as the route
 * reports it. Mirrors `routingState` in the overrides endpoint. */
export interface LaneRoutingRow {
  kind: string;
  laneId: string | null;
  label: string | null;
  billing: LaneBilling | null;
  /** USD per Mtok of a representative pass, or null on a lane that declares
   * no prices (where the harness's own figure stands). */
  rateUsdPerMTok: number | null;
  /** Whether the ranking chose this lane, or it is the fall-back — where the
   * pass runs, but only because nothing qualified. */
  chosen: boolean;
}

/** Which routing row belongs beside which floor. Keyed by the field rather
 * than by the kind so the mapping lives beside the rows it orders. */
const KIND_BY_FIELD: Readonly<Record<string, string>> = {
  minLaneImplement: "implement",
  minLaneReview: "review",
  minLaneTriage: "triage",
  minLaneInteractive: "interactive",
};

export function LaneRoutingPanel({
  fields,
  routing,
  lanes,
  busyKey,
  disabled,
  saveError,
  onChoose,
}: {
  fields: MinLaneFieldView[] | null;
  routing: LaneRoutingRow[] | null;
  lanes: LaneSettingsView | null;
  busyKey: string | null;
  disabled: boolean;
  saveError: string | null;
  onChoose: (key: string, choice: string) => void;
}) {
  if (fields === null || lanes === null) {
    return (
      <div className={PANEL_PLAIN}>
        <p className="font-plex-mono text-[11px] text-fl-ink-3">—</p>
      </div>
    );
  }

  const pinned = lanes.source !== "preference";
  const options = lanes.lanes.map((lane) => lane.id);

  return (
    <div className={`${PANEL_PLAIN} space-y-4`}>
      <p className="text-[13px] text-fl-ink-3">
        Left unpinned, every pass runs on the cheapest lane that can serve it —
        which, while the subscription window is open, is the subscription:
        nothing is cheaper than work already paid for. A{" "}
        <em>minimum lane</em> is a floor on that choice, not a choice of lane:
        routing may pick anything at or above the lane you name, so naming a
        paid lane for implement work still leaves the subscription available
        above it. It bounds where routing may <em>send</em> a pass and never
        excludes the lane the fleet is already on.
      </p>

      {pinned && (
        <p className="text-[13px] text-fl-ink-3">
          Cost routing is off: the fleet is pinned to{" "}
          <span className="font-plex-mono">{lanes.primaryLaneId}</span> by the
          lane choice above, so no pass is moved for cheapness. A{" "}
          <em>walled</em> pinned lane still fails over rather than waiting the
          window out — the pin is honoured right up to the point where the lane
          cannot serve the request at all.
        </p>
      )}

      {fields.map((field) => {
        const selected = field.override ?? FALL_THROUGH;
        const routed =
          routing?.find((row) => row.kind === KIND_BY_FIELD[field.key]) ?? null;
        return (
          <fieldset key={field.key} className="space-y-1.5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1.5">
              <legend className="contents">
                <span className="text-sm text-fl-ink">{field.label}</span>
              </legend>
              <div className="flex flex-wrap items-center gap-1.5">
                {[...options, FALL_THROUGH].map((option) => (
                  <ChipRadio
                    key={option}
                    name={field.key}
                    value={option}
                    selected={selected === option}
                    disabled={disabled}
                    onSelect={() => onChoose(field.key, option)}
                  />
                ))}
                {busyKey === field.key && (
                  <span className="font-plex-mono text-[11px] text-fl-ink-3">
                    …
                  </span>
                )}
              </div>
            </div>

            <p className="text-[13px] text-fl-ink-3">{field.help}</p>

            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-plex-mono text-[11px] text-fl-ink-3">
              <Chip tone={field.source === "override" ? "cool" : "quiet"}>
                {field.source === "override" ? "ui override" : "environment"}
              </Chip>
              <span>
                {field.laneId === null
                  ? "no floor — any declared lane"
                  : `at or above ${field.laneId}`}
              </span>
              <span aria-hidden>·</span>
              <span>{routedNote(routed)}</span>
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
      })}

      {saveError !== null && (
        <p role="alert" className="text-[13px] text-fl-red">
          {saveError}
        </p>
      )}
    </div>
  );
}

/**
 * What this kind would run on right now, and what that costs.
 *
 * Two states worth keeping apart. A lane the ranking *chose* is the cost case
 * working. A lane it fell back to is the lane in force with nothing qualifying
 * above it — the pass still runs there, and saying "no lane" would leave this
 * row claiming a refusal that is not going to happen.
 */
function routedNote(routed: LaneRoutingRow | null): string {
  if (routed === null || routed.laneId === null) return "no lane resolves";
  const rate =
    routed.rateUsdPerMTok === null
      ? routed.billing === "metered"
        ? ", priced by the harness"
        : ""
      : `, ${usdPerMTok(routed.rateUsdPerMTok)}/Mtok`;
  const lead = routed.chosen ? "routes to" : "nothing qualifies — runs on";
  return `${lead} ${routed.laneId}${rate}`;
}

/** Two significant figures, because these span three orders of magnitude and
 * "$0.04" beside "$1.65" is the whole comparison. */
function usdPerMTok(rate: number): string {
  if (rate === 0) return "$0";
  return `$${rate < 0.1 ? rate.toFixed(3) : rate.toFixed(2)}`;
}
