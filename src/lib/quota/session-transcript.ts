/**
 * The paused pass's conversation, kept outside the container it was living in
 * (issues #169, #217).
 *
 * A quota pause tears its container down — a parked one holds ~2 GiB while
 * holding no slot, and a five-hour window is far too long to hold one for
 * (#168) — so everything the pass had built would go with it unless something
 * copies it out first. What "it" is belongs to the **harness adapter**: an
 * adapter names the container paths that hold a session's replayable state
 * (`sessionArtifactPaths` on the contract), a pause copies exactly those out,
 * and a resume copies them back. Nothing in this module names a vendor path
 * (issue #217); before that ticket it hardcoded one harness's transcript
 * location, which was fine while every lane ran that one adapter and wrong the
 * moment a second one could.
 *
 * What a *transcript* is here, then, is the set of artefacts an adapter named
 * for one session, kept verbatim, plus a small manifest saying which adapter
 * wrote them, which session they belong to and where each one came from. The
 * manifest is what lets a restore put every file back where it was read from
 * rather than re-deriving the paths, and what lets it refuse to hand one
 * harness's artefacts to another. For the first adapter the set is one file —
 * the #165 spike measured it: the JSONL transcript its harness finds by session
 * id on resume, which a pass killed mid-tool-call resumes from knowing how
 * far it got, and which a resume *appends* to, so pausing repeatedly grows one
 * artefact rather than a chain to reassemble.
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
 * Whether a stored transcript may be carried onto the lane a pass resumes on
 * is not this module's question. It is decided where both ends are known —
 * `restoreSessionTranscript` in the turn manager, through the pure
 * `decideSessionCarry` (`src/lib/harness/session-carry.ts`): the same adapter
 * on both sides restores, a different one starts again on the branch.
 */

import fs from "fs";
import path from "path";

/** One artefact of a session: where it lived in the container, and its bytes. */
export interface SessionArtifact {
  /** The container path the adapter named — read from here, written back here. */
  path: string;
  contents: Buffer;
}

/** A session's replayable state, as the store keeps it. */
export interface StoredTranscript {
  /** The adapter whose artefacts these are — the one that named the paths. */
  adapter: string;
  /** The session the artefacts belong to, as the harness identifies it. */
  sessionId: string;
  /** In the order the adapter named them. */
  artefacts: SessionArtifact[];
}

/** The manifest's on-disk shape: the artefact bytes live in files beside it. */
interface Manifest {
  version: 1;
  adapter: string;
  sessionId: string;
  /** Container path per artefact, index-aligned with the artefact files. */
  paths: string[];
}

const MANIFEST_FILE = "manifest.json";

/** The file the artefact at `index` is kept in, inside a run's directory. */
function artefactFileName(index: number): string {
  return `artefact-${index}`;
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
 * The shape of a run id as the store will accept it. A ULID matches; so does
 * anything without a separator or a dot, which is the point — an id arrives
 * here from a database row rather than a literal, and the store joins it onto
 * a directory, so a value carrying `..` or `/` would escape it.
 */
const RUN_ID_SHAPE = /^[A-Za-z0-9_-]+$/;

/** The suffix of a run's directory while it is being written — see
 * `saveTranscript`. */
const IN_PROGRESS_SUFFIX = ".tmp";

/** A run's directory in the store. Refuses an id that would escape it. */
export function transcriptDir(runId: string, dir: string): string {
  if (!RUN_ID_SHAPE.test(runId)) {
    throw new Error(`Refusing to build a transcript path for id "${runId}"`);
  }
  return path.join(dir, runId);
}

function defaultDir(): string {
  return resolveTranscriptDir(process.env.DATABASE_URL);
}

/**
 * The largest transcript worth keeping — summed over a session's artefacts —
 * and the reason there is a limit at all: this store shares the `/data` volume
 * with the SQLite database, exactly as the stream recorder's log does, so it
 * may not grow without a ceiling.
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
 * prior context lost), and the run should say so rather than resume against a
 * session the container does not have.
 *
 * Written **beside** the run's directory first and moved into place last, so
 * the earlier transcript stands until the new one is whole: a second pause
 * whose copy fails part-way (a full disk) must not leave the run with neither.
 * The manifest is the last file written, and `hasTranscript` reads its
 * presence, so nothing half-written is ever read as a transcript — the same
 * all-or-nothing rule the size ceiling applies.
 */
export function saveTranscript(
  runId: string,
  transcript: StoredTranscript,
  dir: string = defaultDir()
): boolean {
  if (transcript.artefacts.length === 0) {
    console.warn(`[transcripts] Not keeping run ${runId}'s transcript: it has no artefacts`);
    return false;
  }
  const size = transcript.artefacts.reduce((sum, a) => sum + a.contents.byteLength, 0);
  if (size > MAX_TRANSCRIPT_BYTES) {
    console.warn(
      `[transcripts] Not keeping run ${runId}'s transcript: ${size} bytes is ` +
        `past the ${MAX_TRANSCRIPT_BYTES}-byte ceiling`
    );
    return false;
  }
  const runDir = transcriptDir(runId, dir);
  const inProgress = runDir + IN_PROGRESS_SUFFIX;
  try {
    fs.rmSync(inProgress, { recursive: true, force: true });
    fs.mkdirSync(inProgress, { recursive: true });
    transcript.artefacts.forEach((artefact, index) => {
      fs.writeFileSync(path.join(inProgress, artefactFileName(index)), artefact.contents);
    });
    const manifest: Manifest = {
      version: 1,
      adapter: transcript.adapter,
      sessionId: transcript.sessionId,
      paths: transcript.artefacts.map((a) => a.path),
    };
    fs.writeFileSync(path.join(inProgress, MANIFEST_FILE), JSON.stringify(manifest));
    // Only now is the earlier transcript given up — the new one is whole.
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.renameSync(inProgress, runDir);
    return true;
  } catch (err) {
    fs.rmSync(inProgress, { recursive: true, force: true });
    console.error(`[transcripts] Failed to save the transcript of run ${runId}:`, err);
    return false;
  }
}

/** A saved transcript, or null when the run has none (or what it has does not
 * read as one — a manifest naming a file that is missing is no transcript). */
export function readTranscript(
  runId: string,
  dir: string = defaultDir()
): StoredTranscript | null {
  const runDir = transcriptDir(runId, dir);
  let manifest: Manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(runDir, MANIFEST_FILE), "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.error(`[transcripts] Failed to read the transcript of run ${runId}:`, err);
    }
    return null;
  }
  if (
    manifest?.version !== 1 ||
    typeof manifest.adapter !== "string" ||
    typeof manifest.sessionId !== "string" ||
    !Array.isArray(manifest.paths)
  ) {
    console.error(`[transcripts] Run ${runId}'s transcript manifest is malformed`);
    return null;
  }
  try {
    return {
      adapter: manifest.adapter,
      sessionId: manifest.sessionId,
      artefacts: manifest.paths.map((artefactPath, index) => ({
        path: artefactPath,
        contents: fs.readFileSync(path.join(runDir, artefactFileName(index))),
      })),
    };
  } catch (err) {
    console.error(`[transcripts] Failed to read the transcript of run ${runId}:`, err);
    return null;
  }
}

