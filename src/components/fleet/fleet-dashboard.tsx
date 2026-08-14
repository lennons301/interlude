"use client";

import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { FleetView } from "@/lib/fleet/fleet-view";
import { LiveDot } from "./fleet-bits";
import { PulseStrip } from "./pulse-strip";
import { NeedsYou } from "./needs-you";
import { RunningList } from "./running-list";
import { RecentLedger } from "./recent-ledger";

type FleetTheme = "system" | "dark" | "light";

function useFleetStream() {
  const [view, setView] = useState<FleetView | null>(null);
  const [connected, setConnected] = useState(false);
  const [lastEventAt, setLastEventAt] = useState<Date | null>(null);

  useEffect(() => {
    const source = new EventSource("/api/fleet/stream");
    source.addEventListener("fleet", (event) => {
      setView(JSON.parse((event as MessageEvent).data));
      setLastEventAt(new Date());
    });
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    return () => source.close();
  }, []);

  return { view, connected, lastEventAt };
}

/** App-level theme override on top of prefers-color-scheme, kept in
 * localStorage and mirrored to data-fleet-theme on <html>. */
let themeListeners: Array<() => void> = [];
const themeStore = {
  subscribe(listener: () => void) {
    themeListeners.push(listener);
    return () => {
      themeListeners = themeListeners.filter((l) => l !== listener);
    };
  },
  get(): FleetTheme {
    const stored = localStorage.getItem("fleet-theme");
    return stored === "dark" || stored === "light" ? stored : "system";
  },
  set(theme: FleetTheme) {
    if (theme === "system") {
      localStorage.removeItem("fleet-theme");
      document.documentElement.removeAttribute("data-fleet-theme");
    } else {
      localStorage.setItem("fleet-theme", theme);
      document.documentElement.setAttribute("data-fleet-theme", theme);
    }
    themeListeners.forEach((l) => l());
  },
};

function useFleetTheme(): [FleetTheme, () => void] {
  const theme = useSyncExternalStore(
    themeStore.subscribe,
    themeStore.get,
    () => "system" as const
  );
  const cycle = () =>
    themeStore.set(theme === "system" ? "dark" : theme === "dark" ? "light" : "system");
  return [theme, cycle];
}

export function FleetDashboard() {
  const { view, connected, lastEventAt } = useFleetStream();
  const [theme, cycleTheme] = useFleetTheme();

  // Local clock for elapsed times — ticks between SSE pushes. Never rendered
  // until the first fleet event arrives (client-only), so the SSR value is
  // inert and hydration stays clean.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  // The dot is the liveness signal: offline whenever the stream is down,
  // even if a stale view is still on screen. Paused means no new autonomous
  // pickup — the kill switch (issue #118) or the daily cap; the banner below
  // names which, since they are lifted in completely different ways.
  const pickupPaused = view?.pickupPaused ?? null;
  const dotState = !connected ? "offline" : pickupPaused ? "paused" : "live";

  return (
    <div className="mx-auto min-h-dvh w-full max-w-md px-4 pb-10 min-[900px]:max-w-4xl">
      <header className="flex h-14 items-center justify-between">
        <span className="flex items-center gap-2.5">
          <span className="font-plex-mono text-[13px] font-medium lowercase">
            interlude <span className="text-fl-ink-3">/ fleet</span>
          </span>
          <LiveDot state={dotState} />
        </span>
        <nav className="flex items-center gap-3 font-plex-mono text-[11px] lowercase">
          <Link href="/tasks/new" className="text-fl-ink-3 hover:text-fl-ink">
            new
          </Link>
          <Link href="/tasks" className="text-fl-ink-3 hover:text-fl-ink">
            tasks
          </Link>
          <Link href="/settings" className="text-fl-ink-3 hover:text-fl-ink">
            settings
          </Link>
        </nav>
      </header>

      {pickupPaused && (
        // Amber for the switch, red for the cap — the estate's severity
        // vocabulary: a deliberate operator hold is not the same news as a
        // breached spend ceiling.
        <div
          role="status"
          className={`mb-4 rounded-[4px] border px-3 py-2 text-sm ${
            pickupPaused.reason === "kill-switch"
              ? "border-fl-amber/45 bg-fl-amber/13 text-fl-amber"
              : "border-fl-red/45 bg-fl-red/13 text-fl-red"
          }`}
        >
          {pickupPaused.body}
        </div>
      )}

      {view === null ? (
        <p className="py-12 text-center font-plex-mono text-[11px] text-fl-ink-3">
          connecting…
        </p>
      ) : (
        <div className="space-y-8">
          <PulseStrip view={view} />
          <div className="space-y-8 min-[900px]:grid min-[900px]:grid-cols-[1fr_320px] min-[900px]:items-start min-[900px]:gap-10 min-[900px]:space-y-0">
            <div className="space-y-8">
              <NeedsYou view={view} />
              <RunningList view={view} now={now} />
            </div>
            <RecentLedger view={view} now={new Date(now)} />
          </div>
        </div>
      )}

      <footer className="mt-12 flex items-center justify-between border-t border-fl-line pt-3 font-plex-mono text-[11px] lowercase text-fl-ink-3">
        <span>
          {connected ? "connected" : "disconnected"}
          {lastEventAt &&
            ` · last event ${lastEventAt.toLocaleTimeString("en-GB", { hour12: false })}`}
        </span>
        <button
          type="button"
          onClick={cycleTheme}
          className="hover:text-fl-ink"
          title="Cycle theme override"
        >
          theme: {theme}
        </button>
      </footer>
    </div>
  );
}
