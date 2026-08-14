import { describe, it, expect } from "vitest";
import {
  FLEET_THEME_KEY,
  THEME_PRE_PAINT_SCRIPT,
  nextTheme,
  parseStoredTheme,
  type FleetTheme,
} from "../fleet-theme";

/** Run the pre-paint script against a fake window, returning the attributes it
 * wrote on <html> — the no-flash contract, exercised as the browser does. */
function runPrePaint(stored: string | null | { throws: true }) {
  const written: Record<string, string> = {};
  const localStorage = {
    getItem(key: string) {
      if (key !== FLEET_THEME_KEY) return null;
      if (stored !== null && typeof stored === "object") {
        throw new Error("localStorage is blocked in this browsing mode");
      }
      return stored;
    },
  };
  const document = {
    documentElement: {
      setAttribute(name: string, value: string) {
        written[name] = value;
      },
    },
  };
  new Function("localStorage", "document", THEME_PRE_PAINT_SCRIPT)(
    localStorage,
    document
  );
  return written;
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
    "pins the %s palette before first paint",
    (stored) => {
      expect(runPrePaint(stored)).toEqual({ "data-fleet-theme": stored });
    }
  );

  it.each([null, "system", "sepia"])(
    "leaves the system palette alone for %s",
    (stored) => {
      expect(runPrePaint(stored)).toEqual({});
    }
  );

  it("survives a browser that refuses localStorage", () => {
    expect(() => runPrePaint({ throws: true })).not.toThrow();
  });
});
