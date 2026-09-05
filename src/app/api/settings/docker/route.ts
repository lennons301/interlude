import { NextResponse } from "next/server";
import { isDockerAvailable } from "@/lib/docker/client";
import { readHarnessImageStates, type HarnessImageState } from "@/lib/harness/image-state";
import { getHarnessAdapter, registeredHarnessAdapterIds } from "@/lib/harness/registry";

/**
 * The environment readout's data (issue #119): whether the daemon answers, and
 * whether each registered harness adapter's agent image is built (issue #216
 * — one image per adapter, so one row per adapter). The probes are the same
 * bounded ones the execution-lane screen makes (issue #219), so the two panels
 * cannot disagree about an image; with the daemon down nothing is probed and
 * every image reads *unknown*, never "not built".
 */
export async function GET() {
  const dockerUp = await isDockerAvailable();
  const adapterIds = registeredHarnessAdapterIds();

  const images: HarnessImageState[] = dockerUp
    ? await readHarnessImageStates(adapterIds)
    : adapterIds.map((id) => ({ id, image: getHarnessAdapter(id).image.name, built: null }));

  return NextResponse.json({ docker: dockerUp, images });
}
