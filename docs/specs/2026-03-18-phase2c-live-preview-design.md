# Phase 2c: Live Preview — Design Spec

## Goal

Show a live preview of the agent's dev server inside the task detail page. When an agent starts a dev server (e.g., `pnpm dev`), the preview appears automatically. The agent's edits trigger an iframe reload so you see changes quickly.

## Architecture

### Request Flow

```
Browser iframe → Caddy (HTTPS) → Next.js proxy route → Agent container:PORT
```

All preview HTTP traffic flows through a single Next.js API route that proxies to the agent's container. No port binding to the host, no DNS changes needed.

### WebSocket / HMR — Deferred

Next.js App Router route handlers operate on the Web `Request`/`Response` API and cannot handle HTTP Upgrade requests for WebSockets. True HMR proxying would require either a custom Node.js server wrapping the Next.js standalone output, or a Caddy-level WebSocket route.

**v1 approach:** No WebSocket proxying. Instead, the preview iframe reloads automatically when new agent messages arrive (indicating the agent edited files). A manual Reload button is also available. This gives near-live feedback without the complexity of WebSocket upgrade handling.

**Future:** Add WebSocket proxying via a custom server wrapper around the Next.js standalone `server.js` to enable true HMR pass-through.

### Networking

Agent containers join an explicitly named Docker network shared with the app container. This makes agent containers addressable by container name from the app (e.g., `interlude-task-{id}-{ts}:3000`).

**Changes required:**

1. Add explicit network name in `docker-compose.yml`:
   ```yaml
   networks:
     default:
       name: interlude
   ```
2. In `createWorkspaceContainer`, set `NetworkMode: "interlude"` instead of `"bridge"`.

This avoids depending on the auto-generated network name (`interlude_default`) which varies with `COMPOSE_PROJECT_NAME` and directory naming.

### Dev Server Detection

After each turn completes, run a port scan inside the agent container:

```bash
ss -tlnp | grep LISTEN
```

**Note:** The `ss` command requires `iproute2`, which is not installed in `node:22-slim`. Add `iproute2` to `Dockerfile.agent`.

Parse the output for listening ports. Common dev server ports (3000, 3001, 4173, 5173, 8000, 8080) are prioritised. If a new listening port is detected:

1. Store `devPort` on the task in the database
2. SSE pushes a `taskStatus` event with `devPort` included
3. Client shows the Preview tab

**Timing:** Dev servers may take a few seconds to start after the command returns. The port scan retries once after a 3-second delay if the initial scan finds no new ports. Additionally, a periodic scan runs every 30 seconds while the container is in `idle` state, catching servers that start slowly or crash.

If the dev server stops (port no longer listening on next scan), set `devPort` to null and push an update. The Preview tab stays visible with a "Server stopped" placeholder.

## Proxy Route

### Route: `/api/tasks/[id]/preview/[...path]`

A Next.js route handler that:

1. Looks up the task from the database to get `containerId`, `containerName`, and `devPort`
2. Forwards the request to `http://{containerName}:{devPort}/{path}`
3. Returns the response to the client

### HTTP Proxying

- Forward all HTTP methods (GET, POST, etc.)
- Copy request headers (except `Host`, which gets rewritten)
- Stream the response body back (important for large assets)
- Preserve response headers and status codes
- **Strip `X-Frame-Options` and restrictive `Content-Security-Policy: frame-ancestors`** from proxied responses — dev servers (Vite, Next.js) often set these headers which would prevent the iframe from loading
- Handle `Content-Type` correctly for HTML, JS, CSS, images, etc.

### Asset Path Resolution

Dev servers serve assets with absolute paths (e.g., `<script src="/main.js">`). Inside the iframe, these resolve against the Interlude origin, not the proxy path. To handle this:

- Inject `<base href="/api/tasks/{id}/preview/">` into proxied HTML responses. This makes relative URLs resolve through the proxy.
- **Known limitation:** Some dev servers emit absolute paths that bypass `<base>`. For most frameworks (Vite, Next.js, CRA), the `<base>` tag handles the common case. Edge cases may require opening the preview in a new tab (available via toolbar button).

### Error Handling

- Task not found → 404
- No `devPort` set → 503 with "No dev server running"
- Container unreachable → 502 with "Dev server unavailable"
- Connection timeout → 504

### Auth Note

No auth check on the proxy route — the app is currently single-user. Multi-user auth would need to verify the requesting user owns the task.

## Database Changes

Add to the `tasks` table:

```typescript
devPort: int("dev_port"),              // Port the dev server is listening on (null if none)
containerName: text("container_name"), // Docker container name for network routing
```

`containerName` is stored at container creation time (already deterministic from the existing naming pattern). The proxy route uses this to address the container on the Docker network without querying Docker on every request.

## UI Changes

### Task Detail Page — Responsive Layout

**Mobile (< 1024px): Tabbed view**

- Two tabs at the top: "Chat" and "Preview"
- Tabs only appear when `devPort` is set; before that, the page shows chat full-width as it does today
- Active tab takes full width
- Preview tab contains the iframe + a small toolbar

**Desktop (≥ 1024px): Side-by-side split**

- Chat pane on the left, preview pane on the right
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
  - Loading: "Connecting to dev server..." (retries on 502/503 since server may still be starting)
  - Active: iframe with toolbar
  - Stopped: "Dev server stopped" placeholder
  - Error: "Could not connect to dev server"

### Auto-Reload on Agent Activity

Since WebSocket HMR is deferred, the preview pane listens to the SSE message stream. When a new `tool_use` message of type `Write`, `Edit`, or `Bash` arrives, the iframe reloads after a short debounce (500ms). This gives near-live feedback tied to actual file changes.

### SSE Updates

The existing `taskStatus` SSE event already sends `containerStatus`, `status`, and `totalCostUsd`. Add `devPort` to this payload. The client watches for `devPort` changes to show/hide the preview tab.

## File Structure

```
Dockerfile.agent                       — (modify) add iproute2
docker-compose.yml                     — (modify) add explicit network name
src/
  app/
    api/
      tasks/[id]/
        preview/[...path]/route.ts     — HTTP proxy route
  components/
    preview-pane.tsx                    — iframe + toolbar + auto-reload
    task-chat.tsx                       — (modify) add tab/split responsive layout
  lib/
    docker/
      container-manager.ts             — (modify) join named network, store container name
    orchestrator/
      turn-manager.ts                  — (modify) port scan after each turn
  db/
    schema.ts                          — (modify) add devPort, containerName
drizzle/
  XXXX_migration.sql                   — generated migration
```

## Scope Boundaries

**In scope:**
- HTTP proxy route (no WebSocket)
- Port scanning after turns (with retry and periodic idle scan)
- Tabbed (mobile) + split (desktop) responsive layout
- Auto-appearing preview tab
- Auto-reload on agent file changes
- Reload and open-in-new-tab toolbar
- `<base>` tag injection for asset paths
- iframe header stripping (`X-Frame-Options`)

**Out of scope (future):**
- WebSocket/HMR proxying (requires custom server wrapper)
- Resizable split pane divider
- Multiple dev server support (only one port per task)
- Custom port configuration by user
- Preview for non-HTTP services (e.g., database)
- Responsive mode switching (mobile/tablet simulation in preview)
- Subdomain-per-task routing (cleanest asset path solution, needs wildcard DNS)
