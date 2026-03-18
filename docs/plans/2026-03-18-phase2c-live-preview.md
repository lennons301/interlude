# Phase 2c: Live Preview — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Proxy agent dev servers into the task detail page with live HMR, auto-detected via port scanning.

**Architecture:** A Next.js HTTP proxy route forwards requests to agent containers on a shared Docker network. A custom Node.js server wrapper handles WebSocket upgrades for HMR. Port scanning after each turn detects dev servers automatically.

**Tech Stack:** dockerode (existing), net (Node.js built-in for WebSocket proxy), Next.js standalone custom server.

**Spec:** `docs/specs/2026-03-18-phase2c-live-preview-design.md`

---

## File Structure

```
custom-server.js                                   — NEW: Node.js server wrapping Next.js + WebSocket proxy
Dockerfile                                         — MODIFY: copy custom-server.js, change entrypoint
Dockerfile.agent                                   — MODIFY: add iproute2
docker-compose.yml                                 — MODIFY: add explicit network name
src/
  app/
    api/
      tasks/[id]/
        preview/[...path]/route.ts                 — NEW: HTTP proxy route
  components/
    preview-pane.tsx                                — NEW: iframe + toolbar + fallback reload
    task-chat.tsx                                   — MODIFY: add tab/split responsive layout
  lib/
    docker/
      container-manager.ts                         — MODIFY: join named network, return container name
    orchestrator/
      port-scanner.ts                              — NEW: detect listening ports in containers
      turn-manager.ts                              — MODIFY: call port scanner after turns
  db/
    schema.ts                                      — MODIFY: add devPort, containerName columns
drizzle/
  XXXX_migration.sql                               — GENERATED
```

---

## Chunk 1: Infrastructure — Schema, Networking, Port Scanner

### Task 1: Schema changes

**Files:**
- Modify: `src/db/schema.ts`

- [ ] **Step 1: Add columns to tasks table**

In `src/db/schema.ts`, add after the `totalCostUsd` line:

```typescript
  devPort: int("dev_port"),
  containerName: text("container_name"),
```

- [ ] **Step 2: Generate migration**

```bash
npx drizzle-kit generate
```

- [ ] **Step 3: Verify build**

```bash
rm -f local.db && pnpm build
```

- [ ] **Step 4: Commit**

```bash
git add src/db/schema.ts drizzle/
git commit -m "feat: add devPort and containerName columns to tasks table"
```

---

### Task 2: Docker networking — explicit network name

**Files:**
- Modify: `docker-compose.yml`
- Modify: `src/lib/docker/container-manager.ts`

- [ ] **Step 1: Add explicit network name to docker-compose.yml**

Add at the bottom of `docker-compose.yml`:

```yaml
networks:
  default:
    name: interlude
```

- [ ] **Step 2: Update container-manager to join named network and store container name**

In `src/lib/docker/container-manager.ts`, in `createWorkspaceContainer`:

Change `NetworkMode: "bridge"` to `NetworkMode: "interlude"`.

Also capture the container name and return it. Change the return type and return statement:

```typescript
export interface RunningContainer {
  container: Docker.Container;
  id: string;
  name: string;
}
```

Update `createWorkspaceContainer` — the container name is already set on line 55:

```typescript
  const containerName = `interlude-task-${options.taskId}-${Date.now()}`;

  const container = await docker.createContainer({
    Image: getImageName(),
    name: containerName,
    Env: env,
    Cmd: ["sleep", "infinity"],
    WorkingDir: "/workspace",
    HostConfig: {
      NetworkMode: "interlude",
      Binds: binds.length > 0 ? binds : undefined,
    },
  });

  return { container, id: container.id, name: containerName };
```

- [ ] **Step 3: Update turn-manager to store containerName in DB**

In `src/lib/orchestrator/turn-manager.ts`, in `startTask`, after line 67 (`updateTask(taskId, { containerId: running.id })`), update to also store the container name:

```typescript
    updateTask(taskId, { containerId: running.id, containerName: running.name });
```

Also update the `updateTask` function's type to include `containerName`:

```typescript
    containerName: string | null;
```

