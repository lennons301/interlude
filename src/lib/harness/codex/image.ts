/**
 * The agent image Codex turns run in (issues #216, #221) — declared by the
 * adapter, read by the image builder and handed to container creation, so
 * "which image does this harness run?" has one answer.
 *
 * A leaf module for the reason `claude-code/image.ts` is one: the image
 * builder is Docker-side code with no business importing the stream parser
 * (and through it the database) that the adapter object carries.
 *
 * The Dockerfile is this adapter's *layer* on the shared base
 * (`Dockerfile.agent-base`): it installs the Codex CLI and creates the
 * persistent sessions directory every per-exec Codex home links to (see the
 * turn script in `./index.ts`), and nothing else — everything a container
 * needs that is not the harness is the base's. The image builder stamps the
 * built image with a hash over both files, so a base change rebuilds this
 * image and a change to this layer rebuilds only it.
 */

import type { HarnessImage } from "../adapter";

export const CODEX_IMAGE: HarnessImage = {
  name: "interlude-agent-codex:latest",
  dockerfile: "Dockerfile.agent-codex",
};
