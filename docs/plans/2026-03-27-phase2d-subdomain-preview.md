# Phase 2d: Subdomain-Based Live Preview — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each task its own subdomain (`task-{shortId}.interludes.co.uk`) so the proxied dev server owns a real browser origin. Auth, cookies, client-side routing, and asset loading all work without HTML rewriting or path munging. Projects run unmodified — Interlude is invisible to the app inside the container.

**Architecture:** Caddy terminates TLS for wildcard subdomains via `on_demand_tls` (HTTP-01 challenge, no DNS provider API needed). All subdomain traffic forwards to the app's custom server on port 3000. The custom server detects subdomains from the `Host` header and proxies HTTP + WebSocket directly to the container using a Docker network alias matching the subdomain. Old path-based proxy remains as fallback for local dev.

**Tech Stack:** Caddy `on_demand_tls`, Docker network aliases, better-sqlite3 (existing custom server lookup), net (existing WebSocket proxy).

**Builds on:** Phase 2c (Live Preview) — port scanning, container networking, preview pane UI, WebSocket proxy.

---

## File Structure

```
Caddyfile                                            — MODIFY: add wildcard subdomain block + on_demand_tls
custom-server.js                                     — MODIFY: add subdomain detection for HTTP + WebSocket
src/
  app/
    api/
      internal/
        validate-subdomain/route.ts                  — NEW: Caddy cert validation endpoint
      tasks/[id]/
        preview/[[...path]]/route.ts                 — KEEP: local dev fallback (no changes)
        stream/route.ts                              — MODIFY: include previewSubdomain in SSE events
    tasks/[id]/
      page.tsx                                       — MODIFY: pass domain env var to TaskChat
  components/
    preview-pane.tsx                                  — MODIFY: use subdomain URL when available
    task-chat.tsx                                     — MODIFY: track previewSubdomain from SSE
  db/
    schema.ts                                        — MODIFY: add previewSubdomain column
  lib/
    docker/
      container-manager.ts                           — MODIFY: generate subdomain, add network alias
    orchestrator/
      turn-manager.ts                                — MODIFY: store previewSubdomain in DB
drizzle/
  XXXX_migration.sql                                 — GENERATED
```

---

## Chunk 1: DNS + Schema Foundation

### 1.1 Add Wildcard DNS Record
- [ ] In Squarespace DNS for `interludes.co.uk`, add A record: Host = `*`, Value = `178.104.72.109`
- [ ] Verify propagation: `dig +short anything.interludes.co.uk` → `178.104.72.109`
- [ ] If Squarespace doesn't support wildcard A records, migrate DNS to Cloudflare (free tier) first

### 1.2 Add `previewSubdomain` Column
- [ ] In `src/db/schema.ts`, add to tasks table:
  ```typescript
  previewSubdomain: text("preview_subdomain"),
  ```
- [ ] Run `npx drizzle-kit push` to apply migration

### 1.3 Add `domain` to Config
- [ ] In `src/lib/config.ts`, add to `AppConfig`:
  ```typescript
  domain: string | null;
  ```
- [ ] Read from `process.env.DOMAIN ?? null`

**Verify:** Build passes, migration applied, no runtime changes yet.

**Commit:** `feat: add previewSubdomain schema and domain config for subdomain preview`

---

## Chunk 2: Container Subdomain Identity

### 2.1 Generate Subdomain + Network Alias
- [ ] In `src/lib/docker/container-manager.ts`, in `createWorkspaceContainer()`:
  - Derive subdomain: `task-${options.taskId.slice(-8).toLowerCase()}`
  - Add Docker network alias so container is resolvable by subdomain name:
    ```typescript
    NetworkingConfig: {
      EndpointsConfig: {
        interlude: { Aliases: [previewSubdomain] }
      }
    }
    ```
  - Add `previewSubdomain` to `RunningContainer` interface and return value

### 2.2 Store Subdomain in DB
- [ ] In `src/lib/orchestrator/turn-manager.ts`, in `startTask()`:
  - After container creation, save `previewSubdomain` to DB alongside `containerId` and `containerName`

### 2.3 Include Subdomain in SSE Stream
- [ ] In `src/app/api/tasks/[id]/stream/route.ts`:
  - Add `previewSubdomain` to the `taskStatus` event payload (alongside existing `devPort`)

**Verify:** Create a task, check DB has `preview_subdomain` populated. SSE stream includes it.

**Commit:** `feat: generate preview subdomain identity for agent containers`

---

## Chunk 3: Caddy Wildcard TLS

### 3.1 Cert Validation Endpoint
- [ ] Create `src/app/api/internal/validate-subdomain/route.ts`:
  - Caddy sends `GET ?domain=task-xxx.interludes.co.uk`
  - Extract subdomain prefix from the domain parameter
  - Look up in tasks table: must exist and have a `devPort`
  - Return 200 if valid, 403 otherwise
  - This prevents cert provisioning for arbitrary subdomains

### 3.2 Update Caddyfile
- [ ] Replace `Caddyfile` contents:
  ```caddyfile
  {
      on_demand_tls {
          ask http://app:3000/api/internal/validate-subdomain
      }
  }

  {$DOMAIN:localhost} {
      reverse_proxy app:3000
  }

  *.{$DOMAIN:localhost} {
      tls {
          on_demand
      }
      reverse_proxy app:3000
  }
  ```

**Verify:** Deploy to VPS. `curl -v https://task-test.interludes.co.uk` — should attempt TLS but get 403 from validation endpoint (no matching task). Main domain still works.

**Commit:** `feat: Caddy wildcard TLS with on_demand cert provisioning`

---

## Chunk 4: Custom Server Subdomain Proxy