- [ ] **Step 4: Add iproute2 to agent Dockerfile**

In `Dockerfile.agent`, add `iproute2` to the apt-get install line:

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    iproute2 \
    && rm -rf /var/lib/apt/lists/*
```

- [ ] **Step 5: Verify build**

```bash
rm -f local.db && pnpm build
```

- [ ] **Step 6: Commit**

```bash
git add docker-compose.yml src/lib/docker/container-manager.ts src/lib/orchestrator/turn-manager.ts Dockerfile.agent src/db/schema.ts
git commit -m "feat: join agent containers to named network, store container name"
```

---

### Task 3: Port scanner

**Files:**
- Create: `src/lib/orchestrator/port-scanner.ts`
- Create: `src/lib/orchestrator/__tests__/port-scanner.test.ts`

- [ ] **Step 1: Write port scanner tests**

Create `src/lib/orchestrator/__tests__/port-scanner.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseListeningPorts } from "../port-scanner";

describe("parseListeningPorts", () => {
  it("parses ss output with listening ports", () => {
    const output = [
      "State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process",
      "LISTEN 0      511          0.0.0.0:3000      0.0.0.0:*    users:((\"node\",pid=123,fd=20))",
      "LISTEN 0      511             [::]:3000         [::]:*    users:((\"node\",pid=123,fd=21))",
    ].join("\n");

    const ports = parseListeningPorts(output);
    expect(ports).toEqual([3000]);
  });

  it("returns empty array for no listeners", () => {
    const output = "State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process\n";
    expect(parseListeningPorts(output)).toEqual([]);
  });

  it("deduplicates IPv4 and IPv6 listeners on same port", () => {
    const output = [
      "State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process",
      "LISTEN 0      511          0.0.0.0:5173      0.0.0.0:*",
      "LISTEN 0      511             [::]:5173         [::]:*",
      "LISTEN 0      511          0.0.0.0:24678      0.0.0.0:*",
    ].join("\n");

    const ports = parseListeningPorts(output);
    expect(ports).toEqual([5173, 24678]);
  });

  it("prioritises common dev server ports", () => {
    const output = [
      "State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process",
      "LISTEN 0      511          0.0.0.0:24678      0.0.0.0:*",
      "LISTEN 0      511          0.0.0.0:3000       0.0.0.0:*",
    ].join("\n");

    const ports = parseListeningPorts(output);
    // 3000 should come first (common dev port)
    expect(ports[0]).toBe(3000);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/lib/orchestrator/__tests__/port-scanner.test.ts
```

- [ ] **Step 3: Implement port scanner**

Create `src/lib/orchestrator/port-scanner.ts`:

```typescript
import type { RunningContainer } from "../docker/container-manager";

/** Common dev server ports — prioritised when multiple ports detected */
const DEV_PORTS = new Set([3000, 3001, 4173, 5173, 8000, 8080]);

/**
 * Parse `ss -tlnp` output to extract listening port numbers.
 * Deduplicates IPv4/IPv6 listeners on the same port.
 */
export function parseListeningPorts(output: string): number[] {
  const ports = new Set<number>();

  for (const line of output.split("\n")) {
    if (!line.includes("LISTEN")) continue;
    // Match port from "Address:Port" — handles both 0.0.0.0:3000 and [::]:3000
    const match = line.match(/:(\d+)\s/);
    if (match) {
      const port = parseInt(match[1], 10);
      if (port > 0 && port < 65536) ports.add(port);
    }
  }

  // Sort: common dev ports first, then ascending
  return [...ports].sort((a, b) => {
    const aIsCommon = DEV_PORTS.has(a) ? 0 : 1;
    const bIsCommon = DEV_PORTS.has(b) ? 0 : 1;
    if (aIsCommon !== bIsCommon) return aIsCommon - bIsCommon;
    return a - b;
  });
}

/**
 * Scan a running container for listening TCP ports.
 * Returns the list of detected ports (prioritised by common dev server ports).
 */
