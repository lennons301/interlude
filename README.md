# Interlude

A self-hosted platform for agent-first development, accessible from anywhere (including mobile). Dispatch tasks to AI agents, monitor progress, and receive results — without needing a full IDE.

## Quick Start

```bash
pnpm install
pnpm dev
```

Open http://localhost:3000.

## Tech Stack

- **Framework:** Next.js 16 (App Router)
- **Database:** SQLite via Drizzle ORM + better-sqlite3
- **Styling:** Tailwind CSS + shadcn/ui
- **Real-time:** Server-Sent Events (SSE)
- **Package manager:** pnpm

## Project Structure

```
src/
  app/           — Pages and API routes (Next.js App Router)
  db/            — Database schema and client
  lib/           — Shared utilities
  components/    — React components
docs/
  runbook.md     — Operator runbook for the autonomous ticket-loop
  specs/         — Design specifications
  plans/         — Implementation plans
  agents/        — Agent-facing pass definitions and gate config
```

## Operating the autonomous loop

Running agents unattended? See the [operator runbook](docs/runbook.md) — how to
enable autonomy per project, arm a ticket, watch the fleet, pause pickup, answer a
blocked agent, find PRs waiting for sign-off, and cancel a run.

## License

MIT — see [LICENSE](LICENSE).
