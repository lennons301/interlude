"use client";

import { useState } from "react";
import { ConfirmStrip } from "@/components/confirm-strip";
import type {
  LaneMoveDecision,
  LaneMoveOffer,
  LaneMoveRefusal,
} from "@/lib/orchestrator/autonomy/lane-move";
import { formatUsdPerMTok } from "@/lib/lanes/lane-rate";
import { useReturnFocus } from "@/lib/use-return-focus";
import { ActionLink, ControlButton, PANEL, TONES } from "./fleet-bits";

/**
 * The per-run control that moves a parked run onto a paid lane now (issue
 * #202), on the fleet card of a run the quota wall parked.
 *
 * Issue #199 makes the sweep move such a run by itself the moment the ranking
 * would choose to. This is for the case where it would not — most often
 * because nobody has confirmed the day's real-money spend — and the operator,
 * looking at a one-slot box with a dependency chain stalled behind this run,
 * would rather pay than wait.
 *
 * It decides nothing. A press asks the route what the move would be, and the
 * answer is the same pure decision the press then executes: the lane, what it
 * costs per million tokens, which continuation of the attempt it would be, and
 * whether the wall it skips is still standing. That goes in front of the
 * operator as a confirmation *before* any money is spent — the money guards
 * do not waive themselves for a press, so a lane held for the day's
 * confirmation is refused naming the press, a capped one naming the cap, and
 * one with nowhere to go naming what is missing. Refused, the control says
 * so; it never appears to have worked.
 *
 * Rendered outside the card's link — a button inside an anchor is not a thing
 * — and only on a paused card, which is the only card the route would not
 * refuse with "not parked".
 */

/** The route's `GET` answer, as this control reads it. */
interface Reading {
  decision: LaneMoveDecision;
}

/** The route's `POST` answer. */
type MoveAnswer =
  | { ok: true; offer: LaneMoveOffer; taskId: string }
  | { ok: false; refusal: LaneMoveRefusal }
  | { error: string };

type Phase =
  | { kind: "idle" }
  | { kind: "asking" }
  | { kind: "offered"; offer: LaneMoveOffer }
  | { kind: "refused"; refusal: LaneMoveRefusal }
  | { kind: "moving"; offer: LaneMoveOffer }
  | { kind: "moved"; offer: LaneMoveOffer }
  | { kind: "failed"; message: string };