export async function scanPorts(running: RunningContainer): Promise<number[]> {
  try {
    const exec = await running.container.exec({
      Cmd: ["ss", "-tlnp"],
      AttachStdout: true,
      AttachStderr: true,
    });

    const stream = await exec.start({});
    const chunks: Buffer[] = [];

    await new Promise<void>((resolve) => {
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", resolve);
      // Timeout after 5s
      setTimeout(resolve, 5000);
    });

    const output = Buffer.concat(chunks).toString();
    return parseListeningPorts(output);
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/lib/orchestrator/__tests__/port-scanner.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/orchestrator/port-scanner.ts src/lib/orchestrator/__tests__/port-scanner.test.ts
git commit -m "feat: add port scanner for detecting container dev servers"
```

---

### Task 4: Wire port scanner into turn manager

**Files:**
- Modify: `src/lib/orchestrator/turn-manager.ts`
- Modify: `src/app/api/tasks/[id]/stream/route.ts`

- [ ] **Step 1: Add port scan after each turn**

In `src/lib/orchestrator/turn-manager.ts`, import the port scanner:

```typescript
import { scanPorts } from "./port-scanner";
```

Add a `scanForDevServer` function:

```typescript
/**
 * Scan for dev server ports after a turn completes.
 * Retries once after 3s if no ports found (dev server may be starting).
 */
async function scanForDevServer(taskId: string, running: RunningContainer): Promise<void> {
  let ports = await scanPorts(running);

  if (ports.length === 0) {
    // Retry after delay — dev server may still be booting
    await new Promise((r) => setTimeout(r, 3000));
    ports = await scanPorts(running);
  }

  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!task) return;

  const newPort = ports.length > 0 ? ports[0] : null;
  const currentPort = task.devPort ?? null;

  if (newPort !== currentPort) {
    updateTask(taskId, { devPort: newPort });
    if (newPort && !currentPort) {
      insertSystemMessage(taskId, `Dev server detected on port ${newPort}`);
    } else if (!newPort && currentPort) {
      insertSystemMessage(taskId, `Dev server on port ${currentPort} stopped`);
    }
  }
}
```

Add `devPort` to the `updateTask` type:

```typescript
    devPort: number | null;
```

Call `scanForDevServer` after each turn — in `startTask` after `runPostTurnCommitAndPush`, and in `processQueuedMessages` after `runPostTurnCommitAndPush`:

```typescript
    // Scan for dev server after turn
    await scanForDevServer(taskId, running);
```

- [ ] **Step 2: Add devPort to SSE taskStatus event**

In `src/app/api/tasks/[id]/stream/route.ts`, update the taskStatus send block to include `devPort`:

```typescript
          send(
            {
              containerStatus: cs,
              status: ts,
              totalCostUsd: task.totalCostUsd ?? 0,
              devPort: task.devPort ?? null,
            },
            "taskStatus"
          );
```

Also track `lastDevPort` to detect changes:

```typescript
    let lastDevPort: number | null = null;
```

Add `devPort` to the change detection condition:

```typescript
        const dp = task.devPort ?? null;
        if (cs !== lastContainerStatus || ts !== lastTaskStatus || dp !== lastDevPort) {
          lastContainerStatus = cs;
          lastTaskStatus = ts;
          lastDevPort = dp;
```

- [ ] **Step 3: Verify build**

```bash
rm -f local.db && pnpm build
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/orchestrator/turn-manager.ts src/app/api/tasks/\[id\]/stream/route.ts
git commit -m "feat: scan for dev server ports after each turn, push via SSE"
```

---

## Chunk 2: Proxy Route + WebSocket

### Task 5: HTTP proxy route

**Files:**
- Create: `src/app/api/tasks/[id]/preview/[...path]/route.ts`

- [ ] **Step 1: Create the proxy route**

Create `src/app/api/tasks/[id]/preview/[...path]/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { db } from "@/db";
import { tasks } from "@/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

async function proxyRequest(
  request: Request,
  taskId: string,
  path: string
): Promise<Response> {
  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();

  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  if (!task.devPort || !task.containerName) {
    return NextResponse.json(
      { error: "No dev server running" },
      { status: 503 }
    );
  }

  const targetUrl = `http://${task.containerName}:${task.devPort}/${path}`;

  try {
    // Forward the request to the container
    const headers = new Headers(request.headers);
    headers.set("Host", `${task.containerName}:${task.devPort}`);
    headers.delete("connection");

    const proxyRes = await fetch(targetUrl, {
      method: request.method,
      headers,
      body: request.method !== "GET" && request.method !== "HEAD"
        ? request.body
        : undefined,
      redirect: "manual",
    });

    // Build response headers, stripping iframe-blocking headers
    const responseHeaders = new Headers(proxyRes.headers);
    responseHeaders.delete("x-frame-options");
    responseHeaders.delete("content-security-policy");

    // For HTML responses, inject <base> tag for asset path resolution
    const contentType = responseHeaders.get("content-type") ?? "";
    if (contentType.includes("text/html")) {
      const html = await proxyRes.text();
      const baseTag = `<base href="/api/tasks/${taskId}/preview/">`;
      // Insert after <head> or at the start of the document
      const modified = html.includes("<head>")
        ? html.replace("<head>", `<head>${baseTag}`)
        : html.includes("<head ")
          ? html.replace(/<head\s[^>]*>/, `$&${baseTag}`)
          : `${baseTag}${html}`;

      return new Response(modified, {
        status: proxyRes.status,
        headers: responseHeaders,
      });
    }

    return new Response(proxyRes.body, {
      status: proxyRes.status,
      headers: responseHeaders,
    });
  } catch {
    return NextResponse.json(
      { error: "Dev server unavailable" },
      { status: 502 }
    );
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; path: string[] }> }
) {
  const { id, path } = await params;
  return proxyRequest(request, id, path?.join("/") ?? "");
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; path: string[] }> }
) {
  const { id, path } = await params;
  return proxyRequest(request, id, path?.join("/") ?? "");
}
```

- [ ] **Step 2: Verify build**

```bash
rm -f local.db && pnpm build
```

- [ ] **Step 3: Commit**

```bash
git add src/app/api/tasks/\[id\]/preview/
git commit -m "feat: add HTTP proxy route for container dev servers"
```

---

### Task 6: Custom server wrapper with WebSocket proxy

**Files:**
- Create: `custom-server.js`
- Modify: `Dockerfile`

- [ ] **Step 1: Create custom-server.js**

Create `custom-server.js` at the project root:

```javascript
const http = require("http");
const net = require("net");
const path = require("path");
const url = require("url");

