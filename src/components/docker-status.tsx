"use client";

import { useCallback, useEffect, useState } from "react";
import { Chip, ControlButton } from "@/components/fleet/fleet-bits";

/**
 * The environment readout on the settings screen (issue #119): whether the
 * Docker daemon is reachable and whether the agent image has been built. Both
 * are preconditions for any task running at all, so this is the first thing to
 * look at when nothing starts.
 *
 * A probe that fails now says so and offers a retry — it used to sit on
 * "Checking…" forever, which reads exactly like a hung daemon and is the one
 * answer this panel must never give by accident.
 */

type DockerInfo = {
  docker: boolean;
  image: boolean;
  imageName: string;
};

export function DockerStatus() {
  const [info, setInfo] = useState<DockerInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;

    (async () => {
      try {
        const res = await fetch("/api/settings/docker", {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`the server answered ${res.status}`);
        const data: DockerInfo = await res.json();
        if (stopped) return;
        setInfo(data);
        setError(null);
      } catch (err) {
        if (stopped || controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "the request failed");
      }
    })();

    return () => {
      stopped = true;
      controller.abort();
    };
  }, [reloadKey]);

  const retry = useCallback(() => {
    setError(null);
    setReloadKey((key) => key + 1);
  }, []);

  if (error !== null && info === null) {
    return (
      <Panel>
        <p role="alert" className="text-[13px] text-fl-red">
          Couldn&apos;t read the Docker status — {error}.
        </p>
        <ControlButton onClick={retry}>retry</ControlButton>
      </Panel>
    );
  }

  if (info === null) {
    return (
      <Panel>
        <p className="font-plex-mono text-[11px] text-fl-ink-3">checking…</p>
      </Panel>
    );
  }

  return (
    <Panel>
      <Row label="daemon">
        <Chip tone={info.docker ? "green" : "red"}>
          {info.docker ? "connected" : "unreachable"}
        </Chip>
      </Row>
      <Row label="agent image">
        {/* Amber, not red: with the daemon down the image can't be probed at
            all, so "not built" would be a guess dressed as a verdict. */}
        <Chip tone={info.docker ? (info.image ? "green" : "amber") : "quiet"}>
          {!info.docker ? "unknown" : info.image ? "ready" : "not built"}
        </Chip>
      </Row>
      <Row label="image">
        <span className="truncate font-plex-mono text-[11px] text-fl-ink-2">
          {info.imageName}
        </span>
      </Row>
    </Panel>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-2 rounded-[4px] border border-fl-line bg-fl-card px-3 py-2.5">
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="font-plex-mono text-[11px] lowercase text-fl-ink-3">
        {label}
      </span>
      {children}
    </div>
  );
}
