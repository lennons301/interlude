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
 * The Dockerfile hash `interlude-agent:latest` was built from, or null if the
 * image is absent or unstamped (built before this label existed, or by a manual
 * `docker build`). A null means "not known to be current" → rebuild.
 */
async function builtDockerfileHash(): Promise<string | null> {
  const info = await inspectImage();
  return info?.Config?.Labels?.[DOCKERFILE_HASH_LABEL] ?? null;
}

export async function imageExists(): Promise<boolean> {
  return (await inspectImage()) !== null;
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
 * Build the agent image if it is missing or stale. Stale = the running
 * `interlude-agent:latest` was built from a different Dockerfile.agent than the
 * one on disk (issue #78). Docker's layer cache makes an unchanged rebuild
 * cheap; a genuine Dockerfile change rebuilds so agents pick it up.
 */
export async function ensureImage(
  onProgress?: (message: string) => void
): Promise<void> {
  const [current, built] = await Promise.all([
    dockerfileHash(),
    builtDockerfileHash(),
  ]);
  if (built === current) return;
  await buildImage(onProgress);
}
