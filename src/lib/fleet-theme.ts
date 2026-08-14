/**
 * The app-level theme override that sits on top of `prefers-color-scheme`:
 * "system" follows the OS, "dark"/"light" pin the fleet palette. The choice
 * lives in localStorage and is mirrored to `data-fleet-theme` on <html>, which
 * is what the `.fleet` token blocks in globals.css select on.
 *
 * Everything here is pure or DOM-string, so the root layout (a server
 * component) can embed the pre-paint script and the client toggle can share the
 * same vocabulary — one theme contract, not two.
 */

export type FleetTheme = "system" | "dark" | "light";

export const FLEET_THEME_KEY = "fleet-theme";

/** Toggle order: system → dark → light → system. */
export function nextTheme(theme: FleetTheme): FleetTheme {
  return theme === "system" ? "dark" : theme === "dark" ? "light" : "system";
}

/** Only an explicit override is honoured; anything else means "follow the OS". */
export function parseStoredTheme(value: string | null): FleetTheme {
  return value === "dark" || value === "light" ? value : "system";
}

/**
 * Runs as the first element in <body>, so a stored override is on <html>
 * before the app paints — no flash of the wrong ground on first load, on any
 * route. Kept as a hand-written string (not a bundled module) because it has to
 * execute synchronously, ahead of hydration; wrapped in try/catch because
 * localStorage throws in some privacy modes, where following the OS is the
 * right fallback.
 */
export const THEME_PRE_PAINT_SCRIPT = `try{var t=localStorage.getItem("${FLEET_THEME_KEY}");if(t==="dark"||t==="light")document.documentElement.setAttribute("data-fleet-theme",t)}catch(e){}`;
