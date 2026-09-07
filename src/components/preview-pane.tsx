"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FOCUS_RING } from "@/components/fleet/fleet-bits";

interface PreviewPaneProps {
  taskId: string;
  devPort: number | null;
  previewSubdomain: string | null;
  domain: string | null;
  lastActivityTimestamp?: number;
  /** A live-preview session (issue #160): the pane is open before a server is
   * detected, so with no port it says it is waiting rather than that nothing
   * is running. */
  expected?: boolean;
  /** Whether the agent's turn is in progress — the difference between "the
   * server is on its way" and "the agent is idle and no server is up". */
  agentWorking?: boolean;
  /** Whether a port has ever been published for this task: "stopped" is only
   * true of a server that was there. Latched by the parent from the status
   * stream, which is where the port arrives. */
  everHadPort?: boolean;
}

type PreviewStatus = "loading" | "active" | "stopped" | "error" | "provisioning";

export function PreviewPane({
  taskId,
  devPort,
  previewSubdomain,
  domain,
  lastActivityTimestamp,
  expected = false,
  agentWorking = false,
  everHadPort = false,
}: PreviewPaneProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState<PreviewStatus>(
    devPort ? "loading" : "stopped"
  );
  const reloadTimeoutRef = useRef<ReturnType<typeof setTimeout>>(null);
  const retryCountRef = useRef(0);
  const certReadyRef = useRef(false);

  const isSubdomain = !!(previewSubdomain && domain);
  const previewUrl = isSubdomain
    ? `https://${previewSubdomain}.${domain}`
    : `/api/tasks/${taskId}/preview`;

  // Pre-warm the TLS cert before loading the iframe (subdomain only).
  // Caddy provisions the cert on first request (~5s), which causes the
  // iframe to show a TLS error. We probe with fetch first.
  const warmCertAndLoad = useCallback(async () => {
    if (!iframeRef.current) return;
    if (!isSubdomain || certReadyRef.current) {
      iframeRef.current.src = previewUrl;
      return;
    }
    setStatus("provisioning");
    for (let i = 0; i < 10; i++) {
      try {
        await fetch(previewUrl, { mode: "no-cors", cache: "no-store" });
        certReadyRef.current = true;
        setStatus("loading");
        iframeRef.current.src = previewUrl;
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    // Give up after ~20s
    setStatus("error");
  }, [previewUrl, isSubdomain]);

  const reload = useCallback(() => {
    if (iframeRef.current) {
      setStatus("loading");
      if (isSubdomain && !certReadyRef.current) {
        warmCertAndLoad();
      } else {
        iframeRef.current.src = previewUrl;
      }
    }
  }, [previewUrl, isSubdomain, warmCertAndLoad]);

  const handleLoad = useCallback(() => {
    retryCountRef.current = 0;
    setStatus("active");
  }, []);

  // Retry loading on error (dev server may still be starting)
  const handleError = useCallback(() => {
    if (retryCountRef.current < 5 && devPort) {
      retryCountRef.current++;
      setTimeout(reload, 2000);
    } else {
      setStatus("error");
    }
  }, [devPort, reload]);

  // Update status when devPort changes
  useEffect(() => {
    if (devPort) {
      retryCountRef.current = 0;
      certReadyRef.current = false;
      warmCertAndLoad();
    } else {
      setStatus("stopped");
    }
  }, [devPort, warmCertAndLoad]);

  // Fallback: reload on agent activity (debounced 500ms)
  useEffect(() => {
    if (!lastActivityTimestamp || !devPort) return;

    if (reloadTimeoutRef.current) {
      clearTimeout(reloadTimeoutRef.current);
    }
    reloadTimeoutRef.current = setTimeout(() => {
      reload();
    }, 500);

    return () => {
      if (reloadTimeoutRef.current) clearTimeout(reloadTimeoutRef.current);
    };
  }, [lastActivityTimestamp, devPort, reload]);

  if (!devPort) {
    return (
      <div className="flex h-full items-center justify-center bg-fl-ground font-plex-mono text-[11px] text-fl-ink-2">
        {emptyPaneNote({ expected, agentWorking, everHadPort })}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-fl-ground">
      {/* Toolbar */}
      <div className="flex shrink-0 items-center gap-2 border-b border-fl-line bg-fl-surface px-3 py-2">
        <span className="font-plex-mono text-[11px] tabular-nums text-fl-ink-2">
          :{devPort}
        </span>
        <div className="flex-1" />
        <ToolbarButton onClick={reload}>reload</ToolbarButton>
        {/* noopener: the preview is agent-authored code, and a bare
            window.open leaves it holding window.opener on this tab. */}
        <ToolbarButton
          onClick={() => window.open(previewUrl, "_blank", "noopener")}
        >
          open
        </ToolbarButton>
      </div>

      {/* iframe */}
      <div className="flex-1 relative">
        {/* Held at half opacity: this overlay is not rare. Every agent write
            reloads the iframe 500ms later, so a heavier scrim would blink the
            preview out on each save rather than tint it. The note carries its
            own ground, so legibility does not depend on the scrim. */}
        {(status === "loading" || status === "provisioning") && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-fl-ground/50">
            <StatusNote>
              {status === "provisioning"
                ? "Provisioning preview certificate..."
                : "Connecting to dev server..."}
            </StatusNote>
          </div>
        )}
        {status === "error" && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2.5 bg-fl-ground">
            <StatusNote>Could not connect to dev server</StatusNote>
            <button
              type="button"
              onClick={reload}
              className={`flex h-7 items-center rounded-[4px] border border-fl-line-strong px-2.5 font-plex-mono text-[11px] lowercase text-fl-ink hover:bg-fl-card ${FOCUS_RING}`}
            >
              retry
            </button>
          </div>
        )}
        <iframe
          ref={iframeRef}
          src={isSubdomain ? "about:blank" : previewUrl}
          className="w-full h-full border-0"
          onLoad={handleLoad}
          onError={handleError}
          title="Live Preview"
          {...(!previewSubdomain || !domain
            ? { sandbox: "allow-scripts allow-same-origin allow-forms allow-popups" }
            : {}
          )}
        />
      </div>
    </div>
  );
}

/**
 * What the empty pane says (issue #160). Pure, so the four readings are a
 * table: a server that was up and went away is a *stopped* server, whatever
 * the session type; a live-preview session that has not shown one yet is
 * *waiting* — for the agent to start it while the turn runs, or for the owner
 * to ask, once the agent has gone idle without one; an ordinary chat with no
 * server simply has none running.
 */
export function emptyPaneNote({
  expected,
  agentWorking,
  everHadPort,
}: {
  expected: boolean;
  agentWorking: boolean;
  everHadPort: boolean;
}): string {
  if (everHadPort) {
    return "Dev server stopped — the preview returns when one is listening again";
  }
  if (expected) {
    return agentWorking
      ? "Waiting for the dev server — the agent starts it as it begins"
      : "No dev server yet — ask the agent to start it, detached and bound to 0.0.0.0";
  }
  return "No dev server running";
}

/** The pane's chrome controls speak the fleet's quiet lowercase mono voice, the
 * same one the shell's nav and theme toggle use. They are deliberately not
 * shadcn `Button`s: those are painted from the greyscale shadcn tokens, which
 * are a different palette from the fleet's parchment/ink one.
 *
 * `h-6` is a floor, not decoration — 11px mono leaves a ~18px box on its own,
 * and these are thumb targets on the mobile preview tab. */
function ToolbarButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex h-6 items-center rounded-[4px] px-2 font-plex-mono text-[11px] lowercase text-fl-ink-2 hover:text-fl-ink ${FOCUS_RING}`}
    >
      {children}
    </button>
  );
}

/** A message shown over the iframe carries its own opaque ground: what the dev
 * server has painted underneath is not a background this palette controls, so
 * ink-on-scrim alone can't be relied on to stay legible. */
function StatusNote({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-[4px] border border-fl-line bg-fl-card px-2.5 py-1 font-plex-mono text-[11px] text-fl-ink-2">
      {children}
    </span>
  );
}
