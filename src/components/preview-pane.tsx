"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

interface PreviewPaneProps {
  taskId: string;
  devPort: number | null;
  lastActivityTimestamp?: number;
}

type PreviewStatus = "loading" | "active" | "stopped" | "error";

export function PreviewPane({
  taskId,
  devPort,
  lastActivityTimestamp,
}: PreviewPaneProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState<PreviewStatus>(
    devPort ? "loading" : "stopped"
  );
  const reloadTimeoutRef = useRef<ReturnType<typeof setTimeout>>(null);
  const retryCountRef = useRef(0);

  const previewUrl = `/api/tasks/${taskId}/preview`;

  const reload = useCallback(() => {
    if (iframeRef.current) {
      iframeRef.current.src = previewUrl;
      setStatus("loading");
    }
  }, [previewUrl]);

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
      setStatus("loading");
    } else {
      setStatus("stopped");
    }
  }, [devPort]);

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
        {status === "loading" && (
          <div className="absolute inset-0 flex items-center justify-center bg-zinc-950/50 z-10">
            <span className="text-zinc-500 text-sm">
              Connecting to dev server...
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
          src={previewUrl}
          className="w-full h-full border-0 bg-white"
          onLoad={handleLoad}
          onError={handleError}
          title="Live Preview"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        />
      </div>
    </div>
  );
}
