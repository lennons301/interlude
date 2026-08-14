/**
 * The app-level theme override that sits on top of `prefers-color-scheme`:
 * "system" follows the OS, "dark"/"light" pin the fleet palette. The choice
 * lives in localStorage and is mirrored onto <html> — as `data-fleet-theme`,
 * which the `.fleet` token blocks in globals.css select on, and as the `dark`
 * class, which is how the shadcn tokens on the not-yet-reskinned screens choose
 * their palette. Both, or a light fleet ground would carry dark zinc cards.
 *
 * Everything here is pure or a small DOM write, so the root layout (a server
 * component) can embed the pre-paint script and the client toggle can share the
 * same vocabulary — one theme contract, not two.
 */

export type FleetTheme = "system" | "dark" | "light";

export const FLEET_THEME_KEY = "fleet-theme";

const THEME_ATTR = "data-fleet-theme";

const DARK_QUERY = "(prefers-color-scheme: dark)";

/** Toggle order: system → dark → light → system. */
export function nextTheme(theme: FleetTheme): FleetTheme {
  return theme === "system" ? "dark" : theme === "dark" ? "light" : "system";
}

/** Only an explicit override is honoured; anything else means "follow the OS". */
export function parseStoredTheme(value: string | null): FleetTheme {
  return value === "dark" || value === "light" ? value : "system";
}

/** The stored choice, or "system" — including when the browser refuses
 * localStorage, where following the OS is the right fallback. */
export function readStoredTheme(): FleetTheme {
  try {
    return parseStoredTheme(localStorage.getItem(FLEET_THEME_KEY));
  } catch {
    return "system";
  }
}

/** Put the resolved theme on <html>, for both token systems. */
export function applyTheme(theme: FleetTheme) {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute(THEME_ATTR);
  else root.setAttribute(THEME_ATTR, theme);
  root.classList.toggle(
    "dark",
    theme === "dark" ||
      (theme === "system" && window.matchMedia(DARK_QUERY).matches)
  );
}

/**
 * Runs as the first element in <body>, so the resolved theme is on <html>
 * before the app paints — no flash of the wrong ground on first load, on any
 * route. Kept as a hand-written string (not a bundled module) because it has to
 * execute synchronously, ahead of hydration; it mirrors `applyTheme`, and the
 * tests hold the two to the same contract. If localStorage or matchMedia is
 * refused, the server-rendered dark ground stands, which is where the design
 * starts from anyway.
 */
export const THEME_PRE_PAINT_SCRIPT = `try{var r=document.documentElement,t=localStorage.getItem("${FLEET_THEME_KEY}");if(t==="dark"||t==="light")r.setAttribute("${THEME_ATTR}",t);else t=null;r.classList.toggle("dark",t?t==="dark":matchMedia("${DARK_QUERY}").matches)}catch(e){}`;
