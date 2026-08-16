"use client";

import { useCallback, useEffect, useState } from "react";
import { ControlButton, TONES } from "@/components/fleet/fleet-bits";

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
  const [state, setState] = useState<AutonomySettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingLift, setConfirmingLift] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;

    (async () => {
      try {
        const res = await fetch("/api/settings/autonomy", {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`the server answered ${res.status}`);
        const data: AutonomySettings = await res.json();
        if (stopped) return;
        setState(data);
        setError(null);
      } catch (err) {
        if (stopped || controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "the request failed");
      }
    })();

    return () => {
      stopped = true;
      controller.abort();
    };
  }, [reloadKey]);

  const set = useCallback(async (paused: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/autonomy", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paused }),
      });
      if (!res.ok) throw new Error(`the server answered ${res.status}`);
      // The endpoint answers with the whole state, so the panel shows what was
      // actually stored rather than what was asked for.
      setState(await res.json());
      setConfirmingLift(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "the request failed");
    }
    setBusy(false);
  }, []);

  if (state === null) {
    return (
      <Panel tone="quiet">
        {error === null ? (
          <p className="font-plex-mono text-[11px] text-fl-ink-3">checking…</p>
        ) : (
          <>
            <p role="alert" className="text-[13px] text-fl-red">
              Couldn&apos;t read the kill switch — {error}.
            </p>
            <ControlButton
              onClick={() => {
                setError(null);
                setReloadKey((key) => key + 1);
              }}
            >
              retry
            </ControlButton>
          </>
        )}
      </Panel>
    );
  }

  const held = state.globalAutonomyPaused;

  return (
    <Panel tone={held ? "amber" : "quiet"}>
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
            tone={held ? "cool" : "amber"}
            disabled={busy}
            onClick={() => (held ? setConfirmingLift(true) : set(true))}
          >
            {busy ? "…" : held ? "lift…" : "stop the fleet"}
          </ControlButton>
        )}
      </div>

      {confirmingLift && (
        <div
          role="group"
          aria-label="Confirm lifting the kill switch"
          className={`space-y-2 rounded-[4px] border px-3 py-2.5 ${TONES.cool}`}
        >
          <p className="text-[13px]">
            Lift the kill switch? Every armed project resumes claiming tickets
            unattended from the next sweep tick.
          </p>
          <div className="flex flex-wrap gap-2">
            <ControlButton tone="cool" disabled={busy} onClick={() => set(false)}>
              {busy ? "lifting…" : "confirm lift"}
            </ControlButton>
            <ControlButton disabled={busy} onClick={() => setConfirmingLift(false)}>
              cancel
            </ControlButton>
          </div>
        </div>
      )}

      {error !== null && (
        <p role="alert" className="text-[13px] text-fl-red">
          The switch didn&apos;t move — {error}.
        </p>
      )}
    </Panel>
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

function Panel({
  tone,
  children,
}: {
  tone: keyof typeof TONES;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`space-y-2.5 rounded-[4px] border px-3 py-2.5 ${
        tone === "quiet" ? "border-fl-line bg-fl-card" : TONES[tone]
      }`}
    >
      {children}
    </div>
  );
}
