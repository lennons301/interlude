import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type Docker from "dockerode";
import { pack } from "tar-fs";
import { getDocker } from "./client";
import { CLAUDE_CODE_IMAGE } from "../harness/claude-code/image";

// The image and the Dockerfile are the adapter's declaration (issue #214), read
// off its leaf rather than restated here, so the container that runs a Claude
// Code turn and the image this module builds cannot name different things.
// One image per adapter, keyed by adapter, is issue #216's.
const DOCKERFILE = CLAUDE_CODE_IMAGE.dockerfile;

// The image is stamped with the SHA-256 of the Dockerfile.agent it was built
// from. ensureImage rebuilds when the on-disk Dockerfile no longer matches,
// instead of trusting that `interlude-agent:latest` merely existing means it is
// current — the existence-only check let merged Dockerfile changes (jq/yq in
// #71) silently never reach running agents (issue #78).
const DOCKERFILE_HASH_LABEL = "co.interlude.agent-dockerfile-sha256";

// The ref of the estate's skills (`mattpocock/skills`) pinned into the image at
// build (issue #215). Stamped by the Dockerfile's own LABEL from its SKILLS_REF
// build arg — one statement of the ref, so a manual `docker build` stamps it
// too — and reported by `ensureImage` off the inspect it already makes, for the
// run ledger's skills-version column and the task feed. The pass reports
// nothing: before this the setup script installed the skills and echoed the
// resolved version behind a marker, and a lost marker left the trail blank.
export const SKILLS_REF_LABEL = "co.interlude.agent-skills-ref";

export function getImageName(): string {
  return CLAUDE_CODE_IMAGE.name;
}

/** SHA-256 of the Dockerfile.agent currently on disk (the build context). */
async function dockerfileHash(): Promise<string> {
  const contents = await readFile(path.join(process.cwd(), DOCKERFILE));
  return createHash("sha256").update(contents).digest("hex");
}

/** Inspect the agent image, or null if it does not exist. */
async function inspectImage(): Promise<Docker.ImageInspectInfo | null> {
  try {
    return await getDocker().getImage(getImageName()).inspect();
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

export async function imageExists(): Promise<boolean> {
  return (await inspectImage()) !== null;
}

/**
 * Whether the image an adapter names is built, as a *probe* (issue #219):
 * true when the daemon holds it, false on a positive 404, and a throw on
 * anything else — so a caller racing it against a bound can tell "not built"
 * from "the daemon did not answer". `imageExists` above folds every failure
 * into false, which is right for the builder (it rebuilds either way) and
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
   * if the Dockerfile stopped stamping the label: an image the hash calls
   * current was built from this Dockerfile, and this Dockerfile stamps it.
   */
  skillsRef: string | null;
}

export async function buildImage(
  onProgress?: (message: string) => void
): Promise<void> {
  const docker = getDocker();
  const hash = await dockerfileHash();

  const tarStream = pack(process.cwd(), {
    entries: [DOCKERFILE],
  });

  const stream = await docker.buildImage(tarStream, {
    t: getImageName(),
    dockerfile: DOCKERFILE,
    // Stamp the source hash so ensureImage can detect a stale image later.
    labels: { [DOCKERFILE_HASH_LABEL]: hash },
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
 * Build the agent image if it is missing or stale, and report what is stamped
 * on the image that results. Stale = the running `interlude-agent:latest` was
 * built from a different Dockerfile.agent than the one on disk (issue #78).
 * Docker's layer cache makes an unchanged rebuild cheap; a genuine Dockerfile
 * change — a bumped `SKILLS_REF` included, since the hash covers the whole
 * file — rebuilds so agents pick it up.
 *
 * A current image is inspected once, for both the hash and the skills ref
 * (issue #215); only a rebuild inspects again, for the image it just built.
 */
export async function ensureImage(
  onProgress?: (message: string) => void
): Promise<EnsuredImage> {
  const [current, info] = await Promise.all([dockerfileHash(), inspectImage()]);
  if (imageLabel(info, DOCKERFILE_HASH_LABEL) === current) {
    return { skillsRef: imageLabel(info, SKILLS_REF_LABEL) };
  }
  await buildImage(onProgress);
  return { skillsRef: imageLabel(await inspectImage(), SKILLS_REF_LABEL) };
}
