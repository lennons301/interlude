import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type Docker from "dockerode";
import { pack } from "tar-fs";
import { getDocker } from "./client";
import type { HarnessImage } from "../harness/adapter";

/**
 * One agent image per harness adapter, built from a shared base (issue #216).
 *
 * The base (`Dockerfile.agent-base`) carries everything an agent container
 * needs that is not the harness — git, gh, yq, jq, pnpm, the workspace user and
 * the pinned skills — and each adapter's image is a thin layer on it
 * (`Dockerfile.agent-<adapter id>`) that installs one harness and pre-accepts
 * its headless mode. Which image an adapter's containers run is the adapter's
 * declaration (`HarnessAdapter.image`, issue #214); this module is handed that
 * declaration and knows nothing about which adapters exist, so it can be read
 * on the app-router graph (the settings screen's image probe) without pulling
 * the adapter registry — and the stream parser and database behind it — along.
 *
 * Staleness is a hash stamped on the image (issue #78 — an existence-only check
 * let merged Dockerfile changes silently never reach running agents). The base
 * is stamped with its own file's SHA-256; an adapter image is stamped with a
 * hash over **both** files (`imageStamp`), which is what makes a base change
 * rebuild every adapter's image and a harness bump in one layer rebuild only
 * that image. The base is a real image the layers `FROM`, rather than text
 * concatenated per adapter at build time, so the base's layers are shared
 * across adapters in the daemon's cache instead of repeated per image.
 */

/**
 * The shared base every adapter image is built on. The tag is handed to each
 * layer build as its `BASE_IMAGE` build arg — the layer file's default is the
 * same tag, pinned by a test, so a manual `docker build` after a base build
 * works too.
 */
export const AGENT_BASE_IMAGE: HarnessImage = {
  name: "interlude-agent-base:latest",
  dockerfile: "Dockerfile.agent-base",
};

/** The build arg an adapter layer takes its base from (`FROM ${BASE_IMAGE}`). */
export const BASE_IMAGE_BUILD_ARG = "BASE_IMAGE";

// The label carrying the SHA-256 of the Dockerfile source an image was built
// from: the base file alone on the base image, both files on an adapter image
// (see `imageStamp`). `ensureImage` rebuilds when the stamp no longer matches
// what is on disk, instead of trusting that a tag merely existing means it is
// current.
export const DOCKERFILE_HASH_LABEL = "co.interlude.agent-dockerfile-sha256";

// The ref of the estate's skills (`mattpocock/skills`) pinned into the image at
// build (issue #215). Stamped by the base Dockerfile's own LABEL from its
// SKILLS_REF build arg — one statement of the ref, so a manual `docker build`
// stamps it too — and inherited by every adapter image built on the base, which
// is where `ensureImage` reads it, off the inspect it already makes, for the
// run ledger's skills-version column and the task feed. The pass reports
// nothing: before this the setup script installed the skills and echoed the
// resolved version behind a marker, and a lost marker left the trail blank.
export const SKILLS_REF_LABEL = "co.interlude.agent-skills-ref";

/** SHA-256 of a Dockerfile currently on disk, by its repo-root-relative path. */
async function dockerfileHash(dockerfile: string): Promise<string> {
  const contents = await readFile(path.join(process.cwd(), dockerfile));
  return createHash("sha256").update(contents).digest("hex");
}

/**
 * The stamp an adapter image built from these two sources carries: a hash over
 * the base file's hash and the layer's. Exported so a test can say what
 * "current" means without restating the formula; the two hashes are the
 * inputs rather than the files so the stamp changes when either does and for
 * no other reason.
 */
export function imageStamp(baseHash: string, layerHash: string): string {
  return createHash("sha256").update(`${baseHash}\n${layerHash}`).digest("hex");
}

/** Inspect an image by reference, or null if it does not exist. */
async function inspectImage(name: string): Promise<Docker.ImageInspectInfo | null> {
  try {
    return await getDocker().getImage(name).inspect();
  } catch {
    return null;
  }
}

/**
 * One label off an inspected image, or null when the image is absent or does
 * not carry it. For the hash label, null means "not known to be current" —
 * built before the label existed, or by a manual `docker build` — and so a
 * rebuild.
 */
function imageLabel(info: Docker.ImageInspectInfo | null, label: string): string | null {
  return info?.Config?.Labels?.[label] ?? null;
}

