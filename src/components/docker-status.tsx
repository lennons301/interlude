"use client";

import { Chip, LoadFailure, PANEL_PLAIN } from "@/components/fleet/fleet-bits";
import type { HarnessImageState } from "@/lib/harness/image-state";
import { useLoad } from "@/lib/use-load";

/**
 * The environment readout on the settings screen (issue #119): whether the
 * Docker daemon is reachable and whether each harness's agent image has been
 * built — one image per adapter since issue #216, so one row each. Both are
 * preconditions for a task running on that harness at all, so this is the
 * first thing to look at when nothing starts.
 *
 * A probe that fails now says so and offers a retry — it used to sit on
 * "Checking…" forever, which reads exactly like a hung daemon and is the one
 * answer this panel must never give by accident.
 */

type DockerInfo = {
  docker: boolean;
  images: HarnessImageState[];
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
      {info.images.map((image) => (
        <Row key={image.id} label={`${image.id} image`}>
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate font-plex-mono text-[11px] text-fl-ink-2">
              {image.image}
            </span>
            {/* Amber, not red: an image is built on demand at the first pass on
                its harness, so "not built" is a wait rather than a fault. Quiet
                when the daemon did not answer: "not built" would then be a guess
                dressed as a verdict. */}
            <Chip tone={image.built === null ? "quiet" : image.built ? "green" : "amber"}>
              {image.built === null ? "unknown" : image.built ? "ready" : "not built"}
            </Chip>
          </span>
        </Row>
      ))}
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
