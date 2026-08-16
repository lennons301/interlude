"use client";

import { Chip, LoadFailure, PANEL_PLAIN } from "@/components/fleet/fleet-bits";
import { useLoad } from "@/lib/use-load";

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
  const { data: info, error, reload } = useLoad<DockerInfo>("/api/settings/docker");

  if (info === null) {
    return (
      <div className={PANEL_PLAIN}>
        {error === null ? (
          <p className="font-plex-mono text-[11px] text-fl-ink-3">checking…</p>
        ) : (
          <LoadFailure what="the Docker status" error={error} onRetry={reload} />
        )}
      </div>
    );
  }

  return (
    <div className={PANEL_PLAIN}>
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
