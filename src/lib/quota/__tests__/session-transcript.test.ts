import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_TRANSCRIPT_BYTES,
  discardTranscript,
  hasTranscript,
  pruneTranscripts,
  readTranscript,
  resolveTranscriptDir,
  saveTranscript,
  staleTranscriptEntries,
  transcriptDir,
  type StoredTranscript,
} from "../session-transcript";

/**
 * The store that carries a paused pass's conversation across the teardown of
 * its container (issues #169, #217). The Docker half is exercised against a
 * live daemon, not here; what these check is everything that decides *where*
 * the artefacts go and *whether* they are still wanted — the parts a wrong
 * answer in would silently lose a run's context.
 *
 * Nothing here names a harness: the paths are whatever an adapter said, and
 * the store keeps them beside the bytes so a restore puts each file back where
 * it was read from.
 */

/** A session as an adapter might name it: two artefacts under two container
 * paths, with bytes that would break a naive text round trip. */
function transcript(overrides: Partial<StoredTranscript> = {}): StoredTranscript {
  return {
    adapter: "some-harness",
    sessionId: "sess-1",
    artefacts: [
      {
        path: "/home/node/.some-harness/sessions/sess-1.jsonl",
        contents: Buffer.from('{"type":"user"}\n{"type":"assistant","text":"café — done"}\n'),
      },
      {
        path: "/home/node/.some-harness/state/sess-1.bin",
        contents: Buffer.from([0, 255, 10, 13, 0]),
      },
    ],
    ...overrides,
  };
}

