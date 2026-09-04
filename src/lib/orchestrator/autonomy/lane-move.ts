/**
 * The operator's manual move of a parked run onto another lane (issue #202):
 * what the fleet card's control is offered, or why it is refused.
 *
 * Issue #199 made a run parked on a quota wall re-check lanes on every sweep,
 * so a lane the ranking *would* choose moves the run at the next tick without
 * anyone pressing anything. This is the other case — the ranking would not
 * move it, and the operator wants it moved anyway: one container slot, a
 * dependency chain, and a run parked for hours in front of it. It is an
 * operator action, so it is attended, and the two things "attended" changes
 * are the two rules below:
 *
 * - **It still answers to the money guards.** The lane it is offered comes
 *   from the same failover ranking a refused pass is offered at its wall and a
 *   parked run is re-ranked by every sweep, with #174's cap and confirm-once
 *   press evaluated *inside* that ranking per lane. A press does not waive
 *   them: an unconfirmed lane is refused naming the press, a capped one
 *   naming the cap. What the press changes is only that a human is here to
 *   be told — a sweep has nobody to tell, so it stays parked in silence — and
 *   the card puts the day's confirmation in front of them where they stand,
 *   as #173 does for an attended session, saying what it commits the fleet to.
 * - **Refused with a stated reason, never silently.** A control that does
 *   nothing tells the operator nothing; this one says which lane a press would
 *   free, or why nowhere at all can serve the run — a missing credential, the
 *   pass kind's floor, a pin, a wall on the other lane too. That is why the
 *   route reads the whole ranking (`selectLaneFailover`) rather than the
 *   winner the reducer is content with: the reasons live in the losers.
 *
 * Pure, so the route's GET (what would happen) and POST (do it) decide from
 * one function over one reading of the facts, and the card can never offer a
 * move the press then refuses on different grounds. The impure half — reading
 * the run, ranking the lanes, queueing the pass — is `paused-runs.ts`, beside
 * the sweep's own executors, which the move shares.
 *
 * The move is a lane move like any other (#176, #199): it counts against the
 * same resume bound a clock-driven resume does — judged here, first, because a
 * run with no continuations left is never going to resume anywhere and the
 * sweep is about to hand its ticket to a human — carries the session where the
 * transcript survived, and is announced with the lane and what it costs. And
 * like #199's early resume it is only for a wall that **still stands**: once
 * the window has reset the run's own lane is free again and the ordinary
 * resume is minutes away, so a move then would spend a continuation and be
 * re-ranked straight back onto the free lane as the pass started — paying, in
 * effect, for nothing. The reducer takes the ordinary resume there; this
 * refuses and says so.
 */

import type { runs } from "@/db/schema";
import type { AgentPassKind } from "../../config";
import type { LaneBilling } from "../../lanes/lane-config";
import { describeLaneCost } from "../../lanes/lane-rate";
import type { LaneCandidate, LaneSelection } from "../../lanes/lane-selection";

type RunStatus = (typeof runs.$inferSelect)["status"];

/** Why the move is refused. Ordered as they are judged: a run that is not
 * parked, or already resuming, is not up for a decision at all; the bound is
 * judged before the clock and the lanes, as the reducer judges it. */
export type LaneMoveRefusalReason =
  /** The run is not `rate_limited` — nothing is parked. */
  | "not-parked"
  /** A pass of this run is already queued or running: the move is under way. */
  | "already-resuming"
  /** The run owns no implement or repair pass to resume. */
  | "no-pass"
  /** The attempt has spent every continuation the bound allows. */
  | "resume-bound"
  /** The window has already reset (or the row carries no clock), so the run
   * resumes on its own lane by itself — a move would pay for nothing. */
  | "window-reset"
  /** A lane could serve it, but today's real-money spend is not confirmed
   * (#174's press). */
  | "unconfirmed"
  /** A lane could serve it, but today's real-money cap is spent. */
  | "cap-reached"
  /** No other lane can serve the run at all. */
  | "no-lane";

export interface LaneMoveRefusal {
  reason: LaneMoveRefusalReason;
  /** What to tell the operator — written where the decision is made, so the
   * card and the route's headless answer say the same thing. */
  message: string;
  /** The lane a press or a raised cap would free, when the refusal is one of
   * #174's holds; null otherwise. Carried so a screen can name it beside the
   * control that frees it, and quote the cap that press authorises. */
  heldLane: { id: string; label: string; spentUsd: number; capUsd: number } | null;
}

/** The move as it would happen — what the confirmation shows before the
 * operator spends the money, and what the announcement then quotes. */