// Load Next.js standalone server handler
const nextHandler = require(path.join(__dirname, "server.js"));

// Regex to match preview WebSocket upgrade paths
const PREVIEW_PATH_RE = /^\/api\/tasks\/([^/]+)\/preview\/(.*)/;

// Import DB access for looking up task container info
// In standalone mode, the Next.js server.js sets up the handler.
// We create our own HTTP server and forward requests to it.

const server = http.createServer((req, res) => {
  // Let Next.js handle all HTTP requests
  nextHandler(req, res);
});

server.on("upgrade", (req, socket, head) => {
  const parsed = url.parse(req.url || "");
  const match = (parsed.pathname || "").match(PREVIEW_PATH_RE);

  if (!match) {
    // Not a preview WebSocket — let Next.js handle it (e.g., HMR for the app itself)
    // Next.js standalone doesn't handle upgrades by default, so just destroy
    socket.destroy();
    return;
  }

  const taskId = match[1];
  const targetPath = "/" + (match[2] || "");

  // Look up task from DB to get containerName and devPort
  // Use a simple synchronous DB read since we need it immediately
  let containerName, devPort;
  try {
    const Database = require("better-sqlite3");
    const dbPath = process.env.DATABASE_URL || "local.db";
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare("SELECT container_name, dev_port FROM tasks WHERE id = ?").get(taskId);
    db.close();

    if (!row || !row.container_name || !row.dev_port) {
      socket.destroy();
      return;
    }
    containerName = row.container_name;
    devPort = row.dev_port;
  } catch {
    socket.destroy();
    return;
  }

  // Connect to the container's dev server
  const proxySocket = net.connect(devPort, containerName, () => {
    // Reconstruct the HTTP upgrade request to send to the container
    const reqPath = targetPath + (parsed.search || "");
    let rawReq = `${req.method} ${reqPath} HTTP/1.1\r\n`;

    // Forward headers, rewriting Host
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const key = req.rawHeaders[i];
      const val = req.rawHeaders[i + 1];
      if (key.toLowerCase() === "host") {
        rawReq += `Host: ${containerName}:${devPort}\r\n`;
      } else {
        rawReq += `${key}: ${val}\r\n`;
      }
    }
    rawReq += "\r\n";

    proxySocket.write(rawReq);
    if (head.length > 0) proxySocket.write(head);

    // Pipe bidirectionally
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
  });

  proxySocket.on("error", () => socket.destroy());
  socket.on("error", () => proxySocket.destroy());
  proxySocket.on("close", () => socket.destroy());
  socket.on("close", () => proxySocket.destroy());
});

