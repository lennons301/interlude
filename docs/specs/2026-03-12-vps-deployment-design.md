# VPS Deployment — Design Spec

## Overview

Deploy Interlude to a Hetzner VPS to unblock end-to-end testing of Phase 2a (agent orchestration). WSL2 cannot handle OAuth callbacks or reliable Docker networking, so we need a real Linux host with a public IP and domain.

This phase was originally Phase 5 in the roadmap. It's being pulled forward because it's now a prerequisite for testing the agent execution pipeline (OAuth for GitHub/Claude, webhook callbacks, Docker container networking).

## Infrastructure

| Component | Choice | Reasoning |
|-----------|--------|-----------|
| VPS | Hetzner CX22 (2 vCPU, 4GB RAM, 40GB disk) | Cheapest option (~EUR4.50/mo), sufficient for single-user + agent containers |
| OS | Ubuntu 24.04 LTS | Stable, well-supported, Docker installs cleanly |
| Domain | `interlude.dev` (or fallback: `useinterlude.dev`, `interlude.app`) | Project-specific, clean for OAuth callback URLs |
| Reverse proxy | Caddy | Automatic HTTPS, zero-maintenance SSL via Let's Encrypt |
| Deployment | GitHub Actions -> SSH -> rebuild | Zero-friction after initial setup |

## Architecture

```
                    Internet
                       |
                  [Hetzner VPS]
                       |
                    [Caddy]  :443 (HTTPS, auto-cert)
                       |
                   [Next.js]  :3000 (app container)
                       |
              /var/run/docker.sock (mounted)
                       |
              [Agent containers]  (created on demand by orchestrator)
```

All components run as Docker containers via Docker Compose, except Docker itself which runs on the host.

## Docker Compose Stack

Three services:

### 1. `caddy` — Reverse Proxy
- Official Caddy image
- Ports 80 and 443 exposed to host
- Caddyfile mounted from repo
- Named volumes: `caddy_data` at `/data` (certs), `caddy_config` at `/config` (auto-config)
- Receives `DOMAIN` env var from `.env` (shared with app service via `env_file: .env`)

### 2. `app` — Next.js Application
- Custom Dockerfile (multi-stage build: install deps, build, run)
- Port 3000 (internal only, Caddy proxies to it)
- Docker socket mounted read-write (`/var/run/docker.sock`)
- SQLite DB volume mounted at `/data`
- Environment variables from `.env` file on VPS

### 3. Agent containers (dynamic)
- Created by the orchestrator via dockerode through the mounted socket
- These are sibling containers on the host, not nested
- Same as current Phase 2a design — no changes needed to orchestrator code

## File Structure

```
Dockerfile                  — Multi-stage build for the Next.js app
docker-compose.yml          — Production stack (Caddy + app)
docker-compose.dev.yml      — Local dev override (optional, later)
Caddyfile                   — Reverse proxy config
.github/workflows/deploy.yml — GitHub Actions deployment workflow
```

## Dockerfile (Next.js App)

Multi-stage build with `NODE_ENV=production` and Next.js `output: 'standalone'`:

1. **deps** — Install pnpm dependencies
2. **build** — `NODE_ENV=production pnpm build` (Next.js standalone output)
3. **run** — Copy standalone output, `drizzle/` migrations, and `Dockerfile.agent`

The run stage must include these files beyond the standard Next.js standalone output:
- `drizzle/` — migration files, needed by the auto-migration on startup (`src/db/index.ts`)
- `Dockerfile.agent` — needed by the image builder (`src/lib/docker/image-builder.ts` uses `process.cwd()` to locate it)

Use BuildKit cache mounts for `pnpm install` to avoid re-downloading all dependencies on every deploy:
```dockerfile
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile
```

The SQLite database file is NOT baked into the image. It lives in a Docker volume mounted at `/data`. **Code change required:** `src/db/index.ts` currently hardcodes `local.db` as the database path. This must be updated to read `DATABASE_URL` from the environment, falling back to `local.db` for local development:
```typescript
const dbPath = process.env.DATABASE_URL ?? "local.db";
const sqlite = new Database(dbPath);
```

Next.js config change: add `output: 'standalone'` to `next.config.ts` to produce a minimal self-contained build (~100MB vs ~500MB+ with full `node_modules`).

## Caddy Configuration

```
{$DOMAIN:interlude.dev} {
    reverse_proxy app:3000
}
```

Caddy automatically:
- Provisions a Let's Encrypt certificate for the domain
- Renews it before expiry
- Redirects HTTP to HTTPS
- Handles TLS termination

The domain is configurable via environment variable so we can adjust if the preferred domain isn't available.

## GitHub Actions Deployment

Workflow triggers on push to `main`:

1. SSH into VPS using a deploy key (stored as GitHub Actions secret)
2. `cd /opt/interlude && git pull origin main`
3. `docker compose up -d --build`

Docker Compose rebuilds only layers that changed (BuildKit layer caching). The app container restarts with the new build; Caddy and volumes are unaffected.

After deploy, the workflow verifies the container is healthy:
4. `docker compose ps` to confirm containers are running
5. `curl -sf http://localhost:3000/api/init` as a basic health check

If the health check fails, the workflow logs `docker compose logs app` for debugging. No automatic rollback for now — a single-user tool can tolerate manual intervention.

