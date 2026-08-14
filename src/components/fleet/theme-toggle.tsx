"use client";

import { useSyncExternalStore } from "react";
import {
  FLEET_THEME_KEY,
  nextTheme,
  parseStoredTheme,
  type FleetTheme,
} from "@/lib/fleet-theme";
import { FOCUS_RING } from "./fleet-bits";

/** The stored override, shared by every mounted toggle so the shell and any
 * future theme control stay in step. Writing it mirrors the choice onto <html>,
 * exactly as the pre-paint script does on load. */
let listeners: Array<() => void> = [];
const themeStore = {
  subscribe(listener: () => void) {
    listeners.push(listener);
    return () => {
      listeners = listeners.filter((l) => l !== listener);
    };
  },
  get(): FleetTheme {
    return parseStoredTheme(localStorage.getItem(FLEET_THEME_KEY));
  },
  set(theme: FleetTheme) {
    if (theme === "system") {
      localStorage.removeItem(FLEET_THEME_KEY);
      document.documentElement.removeAttribute("data-fleet-theme");
    } else {
      localStorage.setItem(FLEET_THEME_KEY, theme);
      document.documentElement.setAttribute("data-fleet-theme", theme);
    }
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
