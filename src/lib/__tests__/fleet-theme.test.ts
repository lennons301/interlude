import { describe, it, expect } from "vitest";
import {
  FLEET_THEME_KEY,
  THEME_PRE_PAINT_SCRIPT,
  nextTheme,
  parseStoredTheme,
  type FleetTheme,
} from "../fleet-theme";

/**
 * Run the pre-paint script against a fake window — the no-flash contract,
 * exercised the way the browser runs it. Returns what it wrote on <html>:
 * `attr` is the fleet palette override, `dark` whether the shadcn dark class is
 * on (undefined = untouched, i.e. the server-rendered class stands).
 */
function runPrePaint({
  stored = null,
  systemDark = false,
  storageThrows = false,
}: {
  stored?: string | null;
  systemDark?: boolean;
  storageThrows?: boolean;
}) {
  let attr: string | undefined;
  let dark: boolean | undefined;
  const localStorage = {
    getItem(key: string) {
      if (storageThrows) throw new Error("storage is blocked in this mode");
      return key === FLEET_THEME_KEY ? stored : null;
    },
  };
  const document = {
    documentElement: {
      setAttribute(name: string, value: string) {
        if (name === "data-fleet-theme") attr = value;
      },
      removeAttribute(name: string) {
        if (name === "data-fleet-theme") attr = undefined;
      },
      classList: {
        toggle(name: string, on: boolean) {
          if (name === "dark") dark = on;
        },
      },
    },
  };
  const matchMedia = (query: string) => ({
    matches: query === "(prefers-color-scheme: dark)" && systemDark,
  });
  new Function(
    "localStorage",
    "document",
    "matchMedia",
    THEME_PRE_PAINT_SCRIPT
  )(localStorage, document, matchMedia);
  return { attr, dark };
}

describe("nextTheme", () => {
  const cycle: Array<[FleetTheme, FleetTheme]> = [
    ["system", "dark"],
    ["dark", "light"],
    ["light", "system"],
  ];

  it.each(cycle)("cycles %s → %s", (from, to) => {
    expect(nextTheme(from)).toBe(to);
  });

  it("returns to where it started after three presses", () => {
    expect(nextTheme(nextTheme(nextTheme("system")))).toBe("system");
  });
});

describe("parseStoredTheme", () => {
  it.each([
    ["dark", "dark"],
    ["light", "light"],
    [null, "system"],
    ["system", "system"],
    ["", "system"],
    ["DARK", "system"],
    ["sepia", "system"],
  ] as const)("reads %s as %s", (stored, expected) => {
    expect(parseStoredTheme(stored)).toBe(expected);
  });
});

describe("THEME_PRE_PAINT_SCRIPT", () => {
  it.each(["dark", "light"] as const)(
    "pins the %s palette before first paint, whatever the OS prefers",
    (stored) => {
      expect(runPrePaint({ stored, systemDark: false })).toEqual({
        attr: stored,
        dark: stored === "dark",
      });
      expect(runPrePaint({ stored, systemDark: true })).toEqual({
        attr: stored,
        dark: stored === "dark",
      });
    }
  );

  it.each([null, "system", "sepia"])(
    "follows the OS for %s, leaving the fleet palette to its media query",
    (stored) => {
      expect(runPrePaint({ stored, systemDark: true })).toEqual({
        attr: undefined,
        dark: true,
      });
      expect(runPrePaint({ stored, systemDark: false })).toEqual({
        attr: undefined,
        dark: false,
      });
    }
  );

  it("leaves the server-rendered ground alone when storage is refused", () => {
    expect(() => runPrePaint({ storageThrows: true })).not.toThrow();
    expect(runPrePaint({ storageThrows: true })).toEqual({
      attr: undefined,
      dark: undefined,
    });
  });
});