Secrets needed in GitHub Actions:
- `VPS_HOST` — IP or hostname of the VPS
- `VPS_SSH_KEY` — Private key for SSH access
- `VPS_USER` — SSH user (e.g., `deploy`)

## Environment Variables on VPS

Stored in `/opt/interlude/.env` (not in git). Both the `caddy` and `app` services read this file via `env_file: .env` in Docker Compose.

```
# Domain (used by both Caddy and the app)
DOMAIN=interlude.dev

# App
DATABASE_URL=/data/interlude.db

# Agent credentials
# OAuth credentials are mounted as a file (see auth section above)
# ANTHROPIC_API_KEY is optional — only needed if NOT using OAuth
# ANTHROPIC_API_KEY=sk-ant-...
GIT_TOKEN=ghp_...
GIT_USER_NAME=Interlude Agent
GIT_USER_EMAIL=agent@interlude.dev

# Optional
KEEP_CONTAINERS=false
MAX_TURNS=50
MAX_BUDGET_USD=5.00
```

### Authentication: Claude OAuth (not API key)

The primary auth mechanism is **OAuth via Claude Pro/Max/Enterprise subscription**, avoiding separate API token costs. The credentials file (`~/.claude/.credentials.json`) is created once on the VPS via SSH tunnel, then mounted into agent containers.

**One-time OAuth setup on VPS:**

1. SSH in with port forward: `ssh -L 9999:localhost:9999 deploy@<vps-ip>`
2. Run `claude` — it prints an OAuth URL
3. Open that URL in your local browser, complete the login
4. Browser redirects to `localhost:9999`, SSH tunnel forwards it to the VPS
5. Claude Code receives the callback, saves credentials to `~/.claude/.credentials.json`

**Credential mounting in Docker Compose:**

The credentials file lives on the host at `/home/deploy/.claude/.credentials.json`. The `app` container mounts it read-write (so Claude Code can refresh tokens inside agent containers):

```yaml
volumes:
  - /home/deploy/.claude/.credentials.json:/home/node/.claude/.credentials.json:rw
```

The app container then mounts this same path into each agent container via the `Binds` config in `container-manager.ts` (already implemented).

`ANTHROPIC_API_KEY` remains supported as a fallback but is not the intended auth path — the config module already handles both (`src/lib/config.ts` requires one or the other).

## VPS Setup (One-Time)

1. Create Hetzner CX22 instance (Ubuntu 24.04)
2. SSH in, create `deploy` user with sudo
3. Harden SSH: disable password auth, install fail2ban
4. Configure UFW: allow 22, 80, 443
5. Install Docker Engine + Docker Compose plugin
6. Clone repo to `/opt/interlude`
7. Create `.env` file with GIT_TOKEN and other config
8. Point domain DNS (A record) to VPS IP
9. `docker compose up -d` — Caddy provisions SSL once DNS propagates
10. Set up GitHub Actions secrets for deploy workflow
11. **Claude OAuth setup:** SSH in with port forward (`ssh -L 9999:localhost:9999`), run `claude`, complete OAuth in local browser, verify credentials file created
12. Verify end-to-end: create a project, create a task, trigger agent run

## Database Considerations

SQLite in a Docker volume is fine for a single-user tool:
- WAL mode handles concurrent reads from SSE streams
- No external database to manage or pay for
- Volume persists across container rebuilds
- Backup strategy (later): cron job copies DB file to object storage

The volume mount means `docker compose down && docker compose up` preserves all data. Only `docker volume rm` would destroy it.

## Security

- SSH key auth only (no password login, `PasswordAuthentication no` in sshd_config)
- Install `fail2ban` for SSH brute-force protection
- UFW firewall: allow 22, 80, 443 only
- Docker socket access is the main risk — the app container has root-equivalent access to the host via the socket. Acceptable for a single-user self-hosted tool. For multi-user, this would need rethinking.
- Agent containers run as non-root (`agent` user in Dockerfile.agent)
- API keys never leave the VPS — they're in `.env` on disk, injected into containers at runtime

## Code Changes Required (Pre-Deployment)

These changes to the existing codebase are needed before deployment works:

1. **`src/db/index.ts`** — Read `DATABASE_URL` from environment instead of hardcoding `local.db`. Fall back to `local.db` for local dev.
2. **`next.config.ts`** — Add `output: 'standalone'` for minimal production builds.

Note: `src/lib/config.ts` already handles both auth paths correctly — it accepts either `ANTHROPIC_API_KEY` or the OAuth credentials file, and throws only if neither is present.

## What This Phase Does NOT Include

- Container resource limits (CPU/memory caps) — add when needed
- Automated backups — add when there's data worth backing up
- Monitoring/alerting — add when running in anger
- Multi-user auth — single-user tool for now
- `docker-compose.dev.yml` for local development — can add if useful later

## Relation to Other Phases

This deployment unblocks:
- **Phase 2a testing** — OAuth callbacks, Docker networking, end-to-end agent execution
- **Phase 2b** — SSE streaming over real HTTP
- **Phase 2c** — Container dev server proxy with real DNS/ports
- **Phase 3** — GitHub webhooks need a publicly reachable endpoint
- **Phase 4** — Bot callbacks need a real URL
