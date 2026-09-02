"use client";

import { useState } from "react";
import {
  Chip,
  ControlButton,
  FIELD,
  Gauge,
  LoadFailure,
  Money,
  PANEL,
  PANEL_PLAIN,
  TONES,
  fallbackNote,
  formatChanged,
} from "@/components/fleet/fleet-bits";
import { ConfirmStrip } from "@/components/confirm-strip";
import { useLoad } from "@/lib/use-load";
import { useReturnFocus } from "@/lib/use-return-focus";
import type { MeteredCap, MeteredHold } from "@/lib/lanes/money";

/**
 * Real money (issue #174) — the panel for the guards that apply when the lane
 * in force bills per token, wherever that lane came from.
 *
 * It shows the same state the reducer decides on, computed by the same pure
 * function, so the screen cannot say the fleet is running while the sweep
 * refuses to claim. Two controls, and they are asymmetric on purpose:
 *
 * - **Confirming** the day's spend authorises unattended cash, so it takes the
 *   same deliberate strip that arming a project and lifting the kill switch do.
 *   Withdrawing it is one press — stopping is always safe.
 * - **The cap** is an ordinary setting: typed, submitted, refused with a reason
 *   if it is out of range rather than quietly clamped, and cleared back to the
 *   deployment's own default in one press.
 *
 * On a subscription lane the panel stays, saying so. That is the point of a
 * guard keyed to billing kind: the fleet's cost posture is visible before
 * someone switches lanes, not only after.
 */

interface MeteredState {
  lane: { id: string; label: string; billing: "subscription" | "metered" } | null;
  laneError: string | null;
  cap: MeteredCap;
  spentTodayUsd: number;
  confirmedAt: string | null;
  confirmedToday: boolean;
  metered: boolean;
  hold: MeteredHold | null;
  remainingUsd: number;
  updatedAt: string | null;
}

