# Interlude

A self-hosted platform for agent-first development, accessible from anywhere (including mobile). Dispatch tasks to AI agents, monitor progress, and receive results as PRs — without needing a full IDE. It also runs the estate's autonomous ticket-loop: tickets labelled `ready-for-agent` are picked up, implemented in a container, reviewed, and auto-merged or parked for human sign-off.

Production: <https://interludes.co.uk>

## Tech Stack

- **Framework:** Next.js 16 (App Router), React 19, TypeScript
- **Database:** SQLite via Drizzle ORM + better-sqlite3
- **UI:** Tailwind CSS + shadcn/ui
- **Real-time:** Server-Sent Events (SSE)
- **Agent runtime:** one Docker container per task; GitHub App for git auth; Discord bot for notifications
- **Secrets:** Doppler
- **Deployment:** Docker Compose (Caddy + app) on a Hetzner VPS
- **Package manager:** pnpm

## Prerequisites

- Node.js 22 and [pnpm](https://pnpm.io/)
- [Docker](https://www.docker.com/) — agent containers run on the local daemon
- [Doppler CLI](https://docs.doppler.com/docs/install-cli) with access to the `interlude` project — orchestrator secrets come from the `dev` config (`.env.example` lists the variables)
- A GitHub App installation for the repos agents will work on (required: containers clone and push with App tokens), and optionally a Discord bot token

## Getting Started

```bash
pnpm install
docker network create interlude   # once: the network agent containers attach to
doppler run -- pnpm dev
```

Open <http://localhost:3000>. Agent containers authenticate to their harness with a token held in the Doppler `dev` config; "Local development" in [AGENTS.md](./AGENTS.md) has the details and the error you see when either step is skipped.

## Commands

| Command | Description |
|---------|-------------|
| `doppler run -- pnpm dev` | Start the orchestrator locally |
| `pnpm test` | Run the Vitest suite |
| `pnpm lint` | ESLint (`main` carries a known baseline of errors; lint only what you touch) |
| `pnpm build` | Production build |

## Project Structure

```
src/
  app/           # Pages and API routes (Next.js App Router)
  components/    # React components
  db/            # Database schema and client
  lib/           # Orchestrator, agent runtime, lanes, quota, fleet, GitHub, Discord
custom-server.js # Host-header routing for task preview subdomains
docker-compose.yml, Caddyfile, Dockerfile*   # The VPS stack and the two images
docs/
  runbook.md     # Operator runbook for the autonomous ticket-loop
  roadmap.md     # Phase history and what is next
  specs/         # Design specifications
  plans/         # Implementation plans
  agents/        # Agent-facing pass definitions and gate config
```

## Operating the autonomous loop

Running agents unattended? See the [operator runbook](docs/runbook.md) — how to
enable autonomy per project, arm a ticket, watch the fleet, pause pickup, answer a
blocked agent, find PRs waiting for sign-off, and cancel a run.

## Documentation

- Technical reference for contributors and agents: [AGENTS.md](./AGENTS.md)
- Roadmap and phase history: [docs/roadmap.md](./docs/roadmap.md)
- Design specs and implementation plans: [docs/specs/](./docs/specs/), [docs/plans/](./docs/plans/)

## License

MIT — see [LICENSE](LICENSE).
