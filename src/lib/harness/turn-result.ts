/**
 * What one agent turn hands back to the orchestrator (issue #214) — the
 * harness-neutral half of the adapter contract.
 *
 * Before this ticket the turn manager and the reducer read Claude Code's own
 * vocabulary off the result: turn exhaustion was one of the CLI's result
 * subtypes, a quota refusal was its error flag beside an HTTP status, and the
 * decision of what a turn *meant* was spread over three modules that each
 * knew one vendor field. A second harness could not be written against that.
 *
 * So the result now carries a **normalised outcome** beside the vendor's
 * verbatim fields. The adapter is the only thing that knows how its harness
 * says "I ran out of turns" or "the account refused me", and it says so here
 * in four words the rest of the fleet branches on. The verbatim fields stay
 * for the stream recorder, which exists precisely to keep what this build did
 * not know it needed (issue #165), and for nothing else: an orchestrator
 * module that reads `terminalResult` for a decision is reading a vendor.
 */

import type { QuotaObservation } from "../quota/rate-limit-event";
import type { TurnTokenUsage } from "../lanes/lane-cost";

/**
 * Why a provider refused the turn.
 *
 * - `quota`: the account's allowance is spent — a wall the fleet handles
 *   with its wall ordering (tier degrade, lane failover, pause: issues #168,
 *   #170, #176). The only kind that acts today.
 * - `auth`: the credential was rejected. A lane-availability problem, never a
 *   wall; what the fleet does about it is issue #220's.
 * - `other`: the provider said no for a reason this build does not model
 *   (overloaded, a 5xx). Takes the ordinary failure path until #220.
 */
export type TurnRefusalKind = "quota" | "auth" | "other";

export interface TurnRefusal {
  kind: TurnRefusalKind;
  /**
   * When the refusal lifts, if the harness said — the earliest moment a
   * paused run could be tried again — or null when it named none. Taken from
   * the harness verbatim, never computed from a window length: a resume time
   * the fleet invented would be wrong in the direction that costs an attempt.
   */
  resumeAfter: Date | null;
  /**
   * The window that refused it, in the harness's own words (`five_hour`,
   * `seven_day_opus`, …), or null when it named none. Only a `quota` refusal
   * ever carries one, and only the tier ladder reads it (issue #170) — for
   * exactly one distinction: whether its trailing segment names a tier the run
   * can step down from. A member no build has heard of names no tier and is
   * carried through verbatim, as every quota enum is.
   */
  limitType: string | null;
}

/**
 * How the turn ended, in the fleet's vocabulary.
 *
 * - `completed`: the harness ran to a clean finish. The final message is the
 *   agent's own — the blocked-marker detector, the review verdict and the
 *   triage exit may read it.
 * - `turn-limit`: the harness stopped the turn at its own turn ceiling. An
 *   implement attempt is exhausted by it (issue #18).
 * - `refused`: the provider refused the turn before the agent did any work.
 *   The final message, if any, is the harness's own explanation, not the
 *   agent's — see `TurnRefusal`.
 * - `failed`: the harness reported a terminal error of its own. `reason` is
 *   the harness's word for it, for the feed; nothing branches on it.
 */
export type TurnOutcome =
  | { kind: "completed" }
  | { kind: "turn-limit" }
  | { kind: "refused"; refusal: TurnRefusal }
  | { kind: "failed"; reason: string | null };

/**
 * The quota wall a turn hit, or null when it hit none — the one reading of a
 * refusal's *kind* the fleet makes outside the adapter. The turn manager asks
 * it to know whether a failover is worth pricing, and the reducer to run the
 * wall ordering (degrade, failover, pause: issues #170, #176, #168); a refusal
 * of another kind is not a wall, since the account has not run out of
 * anything, and a null outcome hit nothing. Written once so the two cannot
 * disagree about what counts.
 */
export function quotaRefusalOf(outcome: TurnOutcome | null): TurnRefusal | null {
  if (outcome === null || outcome.kind !== "refused") return null;
  return outcome.refusal.kind === "quota" ? outcome.refusal : null;
}

export interface TurnResult {
  sessionId: string | null;
  /** What the turn cost, as the harness reported it. `runTurn` replaces this
   * with the lane's own price where the lane declares one (issue #175). */
  costUsd: number;
  /** The turn's final message — what the blocked-marker detector, the review
   * verdict parser and the triage exit parser read. Null when the turn
   * produced no text at all. */
  finalMessage: string | null;
  /**
   * How the turn ended, normalised — or **null when the harness never said**:
   * the process died without reporting a terminal state (an OOM, a lost
   * stream, a container torn down mid-turn). That is deliberately not a fifth
   * outcome. It is the absence of one, and the interruption bound (issue #97)
   * owns it upstream of every reading of an outcome: a pass with no outcome
   * is an infra death charged to nobody, where a `failed` outcome is the
   * work's.
   */
  outcome: TurnOutcome | null;
  /**
   * The harness's terminal event verbatim, or null when none arrived — for
   * the passive recorder (issue #165), which writes down the pass's exit
   * condition whole because the fields that mattered were not the fields
   * anyone was reading. Nothing outside the adapter that produced it may
   * decide on its contents: that is what `outcome` is for.
   */
  terminalResult: Record<string, unknown> | null;
  /**
   * The last quota observation of the turn, or null when the stream carried
   * none (issue #167) — the ordinary case on a lane whose harness or provider
   * emits no quota telemetry. The last rather than the first, because a
   * harness that retries emits one per attempt and only the newest describes
   * the account now.
   */
  rateLimit: QuotaObservation | null;
  /**
   * The tokens the turn consumed, or null when the harness reported none
   * (issue #175) — what a lane's own prices are applied to when the harness's
   * dollar figure cannot be trusted.
   */
  usage: TurnTokenUsage | null;
}