const port = parseInt(process.env.PORT || "3000", 10);
const hostname = process.env.HOSTNAME || "0.0.0.0";

server.listen(port, hostname, () => {
  console.log(`Custom server listening on http://${hostname}:${port}`);
});
```

**Important note for the implementer:** The Next.js standalone `server.js` normally creates its own HTTP server and starts listening. We need to prevent that and instead get just the request handler. Check the standalone `server.js` — it typically calls `app.prepare().then(() => { ... })`. We may need to modify the approach:

- **Option A:** If standalone `server.js` exports a handler or can be `require`d without starting a listener, use it directly.
- **Option B:** If standalone `server.js` auto-starts, set `PORT` to a different value (e.g., 3001), let it start, and proxy from our custom server on port 3000 to Next.js on 3001 for regular requests. WebSocket upgrades on preview paths go directly to containers.

The implementer should check how `next start` / standalone `server.js` works and adjust accordingly. Option B is the simpler fallback if Option A isn't straightforward.

- [ ] **Step 2: Update Dockerfile to copy and use custom-server.js**

In `Dockerfile`, add a COPY for custom-server.js and change the CMD:

After the line `COPY --from=build /app/Dockerfile.agent ./Dockerfile.agent`:

```dockerfile
COPY --from=build /app/custom-server.js ./custom-server.js
```

Change the CMD:

```dockerfile
CMD ["node", "custom-server.js"]
```

- [ ] **Step 3: Verify build**

```bash
rm -f local.db && pnpm build
```

- [ ] **Step 4: Commit**

```bash
git add custom-server.js Dockerfile
git commit -m "feat: add custom server wrapper with WebSocket proxy for HMR"
```

---

## Chunk 3: UI — Preview Pane and Responsive Layout

### Task 7: Preview pane component

**Files:**
- Create: `src/components/preview-pane.tsx`

- [ ] **Step 1: Create the preview pane component**

Create `src/components/preview-pane.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

interface PreviewPaneProps {
  taskId: string;
  devPort: number | null;
  /** Called when a tool_use message arrives — triggers fallback reload */
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

  const previewUrl = `/api/tasks/${taskId}/preview/`;

  const reload = useCallback(() => {
    if (iframeRef.current) {
      iframeRef.current.src = previewUrl;
      setStatus("loading");
    }
  }, [previewUrl]);

  // Handle iframe load/error
  const handleLoad = useCallback(() => {
    setStatus("active");
  }, []);

  const handleError = useCallback(() => {
    setStatus("error");
  }, []);

