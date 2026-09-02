"use client";

import { useState } from "react";
import { Eyebrow, LoadFailure, PANEL_PLAIN } from "@/components/fleet/fleet-bits";
import { ModelTierPanel } from "@/components/model-tier-settings";
import { ExecutionLanePanel } from "@/components/execution-lane-settings";
import { QuotaPanel } from "@/components/quota-settings";
import { useLoad } from "@/lib/use-load";
import type { SettingCountView, SettingFieldView } from "@/lib/settings-resolver";
import type { LaneSettingsView } from "@/lib/lanes/resolve";

/**
 * The UI-editable settings (issues #166, #172, #169): which tier each kind of
 * pass runs at, which execution lane it runs on, and how far a run may ride
 * the account's quota.
 *
 * Three panels, **one** piece of state, deliberately. The first two are not
 * independent: a tier's model identifier is whatever the primary lane says it
 * is, so changing the lane changes every row of the panel above it. Fetched
 * twice they would drift the moment a lane was picked, and the screen would
 * name models no pass would run — the exact failure the provenance work exists
 * to prevent. The quota bound needs no lane, but it is written through the
 * same endpoint and the same override row, and the endpoint answers a PATCH
 * with the whole resolved state — so one write refreshes all three.
 */

interface OverridesState {
  fields: SettingFieldView[];
  lanes: LaneSettingsView | null;
  /** Why the lane file could not be read, when it could not be. */
  laneError: string | null;
  /** The quota resume bound (issue #169) — a count, so it needs no lane. */
  resumeBound: SettingCountView;
  /** ISO-8601; null = no setting has ever been written on this install. */
  updatedAt: string | null;
}

/** The one field the lane panel owns; every other key belongs to the tiers. */
const LANE_KEY = "primaryLane";
/** The one field the quota panel owns. */
const RESUME_BOUND_KEY = "maxResumesPerAttempt";

/** The save error, shown only by the panel that owns the field it failed on. */
export function errorFor(
  error: { key: string; message: string } | null,
  panel: "lane" | "tiers" | "quota"
): string | null {
  if (error === null) return null;
  const owner =
    error.key === LANE_KEY
      ? "lane"
      : error.key === RESUME_BOUND_KEY
        ? "quota"
        : "tiers";
  return owner === panel ? error.message : null;
}

/** The option that means "no override" — the fall-through every field starts
 * in, offered beside the real choices so clearing is one press. */
export const FALL_THROUGH = "environment";

export function SettingsOverrides() {
  const {
    data: state,
    error: loadError,
    reload,
    setData,
  } = useLoad<OverridesState>("/api/settings/overrides");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  // The failed field, not just the message: a rejected lane save must not put
  // a red alert under Models, where nothing went wrong.
  const [saveError, setSaveError] = useState<{ key: string; message: string } | null>(
    null
  );

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
      // The endpoint answers with the whole resolved state, so the panels show
      // what the fleet would actually run, not what was asked for.
      setData(body as OverridesState);
    } catch (err) {
      setSaveError({
        key,
        message: `That didn't stick — ${err instanceof Error ? err.message : "the request failed"}`,
      });
    }
    setBusyKey(null);
  }

  if (state === null) {
    return (
      <Sections>
        <div className={PANEL_PLAIN}>
          {loadError === null ? (
            <p className="font-plex-mono text-[11px] text-fl-ink-3">checking…</p>
          ) : (
            <LoadFailure what="the settings" error={loadError} onRetry={reload} />
          )}
        </div>
        <div className={PANEL_PLAIN}>
          <p className="font-plex-mono text-[11px] text-fl-ink-3">—</p>
        </div>
        <QuotaPanel
          field={null}
          busy={false}
          disabled
          saveError={null}
          onChoose={() => {}}
        />
      </Sections>
    );
  }

  return (
    <Sections>
      <ModelTierPanel
        fields={state.fields}
        updatedAt={state.updatedAt}
        busyKey={busyKey}
        disabled={busyKey !== null}
        saveError={errorFor(saveError, "tiers")}
        onChoose={choose}
      />
      <ExecutionLanePanel
        lanes={state.lanes}
        laneError={state.laneError}
        busy={busyKey === LANE_KEY}
        disabled={busyKey !== null}
        saveError={errorFor(saveError, "lane")}
        onChoose={(choice) => choose(LANE_KEY, choice)}
      />
      <QuotaPanel
        field={state.resumeBound}
        busy={busyKey === RESUME_BOUND_KEY}
        disabled={busyKey !== null}
        saveError={errorFor(saveError, "quota")}
        onChoose={(choice) => choose(RESUME_BOUND_KEY, choice)}
      />
    </Sections>
  );
}

/** The headed sections the control room reads as. Kept here rather than on the
 * page so every panel shares one client-side state — and one PATCH, which
 * answers with the whole resolved state, refreshes all of them. */
function Sections({
  children,
}: {
  children: [React.ReactNode, React.ReactNode, React.ReactNode];
}) {
  const [models, lanes, quota] = children;
  return (
    <>
      <section aria-label="Models" className="space-y-3">
        <Eyebrow>Models</Eyebrow>
        {models}
      </section>
      <section aria-label="Execution lane" className="space-y-3">
        <Eyebrow>Execution lane</Eyebrow>
        {lanes}
      </section>
      <section aria-label="Quota" className="space-y-3">
        <Eyebrow>Quota</Eyebrow>
        {quota}
      </section>
    </>
  );
}