### 4.1 Add Subdomain Detection + HTTP Proxy
- [ ] In `custom-server.js`, at the top:
  ```javascript
  const DOMAIN = process.env.DOMAIN;
  const SUBDOMAIN_RE = DOMAIN
    ? new RegExp(`^([a-z0-9-]+)\\.${DOMAIN.replace(/\./g, '\\.')}(:\\d+)?$`)
    : null;
  ```
- [ ] Add `lookupTaskBySubdomain()` function querying tasks by `preview_subdomain`
- [ ] In the HTTP handler, before the Next.js proxy:
  - Check `Host` header against `SUBDOMAIN_RE`
  - If match, look up task, proxy directly to container (subdomain = Docker hostname, port = `dev_port`)
  - No HTML rewriting — pass response through as-is
  - If no match, fall through to existing Next.js proxy

### 4.2 Add Subdomain WebSocket Proxy
- [ ] In the `upgrade` handler, before the existing path-based check:
  - Same subdomain detection from `Host` header
  - Proxy WebSocket to container using subdomain as Docker hostname
  - Rewrite `Host` header to `{subdomain}:{port}`
  - If no match, fall through to existing path-based + Next.js proxy

**Verify:** With a running task + dev server, `curl https://task-{id}.interludes.co.uk` returns the container's page with no rewriting. WebSocket connections upgrade successfully.

**Commit:** `feat: custom server subdomain routing for HTTP and WebSocket`

---

## Chunk 5: Frontend — Subdomain Preview URLs

### 5.1 Task Page — Pass Domain
- [ ] In `src/app/tasks/[id]/page.tsx`:
  - Read `process.env.DOMAIN ?? null`
  - Pass as prop to `TaskChat`

### 5.2 TaskChat — Track Subdomain
- [ ] In `src/components/task-chat.tsx`:
  - Accept `domain` prop
  - Track `previewSubdomain` from SSE `taskStatus` events (same as `devPort`)
  - Pass both to `PreviewPane`

### 5.3 PreviewPane — Subdomain URL
- [ ] In `src/components/preview-pane.tsx`:
  - Accept `previewSubdomain` and `domain` props
  - URL logic:
    ```typescript
    const previewUrl = previewSubdomain && domain
      ? `https://${previewSubdomain}.${domain}`
      : `/api/tasks/${taskId}/preview`;
    ```
  - "Open" button opens subdomain URL in new tab
  - Remove `bg-white` from iframe (the app controls its own background)

**Verify:** End-to-end: create task → agent starts dev server → preview pane loads at subdomain URL → CSS works, login works, client-side routing works.

**Commit:** `feat: preview pane uses subdomain URLs with path-based fallback`

---

## Chunk 6: Code Cleanup + Review

The preview proxy went through multiple debugging iterations (HTML rewriting, redirect rewriting, base tags, asset path regex). Now that subdomain routing makes most of that unnecessary, clean up the accumulated complexity.

### 6.1 Review Proxy Route
- [ ] Read `src/app/api/tasks/[id]/preview/[[...path]]/route.ts`
- [ ] Remove the HTML rewriting logic (regex for src/href/action, redirect Location rewriting) — this code was a workaround for the iframe proxy approach and is no longer needed for production
- [ ] Keep the basic proxy functionality intact as a local dev fallback
- [ ] Simplify to: fetch from container, pass through response, strip iframe-blocking headers only

### 6.2 Review Custom Server
- [ ] Read `custom-server.js` end to end
- [ ] Verify no dead code paths from debugging iterations
- [ ] Ensure the path-based preview proxy (`PREVIEW_PATH_RE`) still works cleanly as local fallback

### 6.3 Review Preview Pane
- [ ] Check `src/components/preview-pane.tsx` for dead state or unused props
- [ ] Remove any debugging artefacts

### 6.4 General Sweep
- [ ] Grep for `TODO`, `HACK`, `FIXME`, `debug`, `console.log` in modified files
- [ ] Remove any temporary diagnostic code left from prior debugging sessions
- [ ] Verify `pnpm build` passes clean
- [ ] Verify `pnpm lint` passes clean

**Commit:** `refactor: simplify preview proxy after subdomain routing, remove workarounds`

---

## Chunk 7: Deploy + Verify

- [ ] Ensure `DOMAIN=interludes.co.uk` is in VPS `.env`
- [ ] Push to main, wait for CI/CD deploy
- [ ] Create a new task on lemons project
- [ ] Verify:
  - [ ] Dev server starts and `previewSubdomain` appears in SSE stream
  - [ ] Preview pane loads at `https://task-{id}.interludes.co.uk`
  - [ ] CSS/JS loads without rewriting
  - [ ] Login page renders and auth works (cookies on correct domain)
  - [ ] Client-side navigation stays on subdomain
  - [ ] WebSocket HMR works (edit file → live reload)
  - [ ] Mobile: preview tab works on phone
  - [ ] With `DOMAIN` unset locally, old `/api/tasks/{id}/preview` still works

**Commit:** n/a (verification only)

---

## Chunk 8: Update CLAUDE.md

- [ ] Update "Current Status" to "Phase 2d complete"
- [ ] Add Phase 2d entry to roadmap as done
- [ ] Add to Key Conventions:
  - Preview uses subdomain routing: `task-{shortId}.interludes.co.uk`
  - `DOMAIN` env var enables subdomain preview (unset = path-based fallback)
  - Caddy uses `on_demand_tls` for subdomain certs
  - Container network aliases match subdomain prefixes
- [ ] Note any new conventions or patterns introduced

**Commit:** `docs: mark Phase 2d complete, update conventions`