export function MeteredSpendPanel() {
  const {
    data: state,
    error: loadError,
    reload,
    setData,
  } = useLoad<MeteredState>("/api/settings/metered-spend");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [draftCap, setDraftCap] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const triggerRef = useReturnFocus<HTMLButtonElement>(confirming);

  async function patch(body: { confirmed?: boolean; capUsd?: string | null }) {
    setBusy(true);
    setMoveError(null);
    try {
      const res = await fetch("/api/settings/metered-spend", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const answer = await res.json();
      if (!res.ok) {
        // The route answers a rejection with the reason it refused — showing
        // that is the whole point of refusing rather than clamping.
        throw new Error(
          typeof answer?.error === "string"
            ? answer.error
            : `the server answered ${res.status}`
        );
      }
      setData(answer as MeteredState);
      setConfirming(false);
      setDraftCap(null);
    } catch (err) {
      setMoveError(
        `That didn't stick — ${err instanceof Error ? err.message : "the request failed"}.`
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
          <LoadFailure what="the real-money guards" error={loadError} onRetry={reload} />
        )}
      </div>
    );
  }

  const { cap, lane, hold } = state;
  const tone = hold !== null ? TONES.amber : null;

  return (
    <div className={tone ? `${PANEL} ${tone}` : PANEL_PLAIN}>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 space-y-1">
          <p className={`text-sm ${hold === null ? "text-fl-ink" : ""}`}>
            {!state.metered
              ? "Nothing is costing cash."
              : hold === "cap-reached"
                ? "The real-money cap is spent."
                : hold === "unconfirmed"
                  ? "Real-money spend needs confirming."
                  : "Real money is authorised for today."}
          </p>
          <p className="text-[13px] text-fl-ink-3">{summary(state)}</p>
          {state.confirmedAt !== null && state.confirmedToday && (
            <p className="font-plex-mono text-[11px] text-fl-ink-3">
              confirmed {formatChanged(state.confirmedAt)}
            </p>
          )}
        </div>

        {state.metered && !confirming && (
          <ControlButton
            ref={triggerRef}
            tone={state.confirmedToday ? "amber" : "cool"}
            disabled={busy}
            onClick={() =>
              state.confirmedToday
                ? patch({ confirmed: false })
                : setConfirming(true)
            }
          >
            {busy ? "…" : state.confirmedToday ? "withdraw" : "confirm today…"}
          </ControlButton>
        )}
      </div>

      {state.metered && (
        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between font-plex-mono text-[11px] tabular-nums text-fl-ink-2">
            <span>
              today <Money usd={state.spentTodayUsd} />
            </span>
            <span className="text-fl-ink-3">
              cap <Money usd={cap.capUsd} />
            </span>
          </div>
          <Gauge
            value={state.spentTodayUsd}
            max={cap.capUsd}
            tone={hold === "cap-reached" ? "red" : "green"}
          />
        </div>
      )}

      <div className="space-y-1.5">
        <label
          htmlFor="metered-cap"
          className="block font-plex-mono text-[11px] text-fl-ink-3"
        >
          real-money daily cap (USD)
        </label>
        <div className="flex flex-wrap items-center gap-1.5">
          <input
            id="metered-cap"
            type="number"
            min="0"
            step="0.01"
            inputMode="decimal"
            className={`${FIELD} max-w-[9rem]`}
            disabled={busy}
            value={draftCap ?? cap.override ?? String(cap.envUsd)}
            onChange={(e) => setDraftCap(e.target.value)}
          />
          <ControlButton
            tone="cool"
            disabled={busy || draftCap === null}
            onClick={() => patch({ capUsd: draftCap })}
          >
            save
          </ControlButton>
          {cap.override !== null && (
            <ControlButton
              tone="quiet"
              disabled={busy}
              onClick={() => patch({ capUsd: null })}
            >
              clear
            </ControlButton>
          )}
        </div>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-plex-mono text-[11px] text-fl-ink-3">
          <Chip tone={cap.source === "override" ? "cool" : "quiet"}>
            {cap.source === "override" ? "ui override" : "environment"}
          </Chip>
          <span>
            {fallbackNote({
              envVar: cap.envVar,
              envValue: String(cap.envUsd),
              overridden: cap.source === "override",
            })}
          </span>
          {cap.boundBy === "lane" && (
            <>
              <span aria-hidden>·</span>
              <span>
                held to ${cap.laneUsd} by {lane?.id ?? "the lane"}&apos;s own
                declared cap
              </span>
            </>
          )}
        </p>
      </div>

      {confirming && (
        <ConfirmStrip
          label="Confirm today's real-money spend"
          tone="amber"
          confirm="confirm spend"
          busyLabel="confirming…"
          busy={busy}
          error={moveError}
          onConfirm={() => patch({ confirmed: true })}
          onCancel={() => setConfirming(false)}
        >
          <p className="text-[13px]">
            Let the fleet spend real money on{" "}
            <span className="font-plex-mono">{lane?.id}</span> today? Autonomous
            passes run unattended up to <Money usd={cap.capUsd} />, after which
            pickup pauses until midnight. The confirmation lapses on its own at
            local midnight.
          </p>
        </ConfirmStrip>
      )}

      {!confirming && moveError !== null && (
        <p role="alert" className="text-[13px] text-fl-red">
          {moveError}
        </p>
      )}

      {state.laneError !== null && (
        <p role="alert" className="text-[13px] text-fl-red">
          No lane resolves — {state.laneError}. Nothing can spend anything until
          that is fixed.
        </p>
      )}
    </div>
  );
}

/** The one-line explanation under the headline, in the owner's terms. */
function summary(state: MeteredState): string {
  if (state.lane === null) {
    return "No execution lane is in force, so nothing about who pays can be said.";
  }
  if (!state.metered) {
    return `${state.lane.label} draws on a subscription, so its work costs quota rather than cash — the cap below applies only once a metered lane is in force.`;
  }
  if (state.hold === "cap-reached") {
    return `${state.lane.label} bills per token and today's cap is spent — autonomous pickup is paused until local midnight. Raise the cap to carry on today. In-flight runs and interactive work are unaffected.`;
  }
  if (state.hold === "unconfirmed") {
    return `${state.lane.label} bills per token. Autonomous pickup is held until you confirm once for today; after that it runs unattended up to the cap.`;
  }
  return `${state.lane.label} bills per token, and today is confirmed — the fleet spends up to the cap without asking again. The confirmation lapses at local midnight.`;
}
