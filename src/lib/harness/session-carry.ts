/**
 * Whether a resumed pass may continue its predecessor's conversation (issue
 * #217) — the pure decision `restoreSessionTranscript` in the turn manager
 * carries out.
 *
 * A pass continued past a quota wall — resumed off a pause (#169), moved to
 * another lane (#176, #199, #202) — is a new task row that may carry the
 * refused pass's session id. Continuing that session means putting the
 * harness's own artefacts back into a fresh container and asking the harness
 * to resume by id, and that is only meaningful when the harness on both ends
 * is the same one: the artefacts are one adapter's format, and the id names a
 * conversation only that harness has heard of. Every lane declared today runs
 * the one Claude Code adapter, which is why every move has been lossless so
 * far; this is what makes it *stay* true once a lane names a different one.
 *
 * The decision is made where both ends are known — as the pass starts, with
 * the lane it is starting on resolved — rather than when the continuation was
 * queued, because the target lane a move names is advisory: the ranking is
 * re-asked at start (#176), so the adapter the pass actually runs on is not
 * known until then. A leaf with no imports, so the turn manager and the tests
 * that pin the wording read one function.
 *
 * Three refusals, each saying so on the pass's own feed, because the owner
 * reading a fresh start next to an issue comment that promised a continuation
 * should be told why in the place they are looking:
 *
 * - **different adapter**: the conversation is one harness's and the pass is
 *   starting on another. It starts again on the branch with the work already
 *   pushed — the cost is the conversation, never the attempt, so a cross-
 *   adapter lane remains a legal failover target for the ranking.
 * - **no session resume**: the harness the pass is starting on declares it
 *   cannot resume a session at all, so nothing could be put back — and
 *   nothing was copied out at the pause either, which is why the same note
 *   answers for a run that paused and resumed on such a lane.
 * - **lane unknown**: the lane the conversation came from is no longer
 *   declared, so which harness the artefacts belong to cannot be told. Cautious
 *   by design: the store's own manifest may disagree with a lane file that has
 *   since re-pointed an id, and a session resumed against the wrong harness
 *   fails the pass outright where a fresh start merely costs its context.
 *
 * A continuation queued with **no** session says nothing here: a degrade (#170)
 * carries none by design, and a pause whose transcript did not survive already
 * said so on the refused pass's feed and on the issue.
 */

/** Where the conversation came from: the predecessor's lane, as the catalog
 * now describes it — or nothing, when the row names no lane or names one no
 * longer declared. */
export interface SessionOrigin {
  laneId: string | null;
  laneLabel: string | null;
  adapterId: string | null;
}

/** Where the pass is starting: the resolved lane and what its harness can do. */
export interface SessionDestination {
  laneId: string;
  laneLabel: string;
  adapterId: string;
  sessionResume: boolean;
}

export interface SessionCarryInput {
  /** The session the continuation was queued with; null when it carries none. */
  sessionId: string | null;
  /** The adapter the stored transcript names, or null when nothing is stored. */
  storedAdapter: string | null;
  from: SessionOrigin;
  to: SessionDestination;
}

export type SessionCarryRefusal =
  | "different-adapter"
  | "no-session-resume"
  | "lane-unknown"
  | "not-kept"
  | "none-carried";

export type SessionCarry =
  | { kind: "restore"; sessionId: string }
  | {
      kind: "fresh";
      reason: SessionCarryRefusal;
      /** What the pass's feed says, or null when there is nothing new to say. */
      note: string | null;
    };

const FRESH_START =
  "This pass continues on the same branch with the work pushed so far and no prior context.";

function fresh(reason: SessionCarryRefusal, note: string | null): SessionCarry {
  return { kind: "fresh", reason, note };
}

export function decideSessionCarry(input: SessionCarryInput): SessionCarry {
  const { sessionId, storedAdapter, from, to } = input;
  const origin = from.laneLabel ?? from.laneId ?? "its previous lane";

  // Certain whatever the origin: nothing can be put back into a harness that
  // cannot resume, and nothing was copied out of one at the pause.
  if (!to.sessionResume) {
    return fresh(
      "no-session-resume",
      `Starting again on the branch: ${to.laneLabel} runs ${to.adapterId}, which ` +
        `cannot resume a session, so the paused pass's conversation was not carried. ` +
        FRESH_START
    );
  }

  if (from.adapterId === null) {
    if (sessionId === null) return fresh("none-carried", null);
    return fresh(
      "lane-unknown",
      `Starting again on the branch: the lane the paused pass ran on ` +
        `(${from.laneId ?? "unrecorded"}) is no longer declared, so which harness ` +
        `its conversation belongs to cannot be told and it was not carried. ` +
        FRESH_START
    );
  }

  // The lineage's answer, and the store's own: the manifest says which adapter
  // wrote the artefacts, and a lane file that re-pointed an id since the pause
  // would make the two disagree — either disagreement is a different harness.
  const fromAdapter =
    storedAdapter !== null && storedAdapter !== to.adapterId ? storedAdapter : from.adapterId;
  if (fromAdapter !== to.adapterId) {
    return fresh(
      "different-adapter",
      `Starting again on the branch: the paused pass's conversation is a ` +
        `${fromAdapter} session from the ${origin} lane, and this pass is starting on ` +
        `${to.laneLabel}, which runs ${to.adapterId}. A session cannot be carried ` +
        `between two different harnesses, so it was not carried. ${FRESH_START} ` +
        `That costs the conversation, not the attempt.`
    );
  }

  if (sessionId === null) return fresh("none-carried", null);

  if (storedAdapter === null) {
    return fresh(
      "not-kept",
      "Resuming without the paused session's transcript — this pass continues " +
        "on the same branch, with the work pushed so far but no prior context."
    );
  }

  return { kind: "restore", sessionId };
}
