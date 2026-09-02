"use client";

import { useEffect, useState } from "react";
import { ConfirmStrip } from "@/components/confirm-strip";
import {
  ActionLink,
  ControlButton,
  Money,
  PANEL,
  TONES,
} from "@/components/fleet/fleet-bits";
import { useLoad } from "@/lib/use-load";
import { useReturnFocus } from "@/lib/use-return-focus";
import type { CrossingRefusal } from "@/lib/lanes/overflow";

/**
 * The at-the-keyboard confirmation (issue #173): the money guards, surfaced in
 * the session they are about to hold.
 *
 * #174 established the confirm-once-per-local-day gate at fleet level, on the
 * settings screen, because nobody is at the keyboard when an autonomous pass
 * crosses into billing. An interactive session is the opposite case — someone
 * is sitting right here waiting for a reply — so the same gate is offered
 * *here*, with the numbers that make it decidable: which lane, what the wall
 * was, what has been spent, and what the ceiling is.
 *
 * It renders the crossing the orchestrator has already decided, never its own
 * reading of one: the sentence and the refusal both come from the same pure
 * function the turn manager routes the pass with and the queue loop declines
 * to start it with. A screen that computed its own would eventually offer a
 * confirmation for a crossing nobody was making.
 *
 * Three things it can say, and the wall's own asymmetry is why they differ:
 *
 * - **held for a confirmation** — one press and the session carries on, so the
 *   press is here. It is the *fleet's* press, though, and authorises unattended
 *   cash for the rest of the day too, which is why it takes the same
 *   deliberate strip that arming a project does rather than a bare button.
 * - **capped** — no press can help before midnight, so there is none: the
 *   session is told it is capped, with the way to raise the cap.
 * - **nowhere to overflow** — a configuration fact, named with the variable
 *   that would fix it.
 *
 * Polled rather than pushed. The task's SSE stream carries the feed (where the
 * same sentence lands as a system note, so the transcript records it), but the
 * crossing is fleet state that changes without this task doing anything — a
 * cap raised in another tab, another session spending the day's last dollar —
 * and one small GET a third of a minute is the cheaper half of that trade.
 */

/** What `/api/settings/metered-spend` says about an attended crossing. */
interface CrossingState {
  laneId: string | null;
  billing: "subscription" | "metered" | null;
  walled: boolean;
  overage: boolean;
  overflowedFrom: string | null;
  refusal: CrossingRefusal | null;
  notice: string | null;
  spentUsd: number;
  capUsd: number;
}

interface MeteredState {
  crossing: CrossingState;
}

const POLL_MS = 20_000;

export function MeteredCrossing({ live }: { live: boolean }) {
  const { data, error, reload, setData } = useLoad<MeteredState>(
    "/api/settings/metered-spend"
  );
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [pressError, setPressError] = useState<string | null>(null);
  const triggerRef = useReturnFocus<HTMLButtonElement>(confirming);

  useEffect(() => {
    // A finished session cannot cross onto anything, so it stops asking.
    if (!live) return;
    const timer = setInterval(reload, POLL_MS);
    return () => clearInterval(timer);
  }, [live, reload]);

  // A failed load says nothing: this is an advisory panel beside a
  // conversation, and "the fleet might be about to spend money" is worse than
  // silence — the orchestrator refuses the turn either way, and its refusal
  // reaches the feed.
  if (data === null || error !== null) return null;

  const { crossing } = data;
  if (crossing.refusal === null && crossing.notice === null) return null;

  async function confirm() {
    setBusy(true);
    setPressError(null);
    try {
      const res = await fetch("/api/settings/metered-spend", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmed: true }),
      });
      const answer = await res.json();
      if (!res.ok) {
        throw new Error(
          typeof answer?.error === "string"
            ? answer.error
            : `the server answered ${res.status}`
        );
      }
      // The PATCH answers with the whole state, crossing included — the
      // freshest copy there is, and it is what removes this panel.
      setData(answer as MeteredState);
      setConfirming(false);
    } catch (err) {
      setPressError(
        `That didn't stick — ${err instanceof Error ? err.message : "the request failed"}.`
      );
    }
    setBusy(false);
  }

  // Nothing is being held: the session is simply spending money, and saying so
  // quietly is the whole job.
  if (crossing.refusal === null) {
    return (
      <p
        className="shrink-0 border-t border-fl-line px-4 py-2 text-[13px] text-fl-ink-2"
        data-testid="crossing-notice"
      >
        {crossing.notice}
      </p>
    );
  }

  const held = crossing.refusal;
  return (
    <div className="shrink-0 border-t border-fl-line px-4 py-3">
      <div className={`${PANEL} ${TONES[held.reason === "cap-reached" ? "red" : "amber"]}`}>
        <p className="text-[13px]" role={held.reason === "cap-reached" ? "alert" : undefined}>
          {held.message}
        </p>

        {held.reason === "unconfirmed" && !confirming && (
          <ControlButton
            ref={triggerRef}
            tone="amber"
            disabled={busy}
            onClick={() => setConfirming(true)}
          >
            {busy ? "…" : "confirm real-money spend…"}
          </ControlButton>
        )}

        {held.reason !== "unconfirmed" && (
          <p className="font-plex-mono text-[11px] text-fl-ink-3">
            <ActionLink size="sm" href="/settings">
              settings
            </ActionLink>{" "}
            — {held.reason === "cap-reached" ? "raise the cap" : "lanes and credentials"}
          </p>
        )}

        {confirming && (
          <ConfirmStrip
            label="Confirm today's real-money spend"
            tone="amber"
            confirm="confirm spend"
            busyLabel="confirming…"
            busy={busy}
            error={pressError}
            onConfirm={confirm}
            onCancel={() => setConfirming(false)}
          >
            <p className="text-[13px]">
              Spend real money on{" "}
              <span className="font-plex-mono">{crossing.laneId}</span> for the
              rest of today? This session continues immediately, and the
              confirmation is the fleet&apos;s — autonomous passes may also
              spend up to <Money usd={crossing.capUsd} /> until local midnight,
              when it lapses on its own.
            </p>
          </ConfirmStrip>
        )}

        {!confirming && pressError !== null && (
          <p role="alert" className="text-[13px] text-fl-red">
            {pressError}
          </p>
        )}
      </div>
    </div>
  );
}
