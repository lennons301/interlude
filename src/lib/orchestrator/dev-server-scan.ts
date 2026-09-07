/**
 * When the queue loop scans an interactive session's container for a dev
 * server (issue #160). Pure: the poll loop hands in what it knows and gets a
 * yes/no, so the cadence is a table rather than a nest of `continue`s.
 *
 * The scan used to run only at turn boundaries and on a 30s poll gated to
 * *idle* sessions. A lovable-style session is one long turn — the agent starts
 * the server a minute in and works for twenty — so for that whole window
 * `devPort` stayed null and the pane read "No dev server running" (a 21-minute
 * gap in the #160 evidence). A live-preview session is now scanned while its
 * turn is running too, on a short interval, because seeing the app come up
 * mid-turn is the point of that session type.
 */

export type SessionEntryState = "setup" | "running" | "idle" | "completing";

/** Every 5 polls of the 2s loop: ~10s. Fast enough that the pane appears while
 * the agent is still working, and two execs (`ss`, then a curl per candidate)
 * every 10s into one container is nothing. */
export const PREVIEW_SCAN_EVERY_POLLS = 5;

/** Every 15 polls: ~30s, the cadence the idle-only scan always had. */
export const CHAT_SCAN_EVERY_POLLS = 15;

export interface ScanProfile {
  /** The owner chose the live-preview session type at entry. */
  livePreview: boolean;
  /** Non-null on a generation session (grill-me, to-spec, …). */
  sessionSkill: string | null;
}

/**
 * - A generation session is never scanned: grilling and spec work run no app,
 *   and there is no reason to exec into them looking for one.
 * - A live-preview session is scanned every ~10s whether its turn is running
 *   or it is idle — the pane is its reason to exist.
 * - A plain chat keeps what it had: an idle scan every ~30s (plus the turn-end
 *   scan the turn manager runs itself), so a chat whose agent happens to start
 *   a server still gets a preview once the turn ends.
 * - Nothing is scanned while the container is being set up or torn down.
 */
export function devServerScanDue(
  profile: ScanProfile,
  state: SessionEntryState,
  pollCount: number
): boolean {
  if (state === "setup" || state === "completing") return false;
  if (profile.sessionSkill !== null) return false;
  if (profile.livePreview) return pollCount % PREVIEW_SCAN_EVERY_POLLS === 0;
  return state === "idle" && pollCount % CHAT_SCAN_EVERY_POLLS === 0;
}
