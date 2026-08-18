import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FOCUS_RING } from "@/components/fleet/fleet-bits";

/**
 * The palette's own arithmetic (issue #142). Colour lives in globals.css, so the
 * CSS is what gets read here rather than a duplicate table in TypeScript: a
 * theme re-tune is exactly the edit that would otherwise drop a mark back under
 * the contrast floor without a single test noticing.
 *
 * Two things are checked. The 3:1 WCAG floor for non-text contrast, which the
 * focus ring and a status dot owe and `--fl-ink-3` never met on the light
 * ground (2.44:1) — that is why `--fl-mark` exists. And that the light palette's
 * two copies, which CSS forces (a media query can't be OR'd with a selector),
 * actually agree; the "keep in sync" comment above them is now executable.
 */

const CSS = readFileSync(
  path.join(process.cwd(), "src/app/globals.css"),
  "utf8"
);

/** The custom properties declared in the block opened by `selector`. */
function tokens(selector: string): Record<string, string> {
  const start = CSS.indexOf(selector);
  expect(start, `${selector} not found in globals.css`).toBeGreaterThan(-1);
  const open = CSS.indexOf("{", start);
  const end = CSS.indexOf("}", open);
  const found: Record<string, string> = {};
  for (const [, name, value] of CSS.slice(open, end).matchAll(
    /(--[\w-]+):\s*([^;]+);/g
  )) {
    found[name] = value.trim();
  }
  return found;
}

/** WCAG 2.x relative luminance / contrast ratio, over `#rrggbb`. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const THEMES = {
  dark: '.fleet,\nhtml[data-fleet-theme="dark"] .fleet',
  light: 'html[data-fleet-theme="light"] .fleet',
  // The media-query copy, which is what a visitor with no explicit choice gets.
  "light (system)": 'html:not([data-fleet-theme="dark"]) .fleet',
} as const;

/** Non-text marks sit on any of the three grounds, so all three must clear it. */
const GROUNDS = ["--fl-ground", "--fl-surface", "--fl-card"] as const;

describe("fleet contrast floor", () => {
  it("sanity-checks the ratio against the defect it was written for", () => {
    // The measurement in the ticket: ink-3 on the light ground, under 3:1.
    expect(contrast("#9c9285", "#eae5dc")).toBeCloseTo(2.44, 2);
  });

  for (const [theme, selector] of Object.entries(THEMES)) {
    for (const ground of GROUNDS) {
      it(`${theme}: --fl-mark clears 3:1 against ${ground}`, () => {
        const palette = tokens(selector);

        expect(
          contrast(palette["--fl-mark"], palette[ground])
        ).toBeGreaterThanOrEqual(3);
      });
    }
  }
});

describe("fleet palette", () => {
  it("keeps the light theme's two copies identical", () => {
    expect(tokens(THEMES.light)).toEqual(tokens(THEMES["light (system)"]));
  });

  it("draws the focus ring in the mark, not in the quietest ink", () => {
    expect(FOCUS_RING).toContain("outline-fl-mark");
    expect(FOCUS_RING).not.toContain("outline-fl-ink-3");
  });

  it("draws the cancelled status dot in the mark too", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src/components/task-chat.tsx"),
      "utf8"
    );

    expect(source).toContain('cancelled: "bg-fl-mark"');
  });
});
