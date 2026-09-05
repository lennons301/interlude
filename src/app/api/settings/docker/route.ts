import { NextResponse } from "next/server";
import { isDockerAvailable } from "@/lib/docker/client";
import { readHarnessImageStates } from "@/lib/harness/image-state";
import { registeredHarnessAdapterIds } from "@/lib/harness/registry";

/**
 * The environment readout's data (issue #119): whether the daemon answers, and
 * whether each registered harness adapter's agent image is built (issue #216
 * — one image per adapter, so one row per adapter). The probes are the same
 * bounded ones the execution-lane screen makes (issue #219), so the two panels
 * cannot disagree about an image, and a daemon that does not answer leaves
 * every image *unknown* — never "not built" — by that probe's own rule.
 */
export async function GET() {
  const [docker, images] = await Promise.all([
    isDockerAvailable(),
    readHarnessImageStates(registeredHarnessAdapterIds()),
  ]);
  return NextResponse.json({ docker, images });
}