export interface LaneMoveOffer {
  toLaneId: string;
  toLaneLabel: string;
  /** What running there costs — the effective kind, so an overage-covered
   * subscription target reads as the cash it is. */
  billing: LaneBilling;
  /** USD per Mtok of the ranking mix on that lane, or null when it declares no
   * prices. */
  rateUsdPerMTok: number | null;
  /** The cost in one sentence — `describeLaneCost`, the same one the issue
   * comment quotes, so the screen and the record cannot say different things
   * about the money. */
  cost: string;
  /** Which continuation of this attempt the move would be, and the bound it
   * counts against — the same pair every resume and lane move states. */
  resume: number;
  maxResumes: number;
  /** The lane that walled the paused pass; null when its row recorded none. */
  fromLaneId: string | null;
  /** When that window resets, ISO-8601 — still in the future, since a move is
   * only offered while the wall stands. */
  resumeAfter: string;
}

export type LaneMoveDecision =
  | { ok: true; offer: LaneMoveOffer }
  | { ok: false; refusal: LaneMoveRefusal };

/** What a press on the fleet card is told: the decision, and — so the route
 * can answer without a second read — what it was decided about. */
export interface ManualLaneMoveReading {
  runId: string;
  /** "owner/repo#n" */
  issueRef: string;
  decision: LaneMoveDecision;
}

/** The outcome of pressing it: the move as made, or the refusal. */
export type ManualLaneMoveResult =
  | { ok: true; offer: LaneMoveOffer; taskId: string }
  | { ok: false; refusal: LaneMoveRefusal };

/** Everything the decision reads, gathered by the caller. */
export interface LaneMoveFacts {
  /** `runs.status` — only `rate_limited` is parked. */
  runStatus: RunStatus;
  /** A task of this run already queued or running — the idempotency fact. */
  hasLiveTask: boolean;
  /** The kind of pass that would resume, or null when the run owns no
   * implement or repair pass. Named in the floor's clause. */
  passKind: AgentPassKind | null;
  /** Continuations this attempt has already had (`runs.resumeCount`). */
  resumesMade: number;
  /** The bound they count against. */
  maxResumes: number;
  /** The lane the paused pass ran on — the one that walled it. */
  fromLaneId: string | null;
  /** The run's `resumeAfter`. */
  resumeAfter: Date | null;
  /** The failover ranking with the walled lane excluded, or null when the lane
   * file could not be read. */
  selection: LaneSelection | null;
  now: Date;
}

export function decideManualLaneMove(facts: LaneMoveFacts): LaneMoveDecision {
  if (facts.runStatus !== "rate_limited") {
    return refuse(
      "not-parked",
      `This run is ${facts.runStatus}, not parked on a quota window — only a ` +
        `parked run can be moved.`
    );
  }
  if (facts.hasLiveTask) return refuse("already-resuming", ALREADY_RESUMING);
  const passKind = facts.passKind;
  if (passKind === null) {
    return refuse(
      "no-pass",
      "This run owns no implement or repair pass to resume."
    );
  }
  // The bound before the clock and the lanes, as the reducer judges it: a run
  // with no continuations left is never going to resume anywhere, and the
  // sweep is about to hand its ticket to a human — moving it would only defer
  // that.
  if (facts.resumesMade >= facts.maxResumes) {
    return refuse(
      "resume-bound",
      facts.maxResumes === 0
        ? "Continuing after a quota pause is switched off (the resume bound is " +
            "0), so this run cannot be moved — the sweep hands its ticket to a " +
            "human instead."
        : `This attempt has used all ${facts.maxResumes} of its continuations ` +
            `(resumes and lane moves), so it cannot be moved again — the sweep ` +
            `hands its ticket to a human instead.`
    );
  }
  // Only while the wall stands. Past the reset — or with no clock at all, which
  // the reducer reads as eligible now — the run's own lane is free again and
  // the ordinary resume is minutes away; a move would spend a continuation and
  // be re-ranked straight back onto that lane as the pass started.
  const from = facts.fromLaneId ?? "its lane";
  if (facts.resumeAfter === null) {
    return refuse(
      "window-reset",
      `This run carries no reset time, so it resumes on its own lane at the ` +
        `next sweep — there is nothing to move.`
    );
  }
  if (facts.now.getTime() >= facts.resumeAfter.getTime()) {
    return refuse(
      "window-reset",
      `The window on ${from} reset at ${facts.resumeAfter.toUTCString()}, so ` +
        `this run resumes on its own lane by itself within a few minutes. A ` +
        `move now would pay for nothing: the lane is re-chosen as the pass ` +
        `starts, and its own lane is free again.`
    );
  }

  const selection = facts.selection;
  const chosen = selection?.chosen ?? null;
  if (selection !== null && chosen !== null) {
    return {
      ok: true,
      offer: {
        toLaneId: chosen.id,
        toLaneLabel: chosen.label,
        billing: chosen.effectiveBilling,
        rateUsdPerMTok: chosen.rateUsdPerMTok,
        cost: describeLaneCost(chosen.effectiveBilling, chosen.rateUsdPerMTok),
        resume: facts.resumesMade + 1,
        maxResumes: facts.maxResumes,
        fromLaneId: facts.fromLaneId,
        resumeAfter: facts.resumeAfter.toISOString(),
      },
    };
  }

  // Nothing may run. A lane a press would free is the news — "confirm the
  // day's spend" and "there is nowhere to go" send the operator to different
  // places — so it is asked first, off the same field the crossing's refusal
  // reads (#173).
  const held = selection?.heldForMoney ?? null;
  if (held !== null && held.money !== null) {
    const money = held.money;
    const heldLane = {
      id: held.id,
      label: held.label,
      spentUsd: money.spentUsd,
      capUsd: money.capUsd,
    };
    if (held.ineligible === "cap-reached") {
      return refuse(
        "cap-reached",
        `${held.label} could serve this run, but today's real-money cap of ` +
          `${usd(money.capUsd)} is spent (${usd(money.spentUsd)} on metered ` +
          `lanes). Raise the cap (Settings ▸ Real money), or wait for local ` +
          `midnight.`,
        heldLane
      );
    }
    return refuse(
      "unconfirmed",
      `${held.label} could serve this run, but today's real-money spend is not ` +
        `confirmed. Real money: ${usd(money.spentUsd)} of ${usd(money.capUsd)} ` +
        `spent today. Confirm real-money spend first, then press again.`,
      heldLane
    );
  }

  return refuse(
    "no-lane",
    `No other lane can serve this run: ${describeNoLane(facts.fromLaneId, passKind, selection)}.`
  );
}

