"use client";

import { useEffect, useSyncExternalStore } from "react";
import {
  applyTheme,
  FLEET_THEME_KEY,
  nextTheme,
  readStoredTheme,
  type FleetTheme,
} from "@/lib/fleet-theme";
import { FOCUS_RING } from "./fleet-bits";

/** The stored override, shared by every mounted toggle so the shell and any
 * future theme control stay in step. Persistence is best-effort — a browser that
 * refuses localStorage still gets a working toggle for the session. */
let listeners: Array<() => void> = [];
const themeStore = {
  subscribe(listener: () => void) {
    listeners.push(listener);
    return () => {
      listeners = listeners.filter((l) => l !== listener);
    };
  },
  get: readStoredTheme,
  set(theme: FleetTheme) {
    try {
      if (theme === "system") localStorage.removeItem(FLEET_THEME_KEY);
      else localStorage.setItem(FLEET_THEME_KEY, theme);
    } catch {
      // Private-mode storage; the choice still applies to this page.
    }
    applyTheme(theme);
    listeners.forEach((l) => l());
  },
};

/** Filled = pinned dark, hollow = pinned light, half = follow the system. */
const GLYPHS: Record<FleetTheme, string> = {
  system: "◐",
  dark: "●",
  light: "○",
};

export function ThemeToggle() {
  // Server-rendered as "system": the real value is read on the client, where
  // localStorage exists (the pre-paint script has already applied it to <html>,
  // so the glyph catching up costs no visible flash).
  const theme = useSyncExternalStore(
    themeStore.subscribe,
    themeStore.get,
    () => "system" as const
  );

  // On "system" the fleet tokens follow the OS through a media query, but the
  // shadcn `dark` class can't — so re-resolve it when the OS flips.
  useEffect(() => {
    if (theme !== "system") return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const resolve = () => applyTheme("system");
    query.addEventListener("change", resolve);
    return () => query.removeEventListener("change", resolve);
  }, [theme]);

  return (
    <button
      type="button"
      onClick={() => themeStore.set(nextTheme(theme))}
      aria-label={`Theme: ${theme}. Change theme.`}
      title={`theme: ${theme}`}
      className={`flex shrink-0 items-center gap-1.5 font-plex-mono text-[11px] lowercase text-fl-ink-3 hover:text-fl-ink ${FOCUS_RING}`}
    >
      <span aria-hidden>{GLYPHS[theme]}</span>
      <span aria-hidden className="hidden sm:inline">
        {theme}
      </span>
    </button>
  );
}