describe("the host-side path", () => {
  it("follows DATABASE_URL, so it inherits the durable volume", () => {
    expect(resolveTranscriptDir("/data/interlude.db")).toBe("/data/session-transcripts");
  });

  it("falls back to the local dev database's directory", () => {
    expect(resolveTranscriptDir(undefined)).toBe("session-transcripts");
  });

  it("keeps one directory per run", () => {
    expect(transcriptDir("01RUN", "/data/session-transcripts")).toBe(
      "/data/session-transcripts/01RUN"
    );
  });

  it("refuses an id that would escape the store", () => {
    // The id comes from a database row rather than a literal, and this joins
    // it onto a directory.
    expect(() => transcriptDir("../../etc/passwd", "/data/session-transcripts")).toThrow();
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

  it("round-trips every artefact verbatim, with its path, and says whose it is", () => {
    const kept = transcript();

    expect(saveTranscript("run-1", kept, dir)).toBe(true);

    const read = readTranscript("run-1", dir);
    expect(read?.adapter).toBe("some-harness");
    expect(read?.sessionId).toBe("sess-1");
    expect(read?.artefacts.map((a) => a.path)).toEqual(kept.artefacts.map((a) => a.path));
    expect(read?.artefacts.map((a) => a.contents.equals(kept.artefacts[0].contents))).toEqual([
      true,
      false,
    ]);
    expect(read?.artefacts[1].contents).toEqual(kept.artefacts[1].contents);
  });

  it("creates the store on first use", () => {
    const fresh = path.join(dir, "never-used");

    expect(saveTranscript("run-1", transcript(), fresh)).toBe(true);
    expect(hasTranscript("run-1", fresh)).toBe(true);
  });

  it("lets a second pause supersede the first, dropping artefacts it no longer names", () => {
    // Resume appends to the same session file, so the later copy contains the
    // earlier one — overwriting is the whole story, not a lost half of it.
    saveTranscript("run-1", transcript(), dir);
    saveTranscript(
      "run-1",
      transcript({
        artefacts: [{ path: "/home/node/.some-harness/sessions/sess-1.jsonl", contents: Buffer.from("first\nsecond\n") }],
      }),
      dir
    );

    const read = readTranscript("run-1", dir);
    expect(read?.artefacts).toHaveLength(1);
    expect(read?.artefacts[0].contents.toString("utf8")).toBe("first\nsecond\n");
    expect(fs.readdirSync(transcriptDir("run-1", dir)).sort()).toEqual(["artefact-0", "manifest.json"]);
  });

  it("refuses a transcript past the ceiling rather than truncating it", () => {
    // Half a transcript is not a smaller transcript — it is a conversation the
    // harness would resume into. Refusing leaves the caller with the fallback
    // it already knows how to take. The ceiling is over the whole set: two
    // artefacts each under it can still be one session over it.
    const half = Buffer.alloc(MAX_TRANSCRIPT_BYTES / 2 + 1, "x");
    const huge = transcript({
      artefacts: [
        { path: "/a", contents: half },
        { path: "/b", contents: half },
      ],
    });

    expect(saveTranscript("run-1", huge, dir)).toBe(false);
    expect(hasTranscript("run-1", dir)).toBe(false);
  });

  it("refuses a session with no artefacts — there is nothing to resume from", () => {
    expect(saveTranscript("run-1", transcript({ artefacts: [] }), dir)).toBe(false);
    expect(hasTranscript("run-1", dir)).toBe(false);
  });

  it("reports a missing transcript rather than throwing", () => {
    expect(readTranscript("never-paused", dir)).toBeNull();
    expect(hasTranscript("never-paused", dir)).toBe(false);
  });

  it("reads a manifest naming a file that is gone as no transcript", () => {
    // Half a set is refused on the way in; a set that lost a file on disk is
    // refused on the way out for the same reason.
    saveTranscript("run-1", transcript(), dir);
    fs.rmSync(path.join(transcriptDir("run-1", dir), "artefact-1"));

    expect(readTranscript("run-1", dir)).toBeNull();
  });

  it("treats discarding a transcript that is already gone as success", () => {
    expect(() => discardTranscript("never-paused", dir)).not.toThrow();
  });

  it("discards the whole set", () => {
    saveTranscript("run-1", transcript(), dir);
    discardTranscript("run-1", dir);

    expect(hasTranscript("run-1", dir)).toBe(false);
    expect(fs.existsSync(transcriptDir("run-1", dir))).toBe(false);
  });
});

describe("which transcripts are stale", () => {
  const runDir = (name: string) => ({ name, isDirectory: true });
  const file = (name: string) => ({ name, isDirectory: false });

  it("keeps every live run's and drops the rest", () => {
    const stale = staleTranscriptEntries(
      [runDir("paused"), runDir("resumed"), runDir("merged"), runDir("no-such-run")],
      new Set(["paused", "resumed"])
    );

    // A run that has already resumed keeps its transcript: it may pause again,
    // and a restart in between must not strand it.
    expect(stale).toEqual(["merged", "no-such-run"]);
  });

  it("drops the store's pre-#217 one-file transcripts, which nothing reads now", () => {
    expect(
      staleTranscriptEntries([file("paused.jsonl"), file("merged.jsonl")], new Set(["paused"]))
    ).toEqual(["paused.jsonl", "merged.jsonl"]);
  });

  it("ignores anything that is not the store's", () => {
    expect(staleTranscriptEntries([file("README"), file("notes.txt")], new Set())).toEqual([]);
  });

  it("prunes what it names, and only that", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "interlude-transcripts-"));
    saveTranscript("live", transcript(), dir);
    saveTranscript("over", transcript(), dir);
    fs.writeFileSync(path.join(dir, "legacy.jsonl"), "{}\n");
    fs.writeFileSync(path.join(dir, "README"), "not ours");

    expect(pruneTranscripts(new Set(["live"]), dir)).toBe(2);
    expect(hasTranscript("live", dir)).toBe(true);
    expect(hasTranscript("over", dir)).toBe(false);
    expect(fs.readdirSync(dir).sort()).toEqual(["README", "live"]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("has nothing to do on an install that has never paused", () => {
    expect(pruneTranscripts(new Set(), path.join(os.tmpdir(), "interlude-no-such-dir"))).toBe(0);
  });
});
