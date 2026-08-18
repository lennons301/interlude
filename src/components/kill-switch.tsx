"use client";

import { useState } from "react";
import {
  ControlButton,
  LoadFailure,
  PANEL,
  PANEL_PLAIN,
  TONES,
} from "@/components/fleet/fleet-bits";
import { ConfirmStrip } from "@/components/confirm-strip";
import { useLoad } from "@/lib/use-load";
import { useReturnFocus } from "@/lib/use-return-focus";

/**
 * The global autonomy kill switch, in the room where the owner arms things
 * (issues #118, #119). It drives the existing `PATCH /api/settings/autonomy`;
 * the flag is durable and the sweep reads it fresh every tick, so engaging it
 * stops all new pickup at the next tick with no restart, and survives one.
 *
 * The two directions are deliberately asymmetric. Engaging is one press:
 * stopping the fleet is always safe, and a control room where "stop" asks you
 * to confirm is a control room you hesitate in. Lifting re-arms every armed
 * project at once, so it takes the same deliberate confirmation as arming a
 * single one.
 *
 * `envMaster` is reported beside the flag because they are different controls:
 * with `AUTONOMY_ENABLED` unset no sweep runs at all, and lifting the switch
 * cannot arm a fleet the boot master has disarmed. Saying so here is what stops
 * "I lifted it and nothing happened".
 */

interface AutonomySettings {
  globalAutonomyPaused: boolean;
  /** ISO-8601; null = the switch has never been touched on this install. */
  updatedAt: string | null;
  envMaster: boolean;
}

export function KillSwitch() {
  const {
    data: state,
    error: loadError,
    reload,
    setData,
  } = useLoad<AutonomySettings>("/api/settings/autonomy");
  const [busy, setBusy] = useState(false);
  const [confirmingLift, setConfirmingLift] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  // The button is replaced by the strip and then by its opposite, so focus is
  // handed to whichever control mounts in its place (issue #142).
  const triggerRef = useReturnFocus<HTMLButtonElement>(confirmingLift);

  async function setPaused(paused: boolean) {
    setBusy(true);
    setMoveError(null);
    try {
      const res = await fetch("/api/settings/autonomy", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paused }),
      });
      if (!res.ok) throw new Error(`the server answered ${res.status}`);
      // The endpoint answers with the whole state, so the panel shows what was
      // actually stored rather than what was asked for.
      setData(await res.json());
      // Closing the strip is what hands focus on, so a confirmed lift needs no
      // more than this: the control that replaces it is "stop the fleet".
      setConfirmingLift(false);
    } catch (err) {
      setMoveError(
        `The switch didn't move — ${err instanceof Error ? err.message : "the request failed"}.`
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
          <LoadFailure what="the kill switch" error={loadError} onRetry={reload} />
        )}
      </div>
    );
  }

  const held = state.globalAutonomyPaused;

  return (
    <div className={held ? `${PANEL} ${TONES.amber}` : PANEL_PLAIN}>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 space-y-1">
          <p className={`text-sm ${held ? "" : "text-fl-ink"}`}>
            {held
              ? "Autonomous pickup is held."
              : "Autonomous pickup is running."}
          </p>
          <p className="text-[13px] text-fl-ink-3">
            {held
              ? "Nothing new is claimed — no implement pickup, no triage pass. Runs already in flight carry on and can be cancelled one by one."
              : "Armed projects claim their ready-for-agent tickets unattended. Engaging the switch stops that at the next sweep tick."}
          </p>
          {!state.envMaster && (
            <p className="text-[13px] text-fl-ink-3">
              <span className="font-plex-mono">AUTONOMY_ENABLED</span> is off, so
              no sweep runs at all on this install — lifting the switch cannot
              start one.
            </p>
          )}
          {state.updatedAt !== null && (
            <p className="font-plex-mono text-[11px] text-fl-ink-3">
              last changed {formatChanged(state.updatedAt)}
            </p>
          )}
        </div>

        {!confirmingLift && (
          <ControlButton
            ref={triggerRef}
            tone={held ? "cool" : "amber"}
            disabled={busy}
            onClick={() => (held ? setConfirmingLift(true) : setPaused(true))}
          >
            {busy ? "…" : held ? "lift…" : "stop the fleet"}
          </ControlButton>
        )}
      </div>

      {confirmingLift && (
        <ConfirmStrip
          label="Confirm lifting the kill switch"
          tone="cool"
          confirm="confirm lift"
          busyLabel="lifting…"
          busy={busy}
          error={moveError}
          onConfirm={() => setPaused(false)}
          onCancel={() => setConfirmingLift(false)}
        >
          <p className="text-[13px]">
            Lift the kill switch? Every armed project resumes claiming tickets
            unattended from the next sweep tick.
          </p>
        </ConfirmStrip>
      )}

      {/* Engaging has no strip of its own to fail inside, so its failure is
          reported here. */}
      {!confirmingLift && moveError !== null && (
        <p role="alert" className="text-[13px] text-fl-red">
          {moveError}
        </p>
      )}
    </div>
  );
}

/** Rendered only after the client fetch resolves, so a locale-formatted time
 * can never disagree with the server's first paint. */
function formatChanged(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? iso
    : at.toLocaleString("en-GB", { hour12: false });
}
