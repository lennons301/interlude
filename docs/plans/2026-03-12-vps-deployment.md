# VPS Deployment — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy Interlude to a Hetzner VPS with Caddy, Docker Compose, and GitHub Actions CI/CD so the agent orchestrator can be tested end-to-end with real OAuth and networking.

**Architecture:** Multi-stage Docker build for the Next.js app, Caddy reverse proxy for auto-HTTPS, Docker socket mounted for agent container management. GitHub Actions deploys on push to main via SSH. Claude OAuth via SSH tunnel for subscription-based auth.

**Tech Stack:** Docker, Docker Compose, Caddy, GitHub Actions, Hetzner CX22 (Ubuntu 24.04), UFW, fail2ban.

**Spec:** `docs/specs/2026-03-12-vps-deployment-design.md`

---

## File Structure

```
Dockerfile                    — Multi-stage build for the Next.js app
docker-compose.yml            — Production stack (Caddy + app)
Caddyfile                     — Reverse proxy config
.github/workflows/deploy.yml  — GitHub Actions deployment workflow
src/db/index.ts               — (modify) Read DATABASE_URL from env
next.config.ts                — (modify) Add output: 'standalone'
.env.example                  — (modify) Add DATABASE_URL, DOMAIN
.gitignore                    — (modify) Add Docker/deploy ignores
```

---

## Chunk 1: Code Changes for Production Readiness

### Task 1: Make database path configurable

**Files:**
- Modify: `src/db/index.ts`

- [ ] **Step 1: Update database path to read from environment**

Replace the hardcoded `"local.db"` with an env var lookup in `src/db/index.ts`:

```typescript
import path from "path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";

const dbPath = process.env.DATABASE_URL ?? "local.db";
const sqlite = new Database(dbPath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, { schema });

migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
```

- [ ] **Step 2: Verify dev server still works**

```bash
pnpm dev
```

Open `http://localhost:3000` — confirm the app loads and existing data is intact (still uses `local.db` by default).

- [ ] **Step 3: Commit**

```bash
git add src/db/index.ts
git commit -m "feat: make database path configurable via DATABASE_URL env var"
```

---

### Task 2: Enable Next.js standalone output

**Files:**
- Modify: `next.config.ts`

- [ ] **Step 1: Add standalone output mode**

Update `next.config.ts`:

```typescript
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
};

export default nextConfig;
```

- [ ] **Step 2: Verify build produces standalone output**

```bash
pnpm build
```

Check that `.next/standalone/` directory exists:

```bash
ls .next/standalone/server.js
```

Expected: file exists. This is the self-contained server that the Docker image will run.

- [ ] **Step 3: Commit**

```bash
git add next.config.ts
git commit -m "feat: enable Next.js standalone output for production Docker builds"
```

---

### Task 3: Update .env.example and .gitignore

**Files:**
- Modify: `.env.example`
- Modify: `.gitignore`

- [ ] **Step 1: Update .env.example with deployment vars**

Add the deployment-related variables to `.env.example`:

```
# Auth — one of these is required:
# Option 1: Use Claude Code subscription (auto-detected from ~/.claude/.credentials.json)
# Option 2: ANTHROPIC_API_KEY=sk-ant-...

# Required — GitHub PAT (repo scope)
GIT_TOKEN=ghp_...

# Optional
GIT_USER_NAME=Interlude Agent
GIT_USER_EMAIL=agent@interlude.dev
KEEP_CONTAINERS=false

# Agent limits (per task)
MAX_TURNS=50
MAX_BUDGET_USD=5.00

# Deployment (production only)
# DATABASE_URL=/data/interlude.db
# DOMAIN=interlude.dev
# CLAUDE_CREDENTIALS_PATH=/home/deploy/.claude/.credentials.json  # REQUIRED for OAuth on VPS
```

- [ ] **Step 2: Update .gitignore**

Append to `.gitignore`:

```
# Docker
.docker/
```

- [ ] **Step 3: Commit**

```bash
git add .env.example .gitignore
git commit -m "chore: add deployment vars to .env.example"
```

---

## Chunk 2: Docker and Compose

### Task 4: Create the app Dockerfile

**Files:**
- Create: `Dockerfile`

- [ ] **Step 1: Create multi-stage Dockerfile**

Create `Dockerfile` at project root:

