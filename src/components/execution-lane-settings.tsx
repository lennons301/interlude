"use client";

import { useState } from "react";
import {
  Chip,
  ChipRadio,
  LoadFailure,
  PANEL_PLAIN,
} from "@/components/fleet/fleet-bits";
import { useLoad } from "@/lib/use-load";
import type { LaneSettingsView, LaneView } from "@/lib/lanes/resolve";

/**
 * Which execution lane the fleet runs on (issue #172) — the substrate under
 * the tiers the panel above chooses.
 *
 * The lanes themselves are a checked-in file, deliberately: which lanes exist,
 * what they authenticate with and what each tier means on them is a reviewable
 * architectural fact. What belongs to the operator is *which one is primary*,
 * and that is this panel's single control.
 *
 * Everything else here is reporting, and the reporting is the point:
 *
 * - a lane says whether it can run at all, and names the variables it is
 *   missing when it cannot — the failure this replaces was a live agent dying
 *   inside the harness with "Not logged in";
 * - a lane says who pays. `metered` is real money, so it reads in the same
 *   amber the rest of the control room uses for a deliberate hold;
 * - variable **names** only ever cross the wire. No lane secret is stored in
 *   the database or served by the API, and this panel could not show one if it
 *   wanted to.
 */

interface LaneState {
  lanes: LaneSettingsView | null;
  /** Why the lane file could not be read, when it could not be. */
  laneError: string | null;
}

/** The option that means "no override" — fall through to the deployment's own
 * variable and then to the file's preference order. */
const FALL_THROUGH = "environment";

export function ExecutionLaneSettings() {
  const {
    data: state,
    error: loadError,
    reload,
    setData,
  } = useLoad<LaneState>("/api/settings/overrides");
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function choose(choice: string) {
    setBusy(true);
    setSaveError(null);
    try {
      const res = await fetch("/api/settings/overrides", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          primaryLane: choice === FALL_THROUGH ? null : choice,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        // The route answers a rejection with the reason it refused — show that
        // rather than a status code, since the reason is the whole point of
        // rejecting instead of quietly picking some other lane.
        throw new Error(
          typeof body?.error === "string"
            ? body.error
            : `the server answered ${res.status}`
        );
      }
      setData(body as LaneState);
    } catch (err) {
      setSaveError(
        `That didn't stick — ${err instanceof Error ? err.message : "the request failed"}`
      );
    }
    setBusy(false);
  }

  if (state === null) {
    return (
      <div className={PANEL_PLAIN}>
        {loadError === null ? (
          <p className="font-plex-mono text-[11px] text-fl-ink-3">checking…</p>
        ) : (
          <LoadFailure what="the execution lanes" error={loadError} onRetry={reload} />
        )}
      </div>
    );
  }

  if (state.lanes === null) {
    return (
      <div className={PANEL_PLAIN}>
        <p role="alert" className="text-[13px] text-fl-red">
          No usable execution lanes — {state.laneError ?? "lanes.yaml could not be read"}.
          No pass can start until this is fixed.
        </p>
      </div>
    );
  }

  const lanes = state.lanes;
  const selected = lanes.override ?? FALL_THROUGH;

  return (
    <div className={`${PANEL_PLAIN} space-y-4`}>
      <p className="text-[13px] text-fl-ink-3">
        Which lane every pass runs on — the harness, the endpoint and the
        credentials behind each tier. The lanes themselves live in{" "}
        <span className="font-plex-mono">lanes.yaml</span>, where they can be
        reviewed; only the choice of primary is yours. Left on{" "}
        <span className="font-plex-mono">{FALL_THROUGH}</span>, the fleet
        follows <span className="font-plex-mono">{lanes.envVar}</span> and then
        the file&apos;s own preference order.
      </p>

      <fieldset className="space-y-1.5">
        <legend className="sr-only">Primary execution lane</legend>
        <div className="flex flex-wrap items-center gap-1.5">
          {lanes.lanes.map((lane) => (
            <ChipRadio
              key={lane.id}
              name="primaryLane"
              value={lane.id}
              selected={selected === lane.id}
              disabled={busy}
              onSelect={() => choose(lane.id)}
            />
          ))}
          <ChipRadio
            name="primaryLane"
            value={FALL_THROUGH}
            selected={selected === FALL_THROUGH}
            disabled={busy}
            onSelect={() => choose(FALL_THROUGH)}
          />
          {busy && (
            <span className="font-plex-mono text-[11px] text-fl-ink-3">…</span>
          )}
        </div>

        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-plex-mono text-[11px] text-fl-ink-3">
          <Chip tone={lanes.source === "override" ? "cool" : "quiet"}>
            {SOURCE_LABEL[lanes.source]}
          </Chip>
          <span>
            {lanes.primaryLaneId === null
              ? "no lane in force"
              : `runs on ${lanes.primaryLaneId}`}
          </span>
          <span aria-hidden>·</span>
          <span>
            {lanes.source === "override"
              ? `${lanes.envVar} ${envValue(lanes)}, unused`
              : `from ${lanes.envVar} ${envValue(lanes)}`}
          </span>
        </p>
      </fieldset>

      {lanes.unknownChoice !== null && (
        <p role="alert" className="text-[13px] text-fl-amber">
          &quot;{lanes.unknownChoice}&quot; names no declared lane — it was
          probably renamed or removed from{" "}
          <span className="font-plex-mono">lanes.yaml</span>. The fleet is
          running on{" "}
          <span className="font-plex-mono">{lanes.primaryLaneId ?? "nothing"}</span>{" "}
          instead.
        </p>
      )}

      <div className="space-y-3">
        {lanes.lanes.map((lane) => (
          <LaneRow key={lane.id} lane={lane} />
        ))}
      </div>

      {saveError !== null && (
        <p role="alert" className="text-[13px] text-fl-red">
          {saveError}
        </p>
      )}
    </div>
  );
}

const SOURCE_LABEL: Record<LaneSettingsView["source"], string> = {
  override: "ui override",
  environment: "environment",
  preference: "default order",
};

function envValue(lanes: LaneSettingsView): string {
  return lanes.envValue === null ? "unset" : `= ${lanes.envValue}`;
}

/** One lane, as a fact sheet: whether it can run, who pays, where it points,
 * and what each tier means on it. */
function LaneRow({ lane }: { lane: LaneView }) {
  return (
    <div className="space-y-1 border-t border-fl-line pt-3 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-sm text-fl-ink">{lane.label}</span>
        <span className="font-plex-mono text-[11px] text-fl-ink-3">{lane.id}</span>
        {lane.primary && <Chip tone="cool">primary</Chip>}
        <Chip tone={lane.billing === "metered" ? "amber" : "quiet"}>
          {lane.billing}
        </Chip>
        {lane.available ? (
          <Chip tone="quiet">available</Chip>
        ) : (
          <Chip tone="red">unavailable</Chip>
        )}
      </div>

      <p className="font-plex-mono text-[11px] text-fl-ink-3">
        {lane.adapter} · {lane.baseUrl ?? "default endpoint"} ·{" "}
        {(["heavy", "standard", "light"] as const)
          .map((tier) => `${tier}=${lane.models[tier]}`)
          .join(" ")}
        {lane.caps.dailyBudgetUsd !== null &&
          ` · cap $${lane.caps.dailyBudgetUsd}/day`}
      </p>

      <p className="font-plex-mono text-[11px] text-fl-ink-3">
        {lane.available
          ? `reads ${lane.authEnvVars.join(", ")}`
          : `needs ${lane.missingEnvVars.join(", ")} — not set in this deployment`}
      </p>
    </div>
  );
}
