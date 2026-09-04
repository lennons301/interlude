"use client";

import { useState } from "react";
import { ConfirmStrip } from "@/components/confirm-strip";
import type {
  LaneMoveOffer,
  LaneMoveRefusal,
  ManualLaneMoveReading,
  ManualLaneMoveResult,
} from "@/lib/orchestrator/autonomy/lane-move";
import { formatUsdPerMTok } from "@/lib/lanes/lane-rate";
import { useReturnFocus } from "@/lib/use-return-focus";
import {
  ActionLink,
  ControlButton,
  Money,
  PANEL,
  TONES,
} from "./fleet-bits";

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
 * costs per million tokens, and which continuation of the attempt it would
 * be. That goes in front of the operator as a confirmation *before* any money
 * is spent. The money guards do not waive themselves for a press: a lane held
 * for the day's confirmation is refused naming the press — and, because a
 * human is standing here, the press is offered where they stand, as #173
 * offers it to an attended session, saying what it commits the fleet to; a
 * capped lane is refused naming the cap; one with nowhere to go names what is
 * missing. Refused, the control says so; it never appears to have worked.
 *
 * Rendered outside the card's link — a button inside an anchor is not a thing
 * — and only on a paused card, which is the only card the route would not
 * refuse with "not parked".
 */

type Phase =
  | { kind: "idle" }
  | { kind: "asking" }
  | { kind: "offered"; offer: LaneMoveOffer }
  | { kind: "refused"; refusal: LaneMoveRefusal }
  /** The day's-spend confirmation strip, open under an `unconfirmed` refusal. */
  | { kind: "confirming"; refusal: LaneMoveRefusal }
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
      const reading = (await res.json()) as ManualLaneMoveReading;
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
      const answer = (await res.json()) as ManualLaneMoveResult | { error: string };
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

  /** #174's fleet-level press, made here (issue #173's at-the-keyboard shape)
   * and followed by asking again — the answer is now the offer, with the lane
   * and its cost, for the operator's second press. */
  async function confirmSpend(refusal: LaneMoveRefusal) {
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
      await ask();
    } catch (err) {
      setPhase({ kind: "confirming", refusal });
      setPressError(
        `That didn't stick — ${err instanceof Error ? err.message : "the request failed"}.`
      );
    }
  }

  return (
    <LaneMovePanel
      phase={phase}
      ticket={ticket}
      pressError={pressError}
      busy={phase.kind === "asking" || phase.kind === "moving"}
      onAsk={ask}
      onMove={move}
      onOpenConfirm={(refusal) => {
        setPressError(null);
        setPhase({ kind: "confirming", refusal });
      }}
      onConfirmSpend={confirmSpend}
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
  busy,
  onAsk,
  onMove,
  onOpenConfirm,
  onConfirmSpend,
  onDismiss,
}: {
  phase: Phase;
  ticket: string | null;
  /** Why the last press did not take, if it did not. */
  pressError: string | null;
  /** A request is in flight. */
  busy: boolean;
  onAsk: () => void;
  onMove: (offer: LaneMoveOffer) => void;
  onOpenConfirm: (refusal: LaneMoveRefusal) => void;
  onConfirmSpend: (refusal: LaneMoveRefusal) => void;
  onDismiss: () => void;
}) {
  const stripOpen =
    phase.kind === "offered" || phase.kind === "moving" || phase.kind === "confirming";
  const triggerRef = useReturnFocus<HTMLButtonElement>(stripOpen);
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
          The window on {offer.fromLaneId ?? "its lane"} is still standing, so the
          run would otherwise wait it out. This counts as continuation{" "}
          {offer.resume} of {offer.maxResumes} for the attempt. The lane is
          re-chosen as the pass starts, and the task records where it actually
          ran.
        </p>
      </ConfirmStrip>
    );
  }

  if (phase.kind === "confirming") {
    const held = phase.refusal.heldLane;
    return (
      <ConfirmStrip
        label="Confirm today's real-money spend"
        tone="amber"
        confirm="confirm spend"
        busyLabel="confirming…"
        busy={busy}
        error={pressError}
        onConfirm={() => onConfirmSpend(phase.refusal)}
        onCancel={onDismiss}
      >
        <p className="text-[13px]">
          Spend real money on{" "}
          <span className="font-plex-mono">{held?.id ?? "a metered lane"}</span> for
          the rest of today? The confirmation is the fleet&apos;s — autonomous
          passes may also spend
          {held !== null && (
            <>
              {" "}
              up to <Money usd={held.capUsd} />
            </>
          )}{" "}
          until local midnight, when it lapses on its own. {subject} is then
          offered the move, with the lane and its cost, for you to make.
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
  // cap away — where nowhere to go is red, because no press changes it. The
  // window having reset is quiet news rather than a fault, so it reads amber
  // too: nothing is wrong, the run is minutes from resuming free.
  const { refusal } = phase;
  const money = refusal.reason === "unconfirmed" || refusal.reason === "cap-reached";
  const calm = money || refusal.reason === "window-reset";
  return (
    <div
      className={`${PANEL} ${TONES[calm ? "amber" : "red"]}`}
      role={calm ? "status" : "alert"}
    >
      <p className="text-[13px]">{refusal.message}</p>
      <div className="flex flex-wrap items-center gap-2">
        {refusal.reason === "unconfirmed" && (
          <ControlButton
            ref={triggerRef}
            tone="amber"
            disabled={busy}
            onClick={() => onOpenConfirm(refusal)}
          >
            confirm real-money spend…
          </ControlButton>
        )}
        {(money || refusal.reason === "no-lane") && (
          <p className="font-plex-mono text-[11px] text-fl-ink-3">
            <ActionLink size="sm" href="/settings">
              settings
            </ActionLink>{" "}
            — {money ? "real money" : "lanes and credentials"}
          </p>
        )}
        <ControlButton
          ref={refusal.reason === "unconfirmed" ? undefined : triggerRef}
          onClick={onDismiss}
        >
          dismiss
        </ControlButton>
      </div>
    </div>
  );
}
