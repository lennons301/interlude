# Phase 2c: Live Preview — Design Spec

## Goal

Show a live preview of the agent's dev server inside the task detail page. When an agent starts a dev server (e.g., `pnpm dev`), the preview appears automatically with real-time hot module reload as the agent edits files.

## Architecture

### Request Flow

```
Browser iframe → Caddy (HTTPS) → Next.js proxy route → Agent container:PORT
```

All preview traffic (HTTP + WebSocket) flows through a single Next.js API route that proxies to the agent's container. No port binding to the host, no DNS changes needed.

### Networking

Agent containers join the Docker Compose default network at creation time. This makes them addressable by container name from the app container (e.g., `interlude-task-{id}-{ts}:3000`). The container name is already set in `createWorkspaceContainer`.

**Change:** Add `NetworkMode` pointing to the compose network (e.g., `interlude_default`) instead of the default `bridge`. The app container and agent containers will share the same network.

### Dev Server Detection

After each turn completes, run a port scan inside the agent container:

```bash
ss -tlnp | grep LISTEN
```

Parse the output for listening ports. Common dev server ports (3000, 3001, 4173, 5173, 8000, 8080) are prioritised. If a new listening port is detected:

1. Store `devPort` on the task in the database
2. SSE pushes a `taskStatus` event with `devPort` included
3. Client shows the Preview tab

The port scan runs after each turn via `docker exec` in the turn manager — same pattern as the fallback commit. Cost is ~50ms per scan.

If the dev server stops (port no longer listening on next scan), set `devPort` to null and push an update. The Preview tab stays visible with a "Server stopped" placeholder.

## Proxy Route

### Route: `/api/tasks/[id]/preview/[...path]`

A Next.js route handler that:

1. Looks up the task from the database to get `containerId` and `devPort`
2. Resolves the container name from Docker
3. Forwards the request to `http://{containerName}:{devPort}/{path}`
4. Returns the response to the client

### HTTP Proxying

- Forward all HTTP methods (GET, POST, etc.)
- Copy request headers (except `Host`, which gets rewritten)
- Stream the response body back (important for large assets)
- Preserve response headers and status codes
- Handle `Content-Type` correctly for HTML, JS, CSS, images, etc.

### WebSocket Proxying

When the request includes `Upgrade: websocket` headers (HMR connections from Vite, Next.js, webpack):

1. Detect the upgrade request
2. Open a WebSocket connection to the container's dev server
3. Pipe data bidirectionally between client and container
4. Handle connection close in both directions

This enables real-time hot module reload — when the agent edits a file, the change appears instantly in the preview iframe.

### Error Handling

- Task not found → 404
- No `devPort` set → 503 with "No dev server running"
- Container unreachable → 502 with "Dev server unavailable"
- Connection timeout → 504

## Database Changes

Add to the `tasks` table:

```typescript
devPort: int("dev_port"),          // Port the dev server is listening on (null if none)
devContainerName: text("dev_container_name"),  // Container name for proxy routing
```

`devContainerName` is stored at container creation time so the proxy route doesn't need to query Docker on every request.

## UI Changes

### Task Detail Page — Responsive Layout

**Mobile (< 1024px): Tabbed view**

- Two tabs at the top: "Chat" and "Preview"
- Tabs only appear when `devPort` is set; before that, the page shows chat full-width as it does today
- Active tab takes full width
- Preview tab contains the iframe + a small toolbar

**Desktop (≥ 1024px): Side-by-side split**

- Chat pane on the left, preview pane on the right
- Resizable divider (nice to have, not required for v1)
- Preview pane only appears when `devPort` is set
- When no preview, chat takes full width (current behaviour)

### Preview Pane Component

Contains:

- **iframe** pointing at `/api/tasks/{taskId}/preview/`
- **Toolbar** with:
  - Reload button (refreshes iframe)
  - Open in new tab button (opens proxy URL directly)
  - Port indicator (shows which port, e.g., `:3000`)
- **Status states:**
  - Loading: "Connecting to dev server..."
  - Active: iframe with toolbar
  - Stopped: "Dev server stopped" placeholder
  - Error: "Could not connect to dev server"

### SSE Updates

The existing `taskStatus` SSE event already sends `containerStatus`, `status`, and `totalCostUsd`. Add `devPort` to this payload. The client watches for `devPort` changes to show/hide the preview tab.

## File Structure

```
src/
  app/
    api/
      tasks/[id]/
        preview/[...path]/route.ts    — HTTP + WebSocket proxy
  components/
    preview-pane.tsx                   — iframe + toolbar component
    task-chat.tsx                      — (modify) add tab/split layout
  lib/
    docker/
      container-manager.ts             — (modify) join compose network, store container name
    orchestrator/
      turn-manager.ts                  — (modify) port scan after each turn
  db/
    schema.ts                          — (modify) add devPort, devContainerName
drizzle/
  XXXX_migration.sql                   — generated migration
```

## Scope Boundaries

**In scope:**
- HTTP + WebSocket proxy route
- Port scanning after turns
- Tabbed (mobile) + split (desktop) responsive layout
- Auto-appearing preview tab
- Reload and open-in-new-tab toolbar

**Out of scope (future):**
- Resizable split pane divider
- Multiple dev server support (only one port per task)
- Custom port configuration by user
- Preview for non-HTTP services (e.g., database)
- Responsive mode switching (mobile/tablet simulation in preview)
