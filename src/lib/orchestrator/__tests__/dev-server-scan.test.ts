import { describe, it, expect } from "vitest";
import {
  CHAT_SCAN_EVERY_POLLS,
  PREVIEW_SCAN_EVERY_POLLS,
  devServerScanDue,
} from "../dev-server-scan";

/**
 * The scan cadence table (issue #160, defect 1): which interactive sessions
 * the queue loop looks into for a dev server, and when.
 */

const preview = { livePreview: true, sessionSkill: null };
const chat = { livePreview: false, sessionSkill: null };
const grill = { livePreview: false, sessionSkill: "grill-me" };

describe("devServerScanDue", () => {
  it("scans a live-preview session mid-turn, on the short cadence", () => {
    expect(devServerScanDue(preview, "running", PREVIEW_SCAN_EVERY_POLLS)).toBe(true);
    expect(devServerScanDue(preview, "running", PREVIEW_SCAN_EVERY_POLLS * 3)).toBe(true);
    expect(devServerScanDue(preview, "running", PREVIEW_SCAN_EVERY_POLLS + 1)).toBe(false);
  });

  it("keeps scanning a live-preview session while it is idle", () => {
    expect(devServerScanDue(preview, "idle", PREVIEW_SCAN_EVERY_POLLS)).toBe(true);
  });

  it("scans a plain chat only while idle, on the long cadence it always had", () => {
    expect(devServerScanDue(chat, "idle", CHAT_SCAN_EVERY_POLLS)).toBe(true);
    expect(devServerScanDue(chat, "idle", PREVIEW_SCAN_EVERY_POLLS)).toBe(false);
    expect(devServerScanDue(chat, "running", CHAT_SCAN_EVERY_POLLS)).toBe(false);
  });

  it("never scans a generation session — grilling runs no app", () => {
    for (const state of ["running", "idle"] as const) {
      expect(devServerScanDue(grill, state, CHAT_SCAN_EVERY_POLLS * PREVIEW_SCAN_EVERY_POLLS)).toBe(false);
    }
  });

  it("never scans a container being set up or torn down", () => {
    const tick = CHAT_SCAN_EVERY_POLLS * PREVIEW_SCAN_EVERY_POLLS;
    for (const state of ["setup", "completing"] as const) {
      expect(devServerScanDue(preview, state, tick)).toBe(false);
      expect(devServerScanDue(chat, state, tick)).toBe(false);
    }
  });

  it("the short cadence is a fraction of a minute and divides the long one", () => {
    // ~10s at the 2s poll, and a tick that is due for a chat is due for a
    // preview session too, so the loop can gate the profile read on one number.
    expect(PREVIEW_SCAN_EVERY_POLLS * 2).toBeLessThanOrEqual(15);
    expect(CHAT_SCAN_EVERY_POLLS % PREVIEW_SCAN_EVERY_POLLS).toBe(0);
  });
});
