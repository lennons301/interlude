import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const HASH_LABEL = "co.interlude.agent-dockerfile-sha256";

// The hash the real Dockerfile.agent on disk should produce — computed exactly
// the way the module under test does, so the "fresh" cases carry a genuinely
// matching label rather than a hard-coded string that could drift.
const realHash = createHash("sha256")
  .update(readFileSync(path.join(process.cwd(), "Dockerfile.agent")))
  .digest("hex");

// Mutable fake Docker, reconfigured per test via `state.inspect`.
const { state, buildImageSpy } = vi.hoisted(() => ({
  state: {
    inspect: async (): Promise<unknown> => ({ Config: { Labels: {} } }),
  },
  buildImageSpy: vi.fn(async (): Promise<unknown> => "BUILD_STREAM"),
}));

vi.mock("@/lib/docker/client", () => ({
  getDocker: () => ({
    getImage: () => ({ inspect: () => state.inspect() }),
    buildImage: buildImageSpy,
    modem: {
      followProgress: (_stream: unknown, onFinished: (err: unknown) => void) =>
        onFinished(null),
    },
  }),
}));

// Keep the build hermetic: no real tar stream off the filesystem. The Dockerfile
// is still read for real by node:fs/promises, which is what yields realHash.
vi.mock("tar-fs", () => ({ pack: () => "TAR_STREAM" }));

import { ensureImage, buildImage, imageExists } from "../image-builder";

const missing = async (): Promise<never> => {
  throw new Error("no such image: interlude-agent:latest");
};

beforeEach(() => {
  buildImageSpy.mockClear();
  state.inspect = async () => ({ Config: { Labels: {} } });
});

describe("ensureImage", () => {
  it("builds when the image is missing", async () => {
    state.inspect = missing;
    await ensureImage();
    expect(buildImageSpy).toHaveBeenCalledTimes(1);
  });

  it("rebuilds when the stamped Dockerfile hash no longer matches (issue #78)", async () => {
    state.inspect = async () => ({ Config: { Labels: { [HASH_LABEL]: "stale" } } });
    await ensureImage();
    expect(buildImageSpy).toHaveBeenCalledTimes(1);
  });

  it("skips the build when the stamped hash matches the on-disk Dockerfile", async () => {
    state.inspect = async () => ({ Config: { Labels: { [HASH_LABEL]: realHash } } });
    await ensureImage();
    expect(buildImageSpy).not.toHaveBeenCalled();
  });

  it("rebuilds an existing but unstamped image (manual/old build)", async () => {
    state.inspect = async () => ({ Config: { Labels: null } });
    await ensureImage();
    expect(buildImageSpy).toHaveBeenCalledTimes(1);
  });
});

describe("buildImage", () => {
  it("stamps the current Dockerfile hash as a label on interlude-agent:latest", async () => {
    await buildImage();
    expect(buildImageSpy).toHaveBeenCalledTimes(1);
    // `.mock.calls` carries no argument types for a no-arg fake, so reach the
    // build options through `unknown`.
    const [, opts] = buildImageSpy.mock.calls[0] as unknown as [
      unknown,
      { t: string; dockerfile: string; labels: Record<string, string> },
    ];
    expect(opts.t).toBe("interlude-agent:latest");
    expect(opts.dockerfile).toBe("Dockerfile.agent");
    expect(opts.labels[HASH_LABEL]).toBe(realHash);
  });
});

describe("imageExists", () => {
  it("is true when the image inspects and false when it does not", async () => {
    state.inspect = async () => ({ Config: { Labels: {} } });
    expect(await imageExists()).toBe(true);
    state.inspect = missing;
    expect(await imageExists()).toBe(false);
  });
});
