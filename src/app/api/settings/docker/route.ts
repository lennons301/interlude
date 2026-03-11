import { NextResponse } from "next/server";
import { isDockerAvailable } from "@/lib/docker/client";
import { imageExists, getImageName } from "@/lib/docker/image-builder";

export async function GET() {
  const dockerUp = await isDockerAvailable();

  let imageReady = false;
  if (dockerUp) {
    imageReady = await imageExists();
  }

  return NextResponse.json({
    docker: dockerUp,
    image: imageReady,
    imageName: getImageName(),
  });
}
