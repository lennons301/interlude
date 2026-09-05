/**
 * The agent image Claude Code turns run in (issue #214) — declared by the
 * adapter, read by the image builder, so "which image does this harness run?"
 * has one answer.
 *
 * A leaf module rather than a field read off the adapter object, because the
 * image builder is Docker-side code with no business importing the stream
 * parser (and through it the database) that the adapter object carries. One
 * image per adapter, from a shared base, is issue #216's; until then this is
 * the one image the fleet has always built.
 */

import type { HarnessImage } from "../adapter";

export const CLAUDE_CODE_IMAGE: HarnessImage = {
  name: "interlude-agent:latest",
  dockerfile: "Dockerfile.agent",
};