/** Whether a run has a saved transcript — asked before a resume is queued, so
 * the pass is framed as a continuation or as a fresh start on the same branch
 * rather than discovering which it is halfway through. */
export function hasTranscript(runId: string, dir: string = defaultDir()): boolean {
  return fs.existsSync(path.join(transcriptDir(runId, dir), MANIFEST_FILE));
}

/** Forget a run's transcript. Missing is success: the caller's intent is that
 * it be gone. */
export function discardTranscript(runId: string, dir: string = defaultDir()): void {
  try {
    fs.rmSync(transcriptDir(runId, dir), { recursive: true, force: true });
  } catch (err) {
    console.error(`[transcripts] Failed to discard the transcript of run ${runId}:`, err);
  }
}

/** One entry of the store's directory, as `pruneTranscripts` sees it. */
export interface StoreEntry {
  name: string;
  isDirectory: boolean;
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
 *
 * A transcript is a directory named for its run, and only a directory whose
 * name has a run id's shape is the store's to remove — a save that was
 * interrupted leaves its in-progress directory behind, and that is stale too.
 * A `.jsonl` *file* is the store's pre-#217 shape (one transcript file per
 * run, named for it), which nothing reads any more, so it is stale whatever
 * run it names. Anything else is not the store's and is left alone.
 */
export function staleTranscriptEntries(
  entries: readonly StoreEntry[],
  liveRunIds: ReadonlySet<string>
): string[] {
  return entries
    .filter((entry) => {
      if (!entry.isDirectory) return entry.name.endsWith(".jsonl");
      if (entry.name.endsWith(IN_PROGRESS_SUFFIX)) {
        return RUN_ID_SHAPE.test(entry.name.slice(0, -IN_PROGRESS_SUFFIX.length));
      }
      return RUN_ID_SHAPE.test(entry.name) && !liveRunIds.has(entry.name);
    })
    .map((entry) => entry.name);
}

/**
 * Drop the transcripts of runs that are over.
 *
 * Run at boot rather than on every terminal path: a run reaches a terminal
 * status from a dozen places (merged, failed, exhausted, interrupted,
 * cancelled, escalated), and a cleanup hook on each would be one edit away
 * from a leak. One sweep of a directory that holds a handful of small entries
 * costs nothing and cannot miss a path it never knew about — and the process
 * is restarted by every deploy, so it runs often enough.
 */
export function pruneTranscripts(
  liveRunIds: ReadonlySet<string>,
  dir: string = defaultDir()
): number {
  let entries: StoreEntry[];
  try {
    entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }));
  } catch (err) {
    // No directory yet is the normal state on an install that has never paused.
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.error("[transcripts] Failed to list stored transcripts:", err);
    }
    return 0;
  }

  const stale = staleTranscriptEntries(entries, liveRunIds);
  for (const name of stale) {
    try {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    } catch (err) {
      console.error(`[transcripts] Failed to prune ${name}:`, err);
    }
  }
  return stale.length;
}