const ALREADY_RESUMING =
  "This run is already resuming — a pass for it is queued or running, so " +
  "there is nothing to move.";

/**
 * A refusal, built where the decision is made — exported so the one caller
 * that can be refused *after* deciding (the move itself, when the run moved on
 * between the decision and the write) says the same words rather than its own.
 */
export function refuse(
  reason: LaneMoveRefusalReason,
  message: string = reason === "already-resuming" ? ALREADY_RESUMING : reason,
  heldLane: LaneMoveRefusal["heldLane"] = null
): Extract<LaneMoveDecision, { ok: false }> {
  return { ok: false, refusal: { reason, message, heldLane } };
}

/** `$12.34` — the shape the dashboard's money reads in, so a refusal quotes
 * the cap the way the settings panel does. */
function usd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/**
 * Why nowhere can serve the run, lane by lane, grouped by reason so a fleet
 * whose four lanes are all held for the same reason reads as one clause.
 *
 * Reached only when nothing is eligible and nothing is held for money alone,
 * so every candidate here is missing a credential, excluded by a pin or the
 * pass kind's floor, or walled itself — or the lane file declares nothing else.
 * The walled lane is not a reason: it is what the operator is trying to leave.
 */
function describeNoLane(
  fromLaneId: string | null,
  passKind: AgentPassKind,
  selection: LaneSelection | null
): string {
  if (selection === null) return "the lane file could not be read";

  // The walled lane is dropped by id as well as by verdict, because the
  // ranking judges a pin ahead of exclusion and so reports it as "not pinned"
  // under a pin to a third lane.
  const others = selection.candidates.filter(
    (lane) => lane.ineligible !== "already-tried" && lane.id !== fromLaneId
  );
  if (others.length === 0) {
    return fromLaneId === null
      ? "no lane is declared in lanes.yaml"
      : `no lane other than ${fromLaneId} is declared in lanes.yaml`;
  }

  const clauses: string[] = [];
  // `missingEnvVars` is the ranking's own reading of `laneMissingEnv`, so what
  // makes a lane unavailable is still answered in one place (#172).
  for (const lane of byReason(others, "unavailable")) {
    clauses.push(`${lane.id} needs ${lane.missingEnvVars.join(", ")}`);
  }
  const pinnedOut = byReason(others, "not-pinned");
  if (pinnedOut.length > 0 && selection.pinnedLaneId !== null) {
    clauses.push(
      `the fleet is pinned to ${selection.pinnedLaneId} (Settings ▸ Execution ` +
        `lane), so ${ids(pinnedOut)} ` +
        `${pinnedOut.length === 1 ? "is not a candidate" : "are not candidates"}`
    );
  }
  // The floor is the operator's own setting, so a run held by one must say so
  // rather than read as a broken deployment (#176).
  const belowFloor = byReason(others, "below-floor");
  if (belowFloor.length > 0 && selection.minLaneId !== null) {
    clauses.push(
      `${ids(belowFloor)} ${belowFloor.length === 1 ? "is" : "are"} below the ` +
        `${passKind} pass's minimum lane (${selection.minLaneId})`
    );
  }
  const walled = byReason(others, "walled");
  if (walled.length > 0) {
    clauses.push(
      `${ids(walled)} ${walled.length === 1 ? "is" : "are"} walled too`
    );
  }
  return clauses.length === 0
    ? `${ids(others)} cannot serve it`
    : clauses.join("; ");
}

function byReason(
  candidates: LaneCandidate[],
  reason: LaneCandidate["ineligible"]
): LaneCandidate[] {
  return candidates.filter((lane) => lane.ineligible === reason);
}

function ids(candidates: LaneCandidate[]): string {
  return candidates.map((lane) => lane.id).join(", ");
}
