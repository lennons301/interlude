import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  containerTranscriptDir,
  containerTranscriptPath,
  discardTranscript,
  hasTranscript,
  pruneTranscripts,
  readTranscript,
  resolveTranscriptDir,
  saveTranscript,
  staleTranscriptFiles,
  transcriptPath,
} from "../session-transcript";

/**
 * The store that carries a paused pass's conversation across the teardown of
 * its container (issue #169). The Docker half is exercised against a live
 * daemon, not here; what these check is everything that decides *where* the
 * file goes and *whether* it is still wanted — the parts a wrong answer in
 * would silently lose a run's context.
 */

describe("the container-side path", () => {
  it("mangles the working directory the way the harness does", () => {
    // Measured on the #165 spike: Claude Code replaces each separator with a
    // dash, so /workspace/repo becomes -workspace-repo.
    expect(containerTranscriptDir("/workspace/repo")).toBe(
      "/home/node/.claude/projects/-workspace-repo"
    );
  });

  it("names the file after the session, under the agent's own home", () => {
    expect(containerTranscriptPath("abc-123")).toBe(
      "/home/node/.claude/projects/-workspace-repo/abc-123.jsonl"
    );
  });
});

describe("the host-side path", () => {
  it("follows DATABASE_URL, so it inherits the durable volume", () => {
    expect(resolveTranscriptDir("/data/interlude.db")).toBe("/data/session-transcripts");
  });

  it("falls back to the local dev database's directory", () => {
    expect(resolveTranscriptDir(undefined)).toBe("session-transcripts");
  });

  it("refuses an id that would escape the store", () => {
    // The id comes from a database row rather than a literal, and this joins
    // it onto a directory.
    expect(() => transcriptPath("../../etc/passwd", "/data/session-transcripts")).toThrow();
  });
});

describe("keeping and forgetting a run's transcript", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "interlude-transcripts-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips the bytes verbatim", () => {
    const transcript = '{"type":"user"}\n{"type":"assistant","text":"café — done"}\n';

    expect(saveTranscript("run-1", transcript, dir)).toBe(true);
    expect(readTranscript("run-1", dir)?.toString("utf8")).toBe(transcript);
  });

  it("creates the store on first use", () => {
    const fresh = path.join(dir, "never-used");

    expect(saveTranscript("run-1", "x", fresh)).toBe(true);
    expect(hasTranscript("run-1", fresh)).toBe(true);
  });

  it("lets a second pause supersede the first", () => {
    // Resume appends to the same session file, so the later copy contains the
    // earlier one — overwriting is the whole story, not a lost half of it.
    saveTranscript("run-1", "first\n", dir);
    saveTranscript("run-1", "first\nsecond\n", dir);

    expect(readTranscript("run-1", dir)?.toString("utf8")).toBe("first\nsecond\n");
  });

  it("reports a missing transcript rather than throwing", () => {
    expect(readTranscript("never-paused", dir)).toBeNull();
    expect(hasTranscript("never-paused", dir)).toBe(false);
  });

  it("treats discarding a transcript that is already gone as success", () => {
    expect(() => discardTranscript("never-paused", dir)).not.toThrow();
  });
});

describe("which transcripts are stale", () => {
  it("keeps every live run's and drops the rest", () => {
    const stale = staleTranscriptFiles(
      ["paused.jsonl", "resumed.jsonl", "merged.jsonl", "no-such-run.jsonl"],
      new Set(["paused", "resumed"])
    );

    // A run that has already resumed keeps its transcript: it may pause again,
    // and a restart in between must not strand it.
    expect(stale).toEqual(["merged.jsonl", "no-such-run.jsonl"]);
  });

  it("ignores anything that is not a transcript", () => {
    expect(staleTranscriptFiles(["README", "notes.txt"], new Set())).toEqual([]);
  });

  it("prunes what it names, and only that", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "interlude-transcripts-"));
    saveTranscript("live", "a", dir);
    saveTranscript("over", "b", dir);

    expect(pruneTranscripts(new Set(["live"]), dir)).toBe(1);
    expect(hasTranscript("live", dir)).toBe(true);
    expect(hasTranscript("over", dir)).toBe(false);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("has nothing to do on an install that has never paused", () => {
    expect(pruneTranscripts(new Set(), path.join(os.tmpdir(), "interlude-no-such-dir"))).toBe(0);
  });
});
