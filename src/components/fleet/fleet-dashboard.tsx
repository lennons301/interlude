"use client";

import { useEffect, useState } from "react";
import type { FleetView, PickupPause } from "@/lib/fleet/fleet-view";
import { AppShell } from "@/components/app-shell";
import { LiveDot, TONES, type LiveDotState } from "./fleet-bits";
import { PulseStrip } from "./pulse-strip";
import { NeedsYou } from "./needs-you";
import { RunningList } from "./running-list";
import { RecentLedger } from "./recent-ledger";

// How a fleet-wide hold on pickup reads (issue #118). A deliberate operator
// hold is amber and says "held"; a breached spend ceiling is red and says
// "paused" — the estate's severity vocabulary, and not the same news.
const PAUSE_DOT: Record<PickupPause["reason"], LiveDotState> = {
  "kill-switch": "held",
  "daily-cap": "paused",
};

const PAUSE_TONE: Record<PickupPause["reason"], keyof typeof TONES> = {
  "kill-switch": "amber",
  "daily-cap": "red",
};

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

  // The dot is the liveness signal: offline whenever the stream is down, even
  // if a stale view is still on screen. Otherwise it carries whether new
  // autonomous pickup is happening — held by the operator's kill switch (issue
  // #118) or paused by the breached daily cap, each in its own tone, with the
  // banner below naming it. The two are lifted in completely different ways.
  const pickupPaused = view?.pickupPaused ?? null;
  const dotState: LiveDotState = !connected
    ? "offline"
    : pickupPaused
      ? PAUSE_DOT[pickupPaused.reason]
      : "live";

  return (
    <AppShell section="fleet" width="wide" accessory={<LiveDot state={dotState} />}>
      {pickupPaused && (
        <div
          role="status"
          className={`mb-4 rounded-[4px] border px-3 py-2 text-sm ${TONES[PAUSE_TONE[pickupPaused.reason]]}`}
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
