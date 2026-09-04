/**
 * The paused pass's conversation, kept outside the container it was living in
 * (issue #169).
 *
 * A quota pause tears its container down — a parked one holds ~2 GiB while
 * holding no slot, and a five-hour window is far too long to hold one for
 * (#168) — so everything the pass had built would go with it unless something
 * copies it out first. The spike on #165 measured exactly what "it" is, and
 * the answer is smaller than the design assumed:
 *
 * - **One file is the whole transcript**: `~/.claude/projects/<mangled
 *   cwd>/<session id>.jsonl`. No sidecar state, no `.claude.json` entry.
 * - A pass **killed mid-tool-call resumes knowing how far it got**, so the
 *   half-finished transcript a pause produces is worth keeping, not just a
 *   cleanly-finished one.
 * - The CLI finds a session **by id**, not by directory, so the restore is not
 *   path-fragile — though we restore to the same path anyway, both containers
 *   being `/workspace/repo`.
 * - Resume **appends to the same file**, so pausing repeatedly accumulates one
 *   growing artefact rather than a chain to reassemble.
 *
 * The store is a directory beside the SQLite database, for the reason the
 * stream recorder's log is: it inherits the durable `/data` volume with no
 * migration and no second piece of path configuration to get wrong — and
 * "survives an orchestrator restart" is an acceptance criterion here, not a
 * nicety, because the process is restarted by every deploy and a five-hour
 * window outlives several.
 *
 * Keyed by **run**, not by session or task: the run is the thing that pauses,
 * the run is what a resume is decided about, and a resumed pass is a new task
 * row. One run therefore has at most one transcript, and a second pause
 * overwrites the first with the longer conversation that supersedes it.
 *
 * Every write swallows its own errors, like the recorder's: a transcript that
 * could not be saved costs the resumed pass its context, which is the stated
 * fallback (restart on the same branch, prior context lost) — it must never
 * cost the pause itself, which is what protects the ticket's attempt.
 *
 * The transcript is a **Claude Code** artefact, and that is a limit rather
 * than a detail (issue #199): a lane move (#176's failover, #199's early
 * resume) carries it onto another lane only because every declared lane runs
 * the same adapter. A move onto a lane running a different harness could not
 * — see the stated limit in `src/lib/harness/adapter.ts`.
 */

import fs from "fs";
import path from "path";

/**
 * Where the harness keeps a session's transcript inside the container, for a
 * pass working in `cwd`.
 *
 * Claude Code mangles the working directory into a single directory name by
 * replacing each path separator with a dash — `/workspace/repo` becomes
 * `-workspace-repo`. Written as a function of the cwd rather than a constant
 * so the derivation is visible (and testable) rather than a magic string
 * someone would have to reverse-engineer from a container.
 */
export function containerTranscriptDir(cwd: string): string {
  return `/home/node/.claude/projects/${cwd.replace(/\//g, "-")}`;
}

/** The working directory every agent pass runs in. */
export const AGENT_WORKDIR = "/workspace/repo";

/** The transcript file inside the container for one session id. */
export function containerTranscriptPath(
  sessionId: string,
  cwd: string = AGENT_WORKDIR
): string {
  return `${containerTranscriptDir(cwd)}/${sessionId}.jsonl`;
}

/**
 * Where transcripts live on the host: beside the SQLite database, so they
 * inherit its durable volume (`/data` on the VPS, the repo root in local dev).
 *
 * Pure, so the one thing worth checking — that it follows `DATABASE_URL`
 * wherever that points — is checkable without a filesystem.
 */
export function resolveTranscriptDir(databaseUrl: string | undefined): string {
  return path.join(path.dirname(databaseUrl ?? "local.db"), "session-transcripts");
}

/**
 * A run's transcript file. The run id is a ULID, but it arrives here from a
 * database row rather than from a literal, so it is checked against that shape
 * before it becomes a path: this function joins onto a directory, and a value
 * carrying `..` or a separator would escape it.
 */
export function transcriptPath(runId: string, dir: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) {
    throw new Error(`Refusing to build a transcript path for id "${runId}"`);
  }
  return path.join(dir, `${runId}.jsonl`);
}

function defaultDir(): string {
  return resolveTranscriptDir(process.env.DATABASE_URL);
}