```dockerfile
FROM node:22-slim AS base
RUN corepack enable && corepack prepare pnpm@latest --activate

# --- Dependencies ---
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# --- Build ---
FROM base AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NODE_ENV=production
RUN pnpm build

# --- Run ---
FROM base AS run
WORKDIR /app
ENV NODE_ENV=production

# Copy standalone output
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public

# Copy native addon not reliably traced by Next.js standalone
COPY --from=build /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3
COPY --from=build /app/node_modules/bindings ./node_modules/bindings
COPY --from=build /app/node_modules/file-uri-to-path ./node_modules/file-uri-to-path

# Copy files needed at runtime beyond Next.js standalone
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/Dockerfile.agent ./Dockerfile.agent

EXPOSE 3000
CMD ["node", "server.js"]
```

- [ ] **Step 2: Verify image builds locally**

```bash
docker build -t interlude-app:test .
```

Expected: builds successfully. The final image should be ~200-300MB.

- [ ] **Step 3: Verify image runs locally**

```bash
docker run --rm -p 3000:3000 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e GIT_TOKEN=test \
  interlude-app:test
```

Expected: Next.js starts and is accessible at `http://localhost:3000`. It will fail on features that need real credentials, but the app should load. Press Ctrl+C to stop.

Note: the app will throw on `getConfig()` if no credentials are present, but the UI should still load since config is lazy-loaded on task execution, not on startup.

- [ ] **Step 4: Commit**

```bash
git add Dockerfile
git commit -m "feat: add multi-stage Dockerfile for production app"
```

---

### Task 5: Create Caddyfile

**Files:**
- Create: `Caddyfile`

- [ ] **Step 1: Create Caddyfile**

Create `Caddyfile` at project root:

```
{$DOMAIN:localhost} {
    reverse_proxy app:3000
}
```

The `{$DOMAIN:localhost}` syntax reads the `DOMAIN` env var, defaulting to `localhost` for local testing. On the VPS with a real domain, Caddy automatically provisions Let's Encrypt certificates.

- [ ] **Step 2: Commit**

```bash
git add Caddyfile
git commit -m "feat: add Caddyfile for reverse proxy with auto-HTTPS"
```

---

### Task 6: Create docker-compose.yml

**Files:**
- Create: `docker-compose.yml`

- [ ] **Step 1: Create docker-compose.yml**

Create `docker-compose.yml` at project root:

```yaml
services:
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"  # HTTP/3
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    env_file: .env
    depends_on:
      - app

  app:
    build:
      context: .
      dockerfile: Dockerfile
    restart: unless-stopped
    env_file: .env
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - app_data:/data
      - ${CLAUDE_CREDENTIALS_PATH:-/dev/null}:/home/node/.claude/.credentials.json:rw
    environment:
      - HOSTNAME=0.0.0.0

volumes:
  caddy_data:
  caddy_config:
  app_data:
```

Notes on the design:
- `app_data` volume at `/data` is where SQLite lives (set `DATABASE_URL=/data/interlude.db` in `.env`)
- Docker socket mounted for agent container management via dockerode
- `HOSTNAME=0.0.0.0` ensures Next.js listens on all interfaces inside the container

**Critical: `CLAUDE_CREDENTIALS_PATH` must be set to the host path in `.env` on the VPS.** Here's why:
1. Compose mounts the host file into the app container at `/home/node/.claude/.credentials.json`
2. `config.ts` reads `CLAUDE_CREDENTIALS_PATH` from env — this value becomes `config.claudeCredentialsPath`
3. `container-manager.ts` passes `config.claudeCredentialsPath` as a bind mount to agent containers
4. The Docker daemon resolves bind paths on the **host** filesystem, not inside the app container
5. So `claudeCredentialsPath` must be the host path (e.g., `/home/deploy/.claude/.credentials.json`), not the container-internal path

If `CLAUDE_CREDENTIALS_PATH` is unset, `config.ts` falls back to auto-detecting via `$HOME` inside the container, which gives `/home/node/.claude/.credentials.json` — a container-internal path the Docker daemon cannot resolve. Agent containers would fail to start.

For local dev without OAuth, omit `CLAUDE_CREDENTIALS_PATH` from `.env` and set `ANTHROPIC_API_KEY` instead. The compose file uses `${CLAUDE_CREDENTIALS_PATH:-/dev/null}` as the mount source to avoid errors when the var is unset.

- [ ] **Step 2: Test locally with compose**

```bash
DOMAIN=localhost docker compose up --build -d
```

Check both containers are running:

```bash
docker compose ps
```

