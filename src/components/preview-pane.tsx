"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

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
      <div className="flex items-center justify-center h-full text-zinc-500 text-sm">
        {status === "stopped"
          ? "Dev server stopped"
          : "No dev server running"}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800 shrink-0">
        <span className="text-xs text-zinc-500 font-mono">:{devPort}</span>
        <div className="flex-1" />
        <Button
          onClick={reload}
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs text-zinc-400"
        >
          Reload
        </Button>
        <Button
          onClick={() => window.open(previewUrl, "_blank")}
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs text-zinc-400"
        >
          Open
        </Button>
      </div>

      {/* iframe */}
      <div className="flex-1 relative">
        {(status === "loading" || status === "provisioning") && (
          <div className="absolute inset-0 flex items-center justify-center bg-zinc-950/50 z-10">
            <span className="text-zinc-500 text-sm">
              {status === "provisioning"
                ? "Provisioning preview certificate..."
                : "Connecting to dev server..."}
            </span>
          </div>
        )}
        {status === "error" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 z-10">
            <span className="text-zinc-500 text-sm">
              Could not connect to dev server
            </span>
            <Button onClick={reload} size="sm" variant="outline" className="text-xs">
              Retry
            </Button>
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