/**
 * The largest transcript worth keeping, and the reason there is a limit at all:
 * this store shares the `/data` volume with the SQLite database, exactly as the
 * stream recorder's log does, so it may not grow without a ceiling.
 *
 * Refused rather than truncated, because half a transcript is not a smaller
 * transcript — it is a conversation the harness would resume into. A pass whose
 * transcript is over the ceiling takes the ordinary fallback (same branch,
 * prior context lost), which is a real answer; a truncated one would not be.
 * 32 MiB is far past any transcript observed (the #165 spike's was ~15 KB after
 * a full turn), so this is a runaway guard rather than a policy.
 */
export const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024;

/**
 * Keep a paused run's transcript. Overwrites any earlier one: a run that
 * pauses twice has one conversation, and the later copy contains the earlier.
 *
 * Returns whether it landed, because the caller's next decision depends on it
 * — a resumed pass with no transcript is the declared fallback (same branch,
 * prior context lost), and the run should say so rather than resume with
 * `--resume` against a session the container does not have.
 */
export function saveTranscript(
  runId: string,
  contents: Buffer | string,
  dir: string = defaultDir()
): boolean {
  const size = Buffer.byteLength(contents);
  if (size > MAX_TRANSCRIPT_BYTES) {
    console.warn(
      `[transcripts] Not keeping run ${runId}'s transcript: ${size} bytes is ` +
        `past the ${MAX_TRANSCRIPT_BYTES}-byte ceiling`
    );
    return false;
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(transcriptPath(runId, dir), contents);
    return true;
  } catch (err) {
    console.error(`[transcripts] Failed to save the transcript of run ${runId}:`, err);
    return false;
  }
}

/** A saved transcript, or null when the run has none. */
export function readTranscript(
  runId: string,
  dir: string = defaultDir()
): Buffer | null {
  try {
    return fs.readFileSync(transcriptPath(runId, dir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.error(`[transcripts] Failed to read the transcript of run ${runId}:`, err);
    }
    return null;
  }
}

/** Whether a run has a saved transcript — asked before a resume is queued, so
 * the pass is framed as a continuation or as a fresh start on the same branch
 * rather than discovering which it is halfway through. */
export function hasTranscript(runId: string, dir: string = defaultDir()): boolean {
  return fs.existsSync(transcriptPath(runId, dir));
}

/** Forget a run's transcript. Missing is success: the caller's intent is that
 * it be gone. */
export function discardTranscript(runId: string, dir: string = defaultDir()): void {
  try {
    fs.rmSync(transcriptPath(runId, dir), { force: true });
  } catch (err) {
    console.error(`[transcripts] Failed to discard the transcript of run ${runId}:`, err);
  }
}

/**
 * Which stored transcripts no longer belong to anything — the pure half of the
 * boot-time sweep below.
 *
 * A transcript belongs to its run and is kept for as long as that run might
 * still resume. `liveRunIds` is therefore every non-terminal run: a run still
 * `rate_limited` is waiting to use it, and one already resumed keeps it too,
 * since the resumed pass may pause again and an orchestrator restart in
 * between must not strand it. Anything else — a merged, failed, exhausted or
 * cancelled run, or an id with no run row at all — is finished with its
 * conversation.
 */
export function staleTranscriptFiles(
  fileNames: readonly string[],
  liveRunIds: ReadonlySet<string>
): string[] {
  return fileNames
    .filter((name) => name.endsWith(".jsonl"))
    .filter((name) => !liveRunIds.has(name.slice(0, -".jsonl".length)));
}

/**
 * Drop the transcripts of runs that are over.
 *
 * Run at boot rather than on every terminal path: a run reaches a terminal
 * status from a dozen places (merged, failed, exhausted, interrupted,
 * cancelled, escalated), and a cleanup hook on each would be one edit away
 * from a leak. One sweep of a directory that holds a handful of small files
 * costs nothing and cannot miss a path it never knew about — and the process
 * is restarted by every deploy, so it runs often enough.
 */
export function pruneTranscripts(
  liveRunIds: ReadonlySet<string>,
  dir: string = defaultDir()
): number {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    // No directory yet is the normal state on an install that has never paused.
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.error("[transcripts] Failed to list stored transcripts:", err);
    }
    return 0;
  }

  const stale = staleTranscriptFiles(names, liveRunIds);
  for (const name of stale) {
    try {
      fs.rmSync(path.join(dir, name), { force: true });
    } catch (err) {
      console.error(`[transcripts] Failed to prune ${name}:`, err);
    }
  }
  return stale.length;
}
