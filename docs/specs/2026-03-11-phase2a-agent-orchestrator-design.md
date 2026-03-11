# Phase 2a: Agent Orchestrator + Local Docker — Design Spec

## Overview

Replace the mock agent with real Claude Code CLI execution inside Docker containers. Each task gets an isolated container with the repo cloned, runs Claude Code in interactive mode, streams output back to the UI in real-time, and pushes a branch on completion.

## Container Lifecycle

```
Task created (status: queued)
  → Orchestrator picks it up
  → Pulls/builds agent image (cached after first run)
  → Creates container:
      - Clones repo into /workspace
      - Creates branch: agent/<task-id>
      - Injects env vars: ANTHROPIC_API_KEY, GIT_TOKEN
  → Starts Claude Code in interactive mode
  → Pipes task title + description as initial prompt
  → Status: running

Agent working...
  → Orchestrator reads container stdout via Docker API
  → Parses output, inserts as messages in DB
  → SSE stream picks them up, UI updates live

Agent exits
  → Exit code 0: push branch, status → completed
  → Exit code != 0: status → failed, capture stderr
  → Container torn down (or kept for debugging via config flag)
```

## Components

### 1. Agent Docker Image (`Dockerfile.agent`)

- `FROM node:22-slim`
- Install: Claude Code CLI (`@anthropic-ai/claude-code`), git
- Working directory: `/workspace`
- Entrypoint: shell (orchestrator runs commands via exec)

### 2. Orchestrator (`src/lib/orchestrator.ts`)

- Uses `dockerode` (Node.js Docker API client) to manage containers
- Watches for `queued` tasks (polling the DB)
- One task at a time for now (sequential queue)
- Creates container, starts agent, streams output, handles completion

### 3. Output Parser (`src/lib/output-parser.ts`)

- Reads raw stdout stream from Docker
- Claude Code outputs a mix of status messages, tool calls, and content
- Parser extracts meaningful chunks and inserts them as `role: "agent"` messages
- Handles partial lines, buffering, etc.

### 4. Container Manager (`src/lib/container-manager.ts`)

- Builds/caches the agent image
- Creates containers with the right env vars and mounts
- Handles teardown and cleanup
- Configurable: keep containers alive for debugging

### 5. Task Runner (`src/lib/task-runner.ts`)

- Coordinates the lifecycle: pick task → provision container → run agent → capture result → cleanup
- Updates task status in DB at each stage
- Handles errors at any stage gracefully

## Data Model Changes

Add to `tasks` table:
- `containerId` (text, nullable) — Docker container ID while running
- `branch` (text, nullable) — git branch name created for this task

Add to `projects` table:
- `gitUrl` (text, nullable) — clone URL for the repo

## API Changes

| Method | Route | Purpose |
|--------|-------|---------|
| POST | `/api/tasks/[id]/run` | Trigger real agent execution (replaces mock-run) |
| POST | `/api/tasks/[id]/cancel` | Kill the container, set status to cancelled |
| GET | `/api/settings/docker` | Check Docker daemon status, image build state |

## Configuration

Stored as env vars (not in the DB — deployment concerns):

- `ANTHROPIC_API_KEY` — for Claude Code
- `GIT_TOKEN` — personal access token for push
- `GIT_USER_NAME` / `GIT_USER_EMAIL` — for commits inside containers
- `KEEP_CONTAINERS` — boolean, keep containers after task for debugging (default: false)

## Sandboxing

Each container is fully isolated:
- Own filesystem — agent can't touch host or other tasks
- Own repo clone on a fresh branch
- Own network namespace — can run dev servers without port conflicts
- Credentials scoped to just what it needs
- Destructive actions only affect the container — tear down and it's gone

## What Phase 2a Does NOT Include

- Interactive chat / bidirectional messaging (Phase 2b)
- Live dev server preview (Phase 2c)
- GitHub App integration / PR creation (Phase 3)
- Container resource limits (Phase 5 — VPS deployment, explicitly deferred)
- Multiple parallel agents (future)

The stdin pipe to Claude Code is opened but not written to after the initial prompt. Phase 2b will add the user → agent message flow.

## Auth

Single API key injected into every container as env var. Single-user, no per-project keys. Personal access token for git push (repo scope).
