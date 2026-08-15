"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FOCUS_RING } from "@/components/fleet/fleet-bits";

interface PreviewPaneProps {
  taskId: string;
  devPort: number | null;
  previewSubdomain: string | null;
  domain: string | null;
  lastActivityTimestamp?: number;
}

type PreviewStatus = "loading" | "active" | "stopped" | "error" | "provisioning";

export function PreviewPane({
  taskId,
  devPort,
  previewSubdomain,
  domain,
  lastActivityTimestamp,
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
        {status === "stopped"
          ? "Dev server stopped"
          : "No dev server running"}
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
        <ToolbarButton onClick={() => window.open(previewUrl, "_blank")}>
          open
        </ToolbarButton>
      </div>

      {/* iframe */}
      <div className="flex-1 relative">
        {(status === "loading" || status === "provisioning") && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-fl-ground/80">
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
              className={`rounded-[4px] border border-fl-line-strong px-2.5 py-1 font-plex-mono text-[11px] lowercase text-fl-ink hover:bg-fl-card ${FOCUS_RING}`}
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

/** The pane's chrome controls speak the fleet's quiet lowercase mono voice, the
 * same one the shell's nav and theme toggle use. They are deliberately not
 * shadcn `Button`s: those are painted from the greyscale shadcn tokens, which
 * are a different palette from the fleet's parchment/ink one. */
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
      className={`rounded-[4px] px-1.5 py-px font-plex-mono text-[11px] lowercase text-fl-ink-2 hover:text-fl-ink ${FOCUS_RING}`}
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