/**
 * Whether the image an adapter names is built, as a *probe* (issue #219):
 * true when the daemon holds it, false on a positive 404, and a throw on
 * anything else — so a caller racing it against a bound can tell "not built"
 * from "the daemon did not answer". `inspectImage` above folds every failure
 * into null, which is right for the builder (it rebuilds either way) and
 * wrong for the settings screen, where an unreachable daemon must read as
 * unknown rather than as a verdict.
 */
export async function probeImageBuilt(name: string): Promise<boolean> {
  try {
    await getDocker().getImage(name).inspect();
    return true;
  } catch (err) {
    if ((err as { statusCode?: number })?.statusCode === 404) return false;
    throw err;
  }
}

/** What `ensureImage` reports about the image it leaves in place. */
export interface EnsuredImage {
  /**
   * The skills ref stamped on the image (issue #215), read off the same inspect
   * the staleness check made rather than a second daemon round trip. Null only
   * if the base Dockerfile stopped stamping the label: an image the stamp calls
   * current was built on a base built from that file, and that file stamps it.
   */
  skillsRef: string | null;
}

/**
 * Run one `docker build` of `image` from its Dockerfile at the repo root, with
 * the Dockerfile as the whole build context (nothing else is ever copied in),
 * and the given labels and build args stamped on the result.
 */
async function runBuild(
  image: HarnessImage,
  options: { labels: Record<string, string>; buildargs?: Record<string, string> },
  onProgress?: (message: string) => void
): Promise<void> {
  const docker = getDocker();
  const tarStream = pack(process.cwd(), { entries: [image.dockerfile] });

  const stream = await docker.buildImage(tarStream, {
    t: image.name,
    dockerfile: image.dockerfile,
    labels: options.labels,
    ...(options.buildargs ? { buildargs: options.buildargs } : {}),
  });

  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(
      stream,
      (err) => (err ? reject(err) : resolve()),
      (event) => {
        if (event.stream && onProgress) {
          onProgress(event.stream.trim());
        }
      }
    );
  });
}

/**
 * Build the base image if it is missing or was built from a different base
 * Dockerfile than the one on disk. Called only on the way to building an
 * adapter image: a current adapter image needs no base at all (its layers are
 * its own once built), so the base is never inspected on the warm path.
 */
async function ensureBaseImage(
  baseHash: string,
  onProgress?: (message: string) => void
): Promise<void> {
  const info = await inspectImage(AGENT_BASE_IMAGE.name);
  if (imageLabel(info, DOCKERFILE_HASH_LABEL) === baseHash) return;
  await runBuild(AGENT_BASE_IMAGE, { labels: { [DOCKERFILE_HASH_LABEL]: baseHash } }, onProgress);
}

/**
 * Build an adapter's agent image if it is missing or stale, and report what is
 * stamped on the image that results. Stale = the image was built from a
 * different base Dockerfile *or* a different adapter layer than the two on
 * disk (issue #78's check, over both files since #216). Docker's layer cache
 * makes an unchanged rebuild cheap; a genuine change — a bumped `SKILLS_REF`
 * in the base included, since the stamp covers the whole of both files —
 * rebuilds so agents pick it up. The base is brought current first when a
 * rebuild is needed, so two adapters stale on one base change share one base
 * build: the first rebuilds it, the second finds it current.
 *
 * A current image is inspected once, for both the stamp and the skills ref
 * (issue #215); only a rebuild inspects again, for the image it just built.
 */
export async function ensureImage(
  image: HarnessImage,
  onProgress?: (message: string) => void
): Promise<EnsuredImage> {
  const [baseHash, layerHash, info] = await Promise.all([
    dockerfileHash(AGENT_BASE_IMAGE.dockerfile),
    dockerfileHash(image.dockerfile),
    inspectImage(image.name),
  ]);
  const stamp = imageStamp(baseHash, layerHash);
  if (imageLabel(info, DOCKERFILE_HASH_LABEL) === stamp) {
    return { skillsRef: imageLabel(info, SKILLS_REF_LABEL) };
  }

  await ensureBaseImage(baseHash, onProgress);
  await runBuild(
    image,
    {
      labels: { [DOCKERFILE_HASH_LABEL]: stamp },
      buildargs: { [BASE_IMAGE_BUILD_ARG]: AGENT_BASE_IMAGE.name },
    },
    onProgress
  );
  return { skillsRef: imageLabel(await inspectImage(image.name), SKILLS_REF_LABEL) };
}
