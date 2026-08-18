/**
 * The composer's state machine (issue #122). One pure function turns what the
 * orchestrator says about a task — its status, its container's state, and how
 * many of your messages are still undelivered — into everything the composer
 * shows and allows: the status line, the placeholder, whether a message can be
 * handed over at all, and whether the session can be completed.
 *
 * It lives here rather than in the component because "is my message queued?"
 * and "can I complete this?" are exactly the answers a reader needs to trust,
 * and a table of cases is how you check them.
 */

/** What the agent is doing, from the composer's point of view. */
export type ComposerPhase =
  | "waiting" // task queued — no container yet
  | "starting" // container coming up
  | "working" // mid-turn
  | "idle" // finished a turn; your move
  | "blocked" // parked on a question to you (issue #19)
  | "closing" // completing: pushing the branch, tearing down
  | "closed"; // terminal

export interface ComposerState {
  phase: ComposerPhase;
  /** The status line, lowercase like the rest of the fleet's mono. */
  label: string;
  /** Colour of the status dot only — the label itself stays neutral ink, the
   * same rule the live view's header follows (11px colour on the bare ground
   * does not clear contrast in the light theme). */
  tone: "green" | "amber" | "quiet";
  placeholder: string;
  /** Whether a message can be handed over at all. False does not mean the
   * agent is busy — a busy agent still takes messages, they queue. */
  accepting: boolean;
  /** Whether an empty draft may be sent as a bare "continue". Only when the
   * agent is idle: telling a working agent to continue is noise, and it is not
   * an answer to a blocked run's question. */
  allowsContinue: boolean;
  canComplete: boolean;
  /** How many of your messages are waiting to be picked up, when any are. */
  queuedNote: string | null;
}

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

/** A task that has stopped for good. Shared with the live view, which gates the
 * whole composer on it — so the `closed` phase below is what the state machine
 * says about a task the view will not in fact show a composer for, and the two
 * cannot drift into disagreeing. */
export function isTerminalTaskStatus(status: string): boolean {
  return TERMINAL.has(status);
}

/** A message row's queue-relevant shape — its own `deliveredAt` is the only
 * record of whether the agent has seen it. */
export interface QueueableRow {
  role: string;
  deliveredAt: string | number | Date | null;
}

/**
 * Your messages the agent has not been handed yet. The turn manager delivers
 * the oldest undelivered user message whenever the container falls idle, so an
 * undelivered row is precisely one still in the queue — including messages sent
 * from Discord, or from this view before a reload.
 */
export function queuedCount(rows: readonly QueueableRow[]): number {
  return rows.filter((r) => r.role === "user" && r.deliveredAt == null).length;
}

function phaseOf(taskStatus: string, containerStatus: string | null): ComposerPhase {
  if (TERMINAL.has(taskStatus)) return "closed";
  if (taskStatus === "blocked") return "blocked";
  if (taskStatus !== "running") return "waiting";
  if (containerStatus === "completing") return "closing";
  if (containerStatus === "idle") return "idle";
  // A running task with no container status yet is one whose workspace is
  // still being built — the same situation as `setup`, said differently.
  return containerStatus === "running" ? "working" : "starting";
}

const PHASES: Record<
  ComposerPhase,
  Omit<ComposerState, "phase" | "queuedNote" | "canComplete">
> = {
  waiting: {
    label: "queued for a slot",
    tone: "quiet",
    placeholder: "The agent hasn't started yet",
    accepting: false,
    allowsContinue: false,
  },
  starting: {
    label: "setting up workspace",
    tone: "green",
    placeholder: "Setting up — your message will be queued",
    accepting: true,
    allowsContinue: false,
  },
  working: {
    label: "agent working",
    tone: "green",
    placeholder: "Agent is working — your message will be queued",
    accepting: true,
    allowsContinue: false,
  },
  idle: {
    label: "agent idle — your move",
    tone: "amber",
    placeholder: "Message the agent…",
    accepting: true,
    allowsContinue: true,
  },
  blocked: {
    label: "blocked on a question",
    tone: "amber",
    placeholder: "Answer the agent's question…",
    accepting: true,
    allowsContinue: false,
  },
  closing: {
    label: "wrapping up",
    tone: "quiet",
    placeholder: "Wrapping up…",
    accepting: false,
    allowsContinue: false,
  },
  closed: {
    label: "session ended",
    tone: "quiet",
    placeholder: "This session has ended",
    accepting: false,
    allowsContinue: false,
  },
};

export function composerState(input: {
  taskStatus: string;
  containerStatus: string | null;
  queued: number;
}): ComposerState {
  const phase = phaseOf(input.taskStatus, input.containerStatus);

  return {
    phase,
    ...PHASES[phase],
    // Completion is the orchestrator's contract, not a UI preference: the API
    // takes a running task only, and completing mid-turn would abandon work the
    // agent is part-way through. So it is offered exactly between turns.
    canComplete: phase === "idle",
    queuedNote: input.queued > 0 ? `${input.queued} queued` : null,
  };
}

/** Why ending the session is not on offer, by what the agent is doing. None of
 * these is a failure — each one is the session having moved on. */
const REFUSALS: Record<ComposerPhase, string | null> = {
  waiting: "The agent hasn't started yet — there's nothing to end.",
  starting: "The agent is still starting up. You can end the session once it's idle.",
  working: "The agent started a turn. You can end the session once it's idle again.",
  idle: null,
  blocked: "The agent is waiting on your answer — send it, then end the session.",
  closing: "This session is already wrapping up.",
  closed: "This session has already ended.",
};

/**
 * Why completion was refused, or null while it is on offer (issue #149).
 *
 * The composer asks this again at the moment the owner confirms, rather than
 * trusting that the button was enabled when they pressed it: a turn can start
 * in the seconds a confirmation sits open, and deciding a session is over just
 * as the agent picks the next turn up is not a rare coincidence — it is the
 * normal end of one. Refusing then is right, and nothing bad happens. Refusing
 * *silently* is what leaves the owner pressing a control that does nothing, so
 * the reason is a value the composer can say out loud rather than a bare early
 * return.
 */
export function completionRefusal(state: ComposerState): string | null {
  return state.canComplete ? null : REFUSALS[state.phase];
}

/**
 * What the primary button does. An empty draft on an idle agent means "carry
 * on" — the same move as replying in Discord to an idle notification — so the
 * button says `continue` and sends that word rather than sitting disabled with
 * nothing to explain itself. Where continuing is not on offer it stays the send
 * it will become: the label always names what will happen, never what won't.
 */
export function resolvePrimary(
  draft: string,
  allowsContinue: boolean
): { label: string; text: string } {
  const trimmed = draft.trim();
  if (trimmed) return { label: "send", text: trimmed };
  return allowsContinue
    ? { label: "continue", text: "continue" }
    : { label: "send", text: "" };
}
