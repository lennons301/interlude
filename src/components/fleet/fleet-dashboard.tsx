"use client";

import { useEffect, useState } from "react";
import type { FleetView } from "@/lib/fleet/fleet-view";
import { AppShell } from "@/components/app-shell";
import { LiveDot } from "./fleet-bits";
import { PulseStrip } from "./pulse-strip";
import { NeedsYou } from "./needs-you";
import { RunningList } from "./running-list";
import { RecentLedger } from "./recent-ledger";

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

export function FleetDashboard() {
  const { view, connected, lastEventAt } = useFleetStream();

  // Local clock for elapsed times — ticks between SSE pushes. Never rendered
  // until the first fleet event arrives (client-only), so the SSR value is
  // inert and hydration stays clean.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  // The dot is the liveness signal: offline whenever the stream is down,
  // even if a stale view is still on screen.
  const paused = view?.spend.capPaused ?? false;
  const dotState = !connected ? "offline" : paused ? "paused" : "live";

  return (
    <AppShell section="fleet" width="wide" accessory={<LiveDot state={dotState} />}>
      {paused && (
        <div className="mb-4 rounded-[4px] border border-fl-red/45 bg-fl-red/13 px-3 py-2 text-sm text-fl-red">
          Daily cap reached — autonomous pickup paused until midnight.
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

      {/* The theme control moved to the shared shell (issue #117); the footer
          keeps the stream's own readout. */}
      <footer className="mt-12 border-t border-fl-line pt-3 font-plex-mono text-[11px] lowercase text-fl-ink-3">
        {connected ? "connected" : "disconnected"}
        {lastEventAt &&
          ` · last event ${lastEventAt.toLocaleTimeString("en-GB", { hour12: false })}`}
      </footer>
    </AppShell>
  );
}
