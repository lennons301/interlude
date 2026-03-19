import { pack } from "tar-fs";
import { getDocker } from "./client";

const IMAGE_NAME = "interlude-agent";
const IMAGE_TAG = "latest";

export function getImageName(): string {
  return `${IMAGE_NAME}:${IMAGE_TAG}`;
}

export async function imageExists(): Promise<boolean> {
  const docker = getDocker();
  try {
    await docker.getImage(getImageName()).inspect();
    return true;
  } catch {
    return false;
  }
}

export async function buildImage(
  onProgress?: (message: string) => void
): Promise<void> {
  const docker = getDocker();

  const tarStream = pack(process.cwd(), {
    entries: ["Dockerfile.agent"],
  });

  const stream = await docker.buildImage(tarStream, {
    t: getImageName(),
    dockerfile: "Dockerfile.agent",
    // Note: to pick up Dockerfile.agent changes, delete the image first:
    // docker rmi interlude-agent:latest
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

export async function ensureImage(
  onProgress?: (message: string) => void
): Promise<void> {
  if (await imageExists()) return;
  await buildImage(onProgress);
}