  // Update status when devPort changes
  useEffect(() => {
    if (devPort) {
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
```

- [ ] **Step 2: Verify build**

```bash
rm -f local.db && pnpm build
```

- [ ] **Step 3: Commit**

```bash
git add src/components/preview-pane.tsx
git commit -m "feat: add preview pane component with iframe and fallback reload"
```

---

### Task 8: Responsive layout — tabs on mobile, split on desktop

**Files:**
- Modify: `src/components/task-chat.tsx`
- Modify: `src/components/task-stream.tsx`

- [ ] **Step 1: Update TaskStream to expose messages for activity detection**

In `src/components/task-stream.tsx`, add an `onMessage` callback prop so the parent can detect agent file activity:

Add to `TaskStreamProps`:

```typescript
  onMessage?: (msg: Message) => void;
```

In the SSE `message` handler, call `onMessage` after updating state:

```typescript
      setMessages((prev) => {
        // ... existing update logic
      });
      onMessage?.(msg);  // Notify parent of new message
```

- [ ] **Step 2: Update TaskChat with devPort state and responsive layout**

Replace `src/components/task-chat.tsx` with the responsive tabbed/split layout. The key changes:

- Track `devPort` from SSE taskStatus events
- Track `lastActivityTimestamp` from tool_use messages
- On mobile (< 1024px): show tabs when `devPort` is set
- On desktop (≥ 1024px): show side-by-side split when `devPort` is set

Update `TaskStatus` type to include `devPort`:

```typescript
type TaskStatusUpdate = {
  containerStatus: string | null;
  status: string;
  totalCostUsd: number;
  devPort: number | null;
};
```

Add state for `devPort`, `activeTab`, and `lastActivityTimestamp`:

```typescript
  const [devPort, setDevPort] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<"chat" | "preview">("chat");
  const [lastActivity, setLastActivity] = useState<number>(0);
```

Update `handleStatusChange` to capture `devPort`:

```typescript
  const handleStatusChange = useCallback((status: TaskStatusUpdate) => {
    setTaskStatus(status);
    if (status.devPort !== undefined) {
      setDevPort(status.devPort);
    }
  }, []);
```

Add a message handler for activity detection:

```typescript
  const handleMessage = useCallback((msg: { type: string; content: string }) => {
    // Trigger preview reload on file-changing tool_use messages
    if (msg.type === "tool_use") {
      try {
        const parsed = JSON.parse(msg.content);
        if (["Write", "Edit", "Bash"].includes(parsed.tool)) {
          setLastActivity(Date.now());
        }
      } catch {}
    }
  }, []);
```

Render the layout with responsive tabs/split. The full JSX should be:

- If no devPort: render current chat-only layout (no changes)
- If devPort on mobile: render tab bar + conditional chat/preview
- If devPort on desktop: render side-by-side with `lg:flex-row` breakpoint

Use Tailwind responsive classes: the tab bar is visible on small screens (`lg:hidden`), and on large screens both panes show side by side (`hidden lg:flex`).

- [ ] **Step 3: Verify build**

```bash
rm -f local.db && pnpm build
```

- [ ] **Step 4: Run all tests**

```bash
npx vitest run
```

- [ ] **Step 5: Commit**

```bash
git add src/components/task-chat.tsx src/components/task-stream.tsx
git commit -m "feat: responsive preview layout — tabs on mobile, split on desktop"
```

---

## Chunk 4: Deploy and Test

### Task 9: Generate migration and deploy

**Files:**
- Generated: `drizzle/XXXX_migration.sql`

- [ ] **Step 1: Verify all tests pass**

```bash
npx vitest run
```

- [ ] **Step 2: Verify build**

```bash
rm -f local.db && pnpm build
```

- [ ] **Step 3: Push and deploy**

```bash
git push
```

Wait for GitHub Actions deploy to complete. Verify with:

```bash
gh run list --limit 1
gh run watch <run-id>
```

- [ ] **Step 4: End-to-end test on VPS**

Create a task that starts a dev server:

```bash
curl -sf -X POST https://interludes.co.uk/api/tasks \
  -H 'Content-Type: application/json' \
  -d '{"title": "Run pnpm dev to start the development server and keep it running", "projectId": "PROJECT_ID"}'
```

After the agent runs `pnpm dev`:

1. Check that `devPort` appears in the task API response
2. Check that the SSE stream sends `devPort` in `taskStatus` events
3. Visit `https://interludes.co.uk/api/tasks/{taskId}/preview/` — should show the dev server output
4. Open the task detail page on mobile — should show Preview tab
5. Verify WebSocket HMR works: send a follow-up message asking the agent to change a file, watch for live update in preview

- [ ] **Step 5: Fix any issues found during testing**

Apply lessons from Phase 2b: test against real output, add tests for edge cases found.