export function LaneMoveControl({
  runId,
  ticket,
}: {
  runId: string;
  /** The ticket the run is for, for the confirmation's prose. */
  ticket: string | null;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [pressError, setPressError] = useState<string | null>(null);

  async function ask() {
    setPhase({ kind: "asking" });
    setPressError(null);
    try {
      const res = await fetch(`/api/runs/${runId}/lane-move`);
      if (!res.ok) throw new Error(`the server answered ${res.status}`);
      const reading = (await res.json()) as Reading;
      setPhase(
        reading.decision.ok
          ? { kind: "offered", offer: reading.decision.offer }
          : { kind: "refused", refusal: reading.decision.refusal }
      );
    } catch (err) {
      setPhase({
        kind: "failed",
        message: `Couldn't ask about the move — ${err instanceof Error ? err.message : "the request failed"}.`,
      });
    }
  }

  async function move(offer: LaneMoveOffer) {
    setPhase({ kind: "moving", offer });
    setPressError(null);
    try {
      const res = await fetch(`/api/runs/${runId}/lane-move`, { method: "POST" });
      const answer = (await res.json()) as MoveAnswer;
      if ("error" in answer) throw new Error(answer.error);
      // The route decided again as it moved, so its answer — not the offer
      // the operator confirmed — is what happened.
      setPhase(
        answer.ok
          ? { kind: "moved", offer: answer.offer }
          : { kind: "refused", refusal: answer.refusal }
      );
    } catch (err) {
      // The offer stays on screen with the failure under it, so the operator
      // can try again without re-asking.
      setPhase({ kind: "offered", offer });
      setPressError(
        `The move didn't happen — ${err instanceof Error ? err.message : "the request failed"}.`
      );
    }
  }

  return (
    <LaneMovePanel
      phase={phase}
      ticket={ticket}
      pressError={pressError}
      onAsk={ask}
      onMove={move}
      onDismiss={() => {
        setPhase({ kind: "idle" });
        setPressError(null);
      }}
    />
  );
}

/** The control as words and buttons, given where it is in the press. Separate
 * from the fetching above so what it says in each state is testable without a
 * fleet. */
export function LaneMovePanel({
  phase,
  ticket,
  pressError,
  onAsk,
  onMove,
  onDismiss,
}: {
  phase: Phase;
  ticket: string | null;
  /** Why the last press did not take, if it did not. */
  pressError: string | null;
  onAsk: () => void;
  onMove: (offer: LaneMoveOffer) => void;
  onDismiss: () => void;
}) {
  const open = phase.kind === "offered" || phase.kind === "moving";
  const triggerRef = useReturnFocus<HTMLButtonElement>(open);
  const subject = ticket ?? "this run";

  if (phase.kind === "idle" || phase.kind === "asking") {
    return (
      <ControlButton
        ref={triggerRef}
        disabled={phase.kind === "asking"}
        onClick={onAsk}
        aria-label={`Move ${subject} onto a paid lane now`}
      >
        {phase.kind === "asking" ? "…" : "move to paid lane…"}
      </ControlButton>
    );
  }

  if (phase.kind === "offered" || phase.kind === "moving") {
    const { offer } = phase;
    const busy = phase.kind === "moving";
    return (
      <ConfirmStrip
        label={`Confirm moving ${subject} onto ${offer.toLaneLabel}`}
        tone="cool"
        confirm="move now"
        busyLabel="moving…"
        busy={busy}
        error={pressError}
        onConfirm={() => onMove(offer)}
        onCancel={onDismiss}
      >
        <p className="text-[13px]">
          Move {subject} onto <span className="font-medium">{offer.toLaneLabel}</span>{" "}
          now? {offer.cost}
          {offer.rateUsdPerMTok !== null && (
            <>
              {" "}
              <span className="font-plex-mono">
                ({formatUsdPerMTok(offer.rateUsdPerMTok)}/Mtok)
              </span>
            </>
          )}
        </p>
        <p className="text-[13px] text-fl-ink-2">
          {offer.wallStands
            ? `The window on ${offer.fromLaneId ?? "its lane"} is still standing, so the run would otherwise wait it out.`
            : `The window on ${offer.fromLaneId ?? "its lane"} has already reset, so the run resumes on its own lane for nothing within a few minutes — moving it now pays for that.`}{" "}
          This counts as continuation {offer.resume} of {offer.maxResumes} for
          the attempt. The lane is re-chosen as the pass starts, and the task
          records where it actually ran.
        </p>
      </ConfirmStrip>
    );
  }

  if (phase.kind === "moved") {
    return (
      <p role="status" className="font-plex-mono text-[11px] text-fl-ink-2">
        moving to {phase.offer.toLaneLabel} — the pass starts on the next poll
      </p>
    );
  }

  if (phase.kind === "failed") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <p role="alert" className="text-[13px] text-fl-red">
          {phase.message}
        </p>
        <ControlButton ref={triggerRef} onClick={onDismiss}>
          dismiss
        </ControlButton>
      </div>
    );
  }

  // Refused, with the reason. A money hold is amber — one press or one raised
  // cap away, and the settings screen is where both live — where nowhere to go
  // is red, because no press here or there changes it.
  const { refusal } = phase;
  const money = refusal.reason === "unconfirmed" || refusal.reason === "cap-reached";
  return (
    <div
      className={`${PANEL} ${TONES[money ? "amber" : "red"]}`}
      role={money ? "status" : "alert"}
    >
      <p className="text-[13px]">{refusal.message}</p>
      <div className="flex flex-wrap items-center gap-2">
        {(money || refusal.reason === "no-lane") && (
          <p className="font-plex-mono text-[11px] text-fl-ink-3">
            <ActionLink size="sm" href="/settings">
              settings
            </ActionLink>{" "}
            — {money ? "real money" : "lanes and credentials"}
          </p>
        )}
        <ControlButton ref={triggerRef} onClick={onDismiss}>
          dismiss
        </ControlButton>
      </div>
    </div>
  );
}