Expected: both `caddy` and `app` show as running. Visit `http://localhost` — Caddy should proxy to the app (with a self-signed cert warning since we're on localhost).

```bash
docker compose down
```

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yml
git commit -m "feat: add Docker Compose stack with Caddy and app services"
```

---

## Chunk 3: GitHub Actions CI/CD

### Task 7: Create deploy workflow

**Files:**
- Create: `.github/workflows/deploy.yml`

- [ ] **Step 1: Create the workflow file**

```bash
mkdir -p .github/workflows
```

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy

on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Deploy to VPS
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.VPS_HOST }}
          username: ${{ secrets.VPS_USER }}
          key: ${{ secrets.VPS_SSH_KEY }}
          script: |
            cd /opt/interlude
            git pull origin main
            docker compose up -d --build

            # Health check — wait for HTTP server, not just container state
            echo "Waiting for app to start..."
            sleep 10
            if curl -sf http://localhost:3000/api/init > /dev/null; then
              echo "App is healthy"
            else
              echo "ERROR: App failed health check"
              docker compose logs app --tail 50
              exit 1
            fi
```

The workflow:
- Triggers on push to `main` or manual dispatch
- SSHes into the VPS using secrets
- Pulls latest code and rebuilds containers
- Verifies the app container is running after deploy

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "feat: add GitHub Actions deploy workflow"
```

---

## Chunk 4: VPS Provisioning

This chunk covers the manual VPS setup steps. These are not code changes but are documented here as a checklist for execution.

### Task 8: Create Hetzner VPS

- [ ] **Step 1: Create the server**

Go to [Hetzner Cloud Console](https://console.hetzner.cloud/), create a new project (or use existing), and create a server:
- **Type:** CX22 (2 vCPU, 4GB RAM, 40GB disk)
- **Image:** Ubuntu 24.04
- **Location:** Choose nearest (e.g., Falkenstein for EU)
- **SSH Key:** Add your public key during creation
- **Name:** `interlude`

Note the server IP address.

- [ ] **Step 2: Initial SSH and user setup**

```bash
ssh root@<VPS_IP>
```

Create deploy user and configure sudo:

```bash
adduser deploy
usermod -aG sudo deploy
mkdir -p /home/deploy/.ssh
cp ~/.ssh/authorized_keys /home/deploy/.ssh/
chown -R deploy:deploy /home/deploy/.ssh
chmod 700 /home/deploy/.ssh
chmod 600 /home/deploy/.ssh/authorized_keys
```

- [ ] **Step 3: Harden SSH**

Edit `/etc/ssh/sshd_config`:

```
PermitRootLogin no
PasswordAuthentication no
```

```bash
systemctl restart sshd
```

Verify you can still log in as `deploy` in a new terminal before closing the root session:

```bash
ssh deploy@<VPS_IP>
```

- [ ] **Step 4: Install fail2ban and configure UFW**

```bash
sudo apt update && sudo apt install -y fail2ban ufw
sudo ufw allow 22
sudo ufw allow 80
sudo ufw allow 443
sudo ufw --force enable
sudo systemctl enable fail2ban
```

---

### Task 9: Install Docker

- [ ] **Step 1: Install Docker Engine**

```bash
sudo apt install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

- [ ] **Step 2: Add deploy user to docker group**

```bash
sudo usermod -aG docker deploy
```

Log out and back in for group change to take effect:

```bash
exit
ssh deploy@<VPS_IP>
docker ps  # should work without sudo
```

---

### Task 10: Deploy the application

- [ ] **Step 1: Clone the repo**

```bash
sudo mkdir -p /opt/interlude
sudo chown deploy:deploy /opt/interlude
git clone https://github.com/<YOUR_USER>/interlude.git /opt/interlude
cd /opt/interlude
```

- [ ] **Step 2: Create .env file**

```bash
cat > /opt/interlude/.env << 'EOF'
# Domain
DOMAIN=<your-domain>

# App
DATABASE_URL=/data/interlude.db

# Agent credentials (OAuth credentials mounted separately via CLAUDE_CREDENTIALS_PATH)
GIT_TOKEN=<your-github-pat>
GIT_USER_NAME=Interlude Agent
GIT_USER_EMAIL=agent@interlude.dev

# Claude credentials path on the host
CLAUDE_CREDENTIALS_PATH=/home/deploy/.claude/.credentials.json

# Optional
KEEP_CONTAINERS=false
MAX_TURNS=50
MAX_BUDGET_USD=5.00
EOF
```

- [ ] **Step 3: Register and point domain**

Register your domain (e.g., `interlude.dev`) and create an A record pointing to the VPS IP. Wait for DNS propagation (check with `dig <domain>`).

- [ ] **Step 4: Start the stack**

```bash
cd /opt/interlude
docker compose up -d --build
```

Watch the logs to verify:

```bash
docker compose logs -f
```

Expected: Caddy provisions the SSL certificate (may take 30-60 seconds after DNS propagates), app starts on port 3000.

Visit `https://<your-domain>` — the app should load with HTTPS.

- [ ] **Step 5: Set up GitHub Actions secrets**

In the GitHub repo settings under Secrets and Variables > Actions, add:
- `VPS_HOST` — your VPS IP or domain
- `VPS_USER` — `deploy`
- `VPS_SSH_KEY` — generate a new key pair for this:

```bash
# On the VPS
ssh-keygen -t ed25519 -f ~/.ssh/deploy_key -N ""
cat ~/.ssh/deploy_key.pub >> ~/.ssh/authorized_keys
cat ~/.ssh/deploy_key  # copy this as VPS_SSH_KEY secret
rm ~/.ssh/deploy_key   # remove private key from VPS after copying
```

- [ ] **Step 6: Test the deploy workflow**

Push a trivial change to `main` (or trigger manually via GitHub Actions UI) and verify the workflow runs successfully.

---

### Task 11: Set up Claude OAuth

- [ ] **Step 1: Install Claude Code CLI on VPS**

```bash
sudo npm install -g @anthropic-ai/claude-code
```

- [ ] **Step 2: Run OAuth flow via SSH tunnel**

From your local machine:

```bash
ssh -L 9999:localhost:9999 deploy@<VPS_IP>
```

On the VPS (inside the tunnel session):

```bash
claude
```

Claude Code will print an OAuth URL. Open it in your local browser, complete the login. The browser redirects to `localhost:9999`, which the SSH tunnel forwards to the VPS. Claude Code receives the callback and saves credentials.

- [ ] **Step 3: Verify credentials file exists**

```bash
ls -la ~/.claude/.credentials.json
```

Expected: file exists with your OAuth tokens.

- [ ] **Step 4: Restart the app to pick up credentials**

```bash
cd /opt/interlude
docker compose restart app
```

Check logs to confirm the orchestrator starts successfully:

```bash
docker compose logs app | grep orchestrator
```

Expected: `[orchestrator] Docker available, starting task queue`

---

## Chunk 5: End-to-End Verification

### Task 12: End-to-end test on VPS

- [ ] **Step 1: Check Docker status via API**

```bash
curl -s https://<your-domain>/api/settings/docker | jq
```

Expected:
```json
{
  "docker": true,
  "image": false,
  "imageName": "interlude-agent:latest"
}
```

(Image will be `false` until first task triggers a build.)

- [ ] **Step 2: Create a test project**

```bash
curl -s -X POST https://<your-domain>/api/projects \
  -H 'Content-Type: application/json' \
  -d '{"name": "test-repo", "gitUrl": "https://github.com/<YOUR_USER>/<YOUR_REPO>.git"}'
```

Note the returned project ID.

- [ ] **Step 3: Create a test task**

```bash
curl -s -X POST https://<your-domain>/api/tasks \
  -H 'Content-Type: application/json' \
  -d '{"title": "Add a README.md with project description", "projectId": "<PROJECT_ID>"}'
```

Note the returned task ID.

- [ ] **Step 4: Trigger agent run**

```bash
curl -s -X POST https://<your-domain>/api/tasks/<TASK_ID>/run
```

Expected: `{"started": true}`

- [ ] **Step 5: Watch the stream**

```bash
curl -N https://<your-domain>/api/tasks/<TASK_ID>/stream
```

Expected: real agent output streaming — reading files, writing code, committing. This confirms:
- Docker socket mounting works
- Agent image builds successfully
- Claude OAuth credentials work inside the container
- Output streaming works over HTTPS
- Caddy proxies SSE correctly

- [ ] **Step 6: Verify branch was pushed**

After the task completes, check the test repo for a new `agent/<task-id>` branch.

- [ ] **Step 7: Test cancellation**

Create another task, trigger it, then:

```bash
curl -s -X POST https://<your-domain>/api/tasks/<TASK_ID>/cancel
```

Verify the task status is `cancelled` and the container is removed.

- [ ] **Step 8: Test CI/CD deploy**

Make a small change, push to `main`, and verify the GitHub Actions workflow deploys it successfully. Confirm the change is live on `https://<your-domain>`.

- [ ] **Step 9: Commit any fixes**

If any issues were found and fixed during testing, commit them.
