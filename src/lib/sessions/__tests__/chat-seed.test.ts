import { describe, it, expect } from "vitest";
import {
  composeChatSeed,
  DEV_SERVER_LOG,
  PREVIEW_CONTRACT,
  STANDING_INSTRUCTION,
} from "../chat-seed";

/**
 * The chat seed (issue #160, defect 4). A plain chat's first turn is pinned
 * byte-for-byte to what Phase 2b has always sent; a live-preview session's
 * adds the contract that each production failure showed was missing.
 */

describe("composeChatSeed", () => {
  it("composes a plain chat exactly as before: the prompt, then the standing instruction", () => {
    expect(composeChatSeed({ userPrompt: "Add a dark mode toggle", livePreview: false })).toBe(
      "Add a dark mode toggle\n\nWhen you are done with each request, commit all your changes " +
        "with a descriptive commit message. Stay ready for follow-up instructions."
    );
  });

  it("puts the preview contract between the prompt and the standing instruction for a live-preview session", () => {
    const seed = composeChatSeed({ userPrompt: "Add a dark mode toggle", livePreview: true });
    expect(seed).toBe(
      `Add a dark mode toggle\n\n${PREVIEW_CONTRACT}\n\n${STANDING_INSTRUCTION}`
    );
  });

  it("the contract answers each way the preview failed in production", () => {
    // Defect 3: the server died with the tool call that started it.
    expect(PREVIEW_CONTRACT).toContain("setsid nohup");
    expect(PREVIEW_CONTRACT).toContain(DEV_SERVER_LOG);
    // Defect 2: a localhost bind is unreachable from the proxy.
    expect(PREVIEW_CONTRACT).toContain("0.0.0.0");
    expect(PREVIEW_CONTRACT).toContain("never an ephemeral one");
    // Issue #161: no Docker daemon, said before the agent discovers it.
    expect(PREVIEW_CONTRACT).toContain("no Docker daemon");
    // The server outlives the request, so follow-up turns keep the pane.
    expect(PREVIEW_CONTRACT).toContain("across follow-up turns");
  });
});
