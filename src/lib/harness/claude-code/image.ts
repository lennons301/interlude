/**
 * The agent image Claude Code turns run in (issues #214, #216) — declared by
 * the adapter, read by the image builder and handed to container creation, so
 * "which image does this harness run?" has one answer.
 *
 * A leaf module rather than a field read off the adapter object, because the
 * image builder is Docker-side code with no business importing the stream
 * parser (and through it the database) that the adapter object carries.
 *
 * The Dockerfile is this adapter's *layer* on the shared base
 * (`Dockerfile.agent-base`): it installs the Claude CLI and pre-accepts its
 * headless mode, and nothing else — everything a container needs that is not
 * the harness is the base's. The image builder stamps the built image with a
 * hash over both files, so a base change rebuilds this image and a change to
 * this layer rebuilds only it.
 */

import type { HarnessImage } from "../adapter";

export const CLAUDE_CODE_IMAGE: HarnessImage = {
  name: "interlude-agent-claude-code:latest",
  dockerfile: "Dockerfile.agent-claude-code",
};
