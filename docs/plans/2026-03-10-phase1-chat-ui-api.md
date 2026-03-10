# Phase 1: Chat UI + API — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a mobile-friendly web UI for creating, viewing, and monitoring agent tasks, with a mock agent for development.

**Architecture:** Next.js 15 App Router with SQLite (Drizzle ORM) for persistence, SSE for real-time streaming, and a hybrid expandable feed layout. Single-user, no auth. Mock agent simulates streaming output so the UI can be fully developed without Docker.

**Tech Stack:** Next.js 15, pnpm, TypeScript, Drizzle ORM + better-sqlite3, Tailwind CSS + shadcn/ui, SSE, ulidx, PWA manifest.

**Spec:** `docs/specs/2026-03-10-phase1-chat-ui-api-design.md`

---

## File Structure

```
src/
  app/
    layout.tsx              — Root layout (fonts, providers, global styles)
    page.tsx                — Main feed (task list)
    manifest.ts             — PWA manifest
    tasks/
      new/
        page.tsx            — New task form
      [id]/
        page.tsx            — Task detail view
    settings/
      page.tsx              — Project management
    api/
      tasks/
        route.ts            — GET (list), POST (create)
        [id]/
          route.ts          — GET (detail), PATCH (update)
          messages/
            route.ts        — GET (list), POST (create)
          stream/
            route.ts        — GET (SSE stream)
      projects/
        route.ts            — GET (list), POST (create)
  db/
    index.ts                — Drizzle client instance
    schema.ts               — Table definitions
  lib/
    mock-agent.ts           — Mock agent that simulates streaming output
    sse.ts                  — SSE helper (encode events, create stream)
    ulid.ts                 — ULID generation wrapper
  components/
    task-card.tsx            — Expandable task card (collapsed + expanded states)
    task-feed.tsx            — Task list with auto-expansion
    task-stream.tsx          — Live SSE message stream display
    message-input.tsx        — Reply input for agent interaction
    new-task-form.tsx        — Task creation form
    project-selector.tsx     — Project dropdown
    status-badge.tsx         — Task status indicator
    header.tsx               — App header with nav
drizzle/                     — Generated migration files
drizzle.config.ts            — Drizzle Kit config
```

---

## Chunk 1: Project Setup + Database

### Task 1: Scaffold Next.js project

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `tailwind.config.ts`, etc. (via create-next-app)
- Create: `.gitignore` (update existing)

- [ ] **Step 1: Create Next.js app in current directory**

```bash
pnpm create next-app@latest . --typescript --tailwind --eslint --app --src-dir --import-alias "@/*" --turbopack
```

Accept defaults. This scaffolds into the current directory since the repo is empty (aside from .gitignore and docs/).

- [ ] **Step 2: Verify it runs**

```bash
pnpm dev
```

Open http://localhost:3000, confirm the Next.js welcome page loads. Kill the dev server.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "chore: scaffold Next.js 15 app with TypeScript, Tailwind, App Router"
```

---

### Task 2: Install dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install runtime dependencies**

```bash
pnpm add drizzle-orm better-sqlite3 ulidx
```

- [ ] **Step 2: Install dev dependencies**

```bash
pnpm add -D drizzle-kit @types/better-sqlite3
```

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: add Drizzle ORM, better-sqlite3, ulidx"
```

---

### Task 3: Set up shadcn/ui

**Files:**
- Create: `components.json`
- Modify: `src/app/globals.css`, `tailwind.config.ts`

- [ ] **Step 1: Initialize shadcn**

```bash
pnpm dlx shadcn@latest init -t next
```

Select defaults: New York style, Zinc base color, CSS variables.

- [ ] **Step 2: Add initial components we'll need**

```bash
pnpm dlx shadcn@latest add button card input badge textarea select dialog
```

- [ ] **Step 3: Verify build still works**

```bash
pnpm build
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: initialize shadcn/ui with core components"
```

---

### Task 4: Database schema and client

**Files:**
- Create: `src/db/schema.ts`
- Create: `src/db/index.ts`
- Create: `src/lib/ulid.ts`
- Create: `drizzle.config.ts`

- [ ] **Step 1: Create ULID helper**

Create `src/lib/ulid.ts`:

```typescript
import { ulid } from "ulidx";

export function newId(): string {
  return ulid();
}
```

- [ ] **Step 2: Create database schema**

Create `src/db/schema.ts`:

```typescript
import { int, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  githubRepo: text("github_repo"),
  createdAt: int("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  status: text("status", {
    enum: ["queued", "running", "blocked", "completed", "failed", "cancelled"],
  })
    .notNull()
    .default("queued"),
  githubIssue: text("github_issue"),
  createdAt: int("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: int("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.id),
  role: text("role", { enum: ["user", "agent", "system"] }).notNull(),
  content: text("content").notNull(),
  createdAt: int("created_at", { mode: "timestamp_ms" }).notNull(),
});
```

- [ ] **Step 3: Create Drizzle config**

Create `drizzle.config.ts`:

```typescript
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./drizzle",
  schema: "./src/db/schema.ts",
  dialect: "sqlite",
  dbCredentials: {
    url: "file:./local.db",
  },
});
```

- [ ] **Step 4: Create database client**

Create `src/db/index.ts`:

```typescript
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

const sqlite = new Database("local.db");
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, { schema });
```

- [ ] **Step 5: Generate and run migrations**

```bash
npx drizzle-kit generate
npx drizzle-kit push
```

- [ ] **Step 6: Add local.db to .gitignore**

Append to `.gitignore`:
```
local.db
local.db-wal
local.db-shm
```

- [ ] **Step 7: Verify by running a quick test**

```bash
npx tsx -e "
import { db } from './src/db';
import { projects } from './src/db/schema';
import { newId } from './src/lib/ulid';
db.insert(projects).values({ id: newId(), name: 'test', createdAt: new Date() }).run();
const rows = db.select().from(projects).all();
console.log(rows);
"
```

Should print an array with the test project.

- [ ] **Step 8: Commit**

```bash
git add src/db/ src/lib/ulid.ts drizzle.config.ts drizzle/ .gitignore
git commit -m "feat: add database schema (projects, tasks, messages) with Drizzle ORM"
```

---

## Chunk 2: API Routes

### Task 5: Projects API

**Files:**
- Create: `src/app/api/projects/route.ts`

- [ ] **Step 1: Implement GET and POST for projects**

Create `src/app/api/projects/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { newId } from "@/lib/ulid";
import { desc } from "drizzle-orm";

export async function GET() {
  const rows = await db.select().from(projects).orderBy(desc(projects.createdAt));
  return NextResponse.json(rows);
}

export async function POST(request: Request) {
  const body = await request.json();
  const { name, githubRepo } = body as { name: string; githubRepo?: string };

  if (!name?.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  const project = {
    id: newId(),
    name: name.trim(),
    githubRepo: githubRepo ?? null,
    createdAt: new Date(),
  };

  db.insert(projects).values(project).run();
  return NextResponse.json(project, { status: 201 });
}
```

- [ ] **Step 2: Test with curl**

```bash
# Create a project
curl -s -X POST http://localhost:3000/api/projects \
  -H 'Content-Type: application/json' \
  -d '{"name": "interlude"}' | jq

# List projects
curl -s http://localhost:3000/api/projects | jq
```

- [ ] **Step 3: Commit**

```bash
git add src/app/api/projects/
git commit -m "feat: add projects API (GET list, POST create)"
```

---

### Task 6: Tasks API

**Files:**
- Create: `src/app/api/tasks/route.ts`
- Create: `src/app/api/tasks/[id]/route.ts`

- [ ] **Step 1: Implement task list and create**

Create `src/app/api/tasks/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { db } from "@/db";
import { tasks } from "@/db/schema";
import { newId } from "@/lib/ulid";
import { desc, eq } from "drizzle-orm";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");
  const projectId = searchParams.get("projectId");

  let query = db.select().from(tasks).orderBy(desc(tasks.updatedAt)).$dynamic();

  if (status) {
    query = query.where(eq(tasks.status, status as any));
  }
  if (projectId) {
    query = query.where(eq(tasks.projectId, projectId));
  }

  const rows = await query;
  return NextResponse.json(rows);
}

export async function POST(request: Request) {
  const body = await request.json();
  const { title, description, projectId } = body as {
    title: string;
    description?: string;
    projectId: string;
  };

  if (!title?.trim()) {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }
  if (!projectId) {
    return NextResponse.json({ error: "projectId is required" }, { status: 400 });
  }

  const now = new Date();
  const task = {
    id: newId(),
    projectId,
    title: title.trim(),
    description: description?.trim() ?? "",
    status: "queued" as const,
    githubIssue: null,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(tasks).values(task).run();
  return NextResponse.json(task, { status: 201 });
}
```

- [ ] **Step 2: Implement task detail and update**

Create `src/app/api/tasks/[id]/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { db } from "@/db";
import { tasks } from "@/db/schema";
import { eq } from "drizzle-orm";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const task = db.select().from(tasks).where(eq(tasks.id, id)).get();

  if (!task) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  return NextResponse.json(task);
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json();
  const { title, status } = body as { title?: string; status?: string };

  const existing = db.select().from(tasks).where(eq(tasks.id, id)).get();
  if (!existing) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (title !== undefined) updates.title = title.trim();
  if (status !== undefined) updates.status = status;

  db.update(tasks).set(updates).where(eq(tasks.id, id)).run();

  const updated = db.select().from(tasks).where(eq(tasks.id, id)).get();
  return NextResponse.json(updated);
}
```

- [ ] **Step 3: Test with curl**

```bash
# Create a task (use a project ID from earlier)
curl -s -X POST http://localhost:3000/api/tasks \
  -H 'Content-Type: application/json' \
  -d '{"title": "Add auth to API", "projectId": "PROJECT_ID_HERE"}' | jq

# List tasks
curl -s http://localhost:3000/api/tasks | jq

# Update status
curl -s -X PATCH http://localhost:3000/api/tasks/TASK_ID_HERE \
  -H 'Content-Type: application/json' \
  -d '{"status": "running"}' | jq
```

- [ ] **Step 4: Commit**

```bash
git add src/app/api/tasks/
git commit -m "feat: add tasks API (list, create, get, update)"
```

---

### Task 7: Messages API + SSE stream

**Files:**
- Create: `src/app/api/tasks/[id]/messages/route.ts`
- Create: `src/app/api/tasks/[id]/stream/route.ts`
- Create: `src/lib/sse.ts`

- [ ] **Step 1: Create SSE helper**

Create `src/lib/sse.ts`:

```typescript
export function sseEvent(data: unknown, event?: string): string {
  let message = "";
  if (event) message += `event: ${event}\n`;
  message += `data: ${JSON.stringify(data)}\n\n`;
  return message;
}

export function createSSEStream(
  signal: AbortSignal,
  handler: (send: (data: unknown, event?: string) => void) => () => void
): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const send = (data: unknown, event?: string) => {
        try {
          controller.enqueue(encoder.encode(sseEvent(data, event)));
        } catch {
          // Stream closed
        }
      };

      const cleanup = handler(send);

      signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {
          // Already closed
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
```

- [ ] **Step 2: Implement messages list and create**

Create `src/app/api/tasks/[id]/messages/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { db } from "@/db";
import { messages } from "@/db/schema";
import { newId } from "@/lib/ulid";
import { asc, eq } from "drizzle-orm";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const rows = db
    .select()
    .from(messages)
    .where(eq(messages.taskId, id))
    .orderBy(asc(messages.createdAt))
    .all();

  return NextResponse.json(rows);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json();
  const { content, role } = body as { content: string; role?: string };

  if (!content?.trim()) {
    return NextResponse.json({ error: "content is required" }, { status: 400 });
  }

  const message = {
    id: newId(),
    taskId: id,
    role: (role ?? "user") as "user" | "agent" | "system",
    content: content.trim(),
    createdAt: new Date(),
  };

  db.insert(messages).values(message).run();
  return NextResponse.json(message, { status: 201 });
}
```

- [ ] **Step 3: Implement SSE stream endpoint**

Create `src/app/api/tasks/[id]/stream/route.ts`:

```typescript
import { db } from "@/db";
import { messages } from "@/db/schema";
import { and, eq, gt, asc } from "drizzle-orm";
import { createSSEStream } from "@/lib/sse";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const after = searchParams.get("after");

  return createSSEStream(request.signal, (send) => {
    let lastSeen = after ?? "";

    const poll = setInterval(() => {
      const where = lastSeen
        ? and(eq(messages.taskId, id), gt(messages.id, lastSeen))
        : eq(messages.taskId, id);

      const newMessages = db
        .select()
        .from(messages)
        .where(where)
        .orderBy(asc(messages.createdAt))
        .all();

      for (const msg of newMessages) {
        send(msg, "message");
        lastSeen = msg.id;
      }
    }, 500);

    return () => clearInterval(poll);
  });
}
```

- [ ] **Step 4: Test SSE with curl**

```bash
# In one terminal, start listening
curl -N http://localhost:3000/api/tasks/TASK_ID/stream

# In another terminal, post a message
curl -s -X POST http://localhost:3000/api/tasks/TASK_ID/messages \
  -H 'Content-Type: application/json' \
  -d '{"content": "hello from user", "role": "user"}'
```

The first terminal should receive the message as an SSE event.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sse.ts src/app/api/tasks/\[id\]/messages/ src/app/api/tasks/\[id\]/stream/
git commit -m "feat: add messages API and SSE streaming endpoint"
```

---

## Chunk 3: Mock Agent

### Task 8: Mock agent for development

**Files:**
- Create: `src/lib/mock-agent.ts`

The mock agent simulates Claude Code working on a task. It inserts messages into the database at realistic intervals, so the SSE stream picks them up and the UI can be developed without Docker.

- [ ] **Step 1: Implement mock agent**

Create `src/lib/mock-agent.ts`:

```typescript
import { db } from "@/db";
import { messages, tasks } from "@/db/schema";
import { eq } from "drizzle-orm";
import { newId } from "./ulid";

const MOCK_STEPS = [
  { delay: 500, content: "Starting work on task..." },
  { delay: 1500, content: "Reading project files..." },
  { delay: 2000, content: "Analyzing codebase structure..." },
  { delay: 1000, content: "Planning implementation approach..." },
  { delay: 2500, content: "Writing code changes..." },
  { delay: 1500, content: '→ Modified `src/api/auth.ts`' },
  { delay: 2000, content: "Running tests..." },
  { delay: 1000, content: "All tests passing ✓" },
  { delay: 1500, content: '→ Committed: "feat: implement requested changes"' },
  { delay: 1000, content: "Task complete. Created PR #42." },
];

const MOCK_BLOCKED_STEPS = [
  { delay: 500, content: "Starting work on task..." },
  { delay: 1500, content: "Reading project files..." },
  { delay: 2000, content: "I have a question before proceeding:" },
  {
    delay: 500,
    content:
      "Should I use connection pooling for the database, or is a single connection sufficient for this use case?",
  },
];

export async function runMockAgent(
  taskId: string,
  options: { simulateBlock?: boolean } = {}
): Promise<void> {
  const steps = options.simulateBlock ? MOCK_BLOCKED_STEPS : MOCK_STEPS;

  // Set task to running
  db.update(tasks)
    .set({ status: "running", updatedAt: new Date() })
    .where(eq(tasks.id, taskId))
    .run();

  for (const step of steps) {
    await sleep(step.delay);

    db.insert(messages)
      .values({
        id: newId(),
        taskId,
        role: "agent",
        content: step.content,
        createdAt: new Date(),
      })
      .run();
  }

  // Set final status
  const finalStatus = options.simulateBlock ? "blocked" : "completed";
  db.update(tasks)
    .set({ status: finalStatus, updatedAt: new Date() })
    .where(eq(tasks.id, taskId))
    .run();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

- [ ] **Step 2: Add a trigger endpoint for the mock agent**

Add to `src/app/api/tasks/[id]/route.ts` — when a task is created or patched to `queued`, optionally kick off the mock agent. For now, add a dedicated endpoint:

Create `src/app/api/tasks/[id]/mock-run/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { db } from "@/db";
import { tasks } from "@/db/schema";
import { eq } from "drizzle-orm";
import { runMockAgent } from "@/lib/mock-agent";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const { simulateBlock } = body as { simulateBlock?: boolean };

  const task = db.select().from(tasks).where(eq(tasks.id, id)).get();
  if (!task) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Fire-and-forget: catch errors to avoid unhandled rejection
  runMockAgent(id, { simulateBlock }).catch(console.error);

  return NextResponse.json({ started: true });
}
```

- [ ] **Step 3: Test mock agent with SSE**

```bash
# Terminal 1: Listen to stream
curl -N http://localhost:3000/api/tasks/TASK_ID/stream

# Terminal 2: Trigger mock agent
curl -s -X POST http://localhost:3000/api/tasks/TASK_ID/mock-run \
  -H 'Content-Type: application/json' -d '{}'
```

Messages should stream in over ~15 seconds.

- [ ] **Step 4: Commit**

```bash
git add src/lib/mock-agent.ts src/app/api/tasks/\[id\]/mock-run/
git commit -m "feat: add mock agent for UI development"
```

---

## Chunk 4: UI — Layout and Components

### Task 9: App shell and layout

**Files:**
- Modify: `src/app/layout.tsx`
- Modify: `src/app/globals.css`
- Create: `src/components/header.tsx`

- [ ] **Step 1: Set up dark theme in globals.css**

Modify `src/app/globals.css`: shadcn init will have generated CSS variables for both `:root` (light) and `.dark` (dark) themes. The layout already sets `className="dark"` on `<html>`, so the dark variables will be active. No changes needed to globals.css unless shadcn defaults don't look right — in that case, tweak the dark theme HSL values.

- [ ] **Step 2: Create header component**

Create `src/components/header.tsx`:

```tsx
import Link from "next/link";

export function Header() {
  return (
    <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex h-14 max-w-2xl items-center justify-between px-4">
        <Link href="/" className="text-lg font-semibold">
          Interlude
        </Link>
        <nav className="flex items-center gap-4 text-sm">
          <Link href="/" className="text-muted-foreground hover:text-foreground">
            Tasks
          </Link>
          <Link
            href="/settings"
            className="text-muted-foreground hover:text-foreground"
          >
            Settings
          </Link>
        </nav>
      </div>
    </header>
  );
}
```

- [ ] **Step 3: Update root layout**

Modify `src/app/layout.tsx` to include the header and set max-width container:

```tsx
import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Header } from "@/components/header";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Interlude",
  description: "Agent-first development environment",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className={inter.className}>
        <Header />
        <main className="mx-auto max-w-2xl px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
```

- [ ] **Step 4: Verify in browser**

```bash
pnpm dev
```

Open http://localhost:3000. Should see the header with "Interlude" and nav links on a dark background.

- [ ] **Step 5: Commit**

```bash
git add src/app/layout.tsx src/app/globals.css src/components/header.tsx
git commit -m "feat: add app shell with header, dark theme, responsive layout"
```

---

### Task 10: Status badge component

**Files:**
- Create: `src/components/status-badge.tsx`

- [ ] **Step 1: Create status badge**

Create `src/components/status-badge.tsx`:

```tsx
import { Badge } from "@/components/ui/badge";

const STATUS_CONFIG: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline"; className?: string }> = {
  queued: { label: "Queued", variant: "secondary" },
  running: { label: "Running", variant: "default", className: "bg-green-600 hover:bg-green-700" },
  blocked: { label: "Needs Input", variant: "default", className: "bg-amber-600 hover:bg-amber-700" },
  completed: { label: "Completed", variant: "secondary" },
  failed: { label: "Failed", variant: "destructive" },
  cancelled: { label: "Cancelled", variant: "outline" },
};

export function StatusBadge({ status }: { status: string }) {
  const config = STATUS_CONFIG[status] ?? { label: status, variant: "secondary" as const };
  return (
    <Badge variant={config.variant} className={config.className}>
      {config.label}
    </Badge>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/status-badge.tsx
git commit -m "feat: add status badge component"
```

---

### Task 11: Task card component

**Files:**
- Create: `src/components/task-card.tsx`
- Create: `src/components/task-stream.tsx`
- Create: `src/components/message-input.tsx`

- [ ] **Step 1: Create message stream display**

Create `src/components/task-stream.tsx`:

```tsx
"use client";

import { useEffect, useRef, useState } from "react";

type Message = {
  id: string;
  role: string;
  content: string;
  createdAt: string;
};

export function TaskStream({ taskId }: { taskId: string }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Load existing messages
    fetch(`/api/tasks/${taskId}/messages`)
      .then((r) => r.json())
      .then((data) => setMessages(data));

    // Connect to SSE stream
    const eventSource = new EventSource(`/api/tasks/${taskId}/stream`);

    eventSource.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data) as Message;
      setMessages((prev) => {
        if (prev.some((m) => m.id === msg.id)) return prev;
        return [...prev, msg];
      });
    });

    return () => eventSource.close();
  }, [taskId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  return (
    <div className="max-h-64 overflow-y-auto rounded-md bg-black/30 p-3 font-mono text-sm">
      {messages.length === 0 && (
        <p className="text-muted-foreground">Waiting for agent output...</p>
      )}
      {messages.map((msg) => (
        <div
          key={msg.id}
          className={
            msg.role === "user"
              ? "text-blue-400"
              : msg.role === "system"
                ? "text-muted-foreground"
                : "text-foreground"
          }
        >
          {msg.content}
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
```

- [ ] **Step 2: Create message input**

Create `src/components/message-input.tsx`:

```tsx
"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function MessageInput({ taskId }: { taskId: string }) {
  const [content, setContent] = useState("");
  const [sending, setSending] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!content.trim() || sending) return;

    setSending(true);
    await fetch(`/api/tasks/${taskId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: content.trim(), role: "user" }),
    });
    setContent("");
    setSending(false);
  }

  return (
    <form onSubmit={handleSubmit} className="flex gap-2">
      <Input
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="Reply to agent..."
        className="flex-1"
      />
      <Button type="submit" size="sm" disabled={sending || !content.trim()}>
        Send
      </Button>
    </form>
  );
}
```

- [ ] **Step 3: Create expandable task card**

Create `src/components/task-card.tsx`:

```tsx
"use client";

import { useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { StatusBadge } from "./status-badge";
import { TaskStream } from "./task-stream";
import { MessageInput } from "./message-input";

type Task = {
  id: string;
  title: string;
  status: string;
  description: string;
  updatedAt: string;
};

const EXPANDED_STATUSES = new Set(["running", "blocked"]);

export function TaskCard({ task }: { task: Task }) {
  const autoExpand = EXPANDED_STATUSES.has(task.status);
  const [expanded, setExpanded] = useState(autoExpand);

  const isCancelled = task.status === "cancelled";

  return (
    <Card
      className={`cursor-pointer transition-colors hover:bg-accent/50 ${isCancelled ? "opacity-50" : ""}`}
      onClick={() => !expanded && setExpanded(true)}
    >
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <Link
          href={`/tasks/${task.id}`}
          className="font-medium hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {task.title}
        </Link>
        <StatusBadge status={task.status} />
      </CardHeader>

      {expanded && (
        <CardContent className="space-y-3 pt-0">
          <TaskStream taskId={task.id} />
          {(task.status === "running" || task.status === "blocked") && (
            <MessageInput taskId={task.id} />
          )}
          <button
            className="text-xs text-muted-foreground hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(false);
            }}
          >
            Collapse
          </button>
        </CardContent>
      )}
    </Card>
  );
}
```

- [ ] **Step 4: Verify in browser**

These are client components — they'll be used by the pages in the next task. For now, verify the build:

```bash
pnpm build
```

- [ ] **Step 5: Commit**

```bash
git add src/components/task-card.tsx src/components/task-stream.tsx src/components/message-input.tsx
git commit -m "feat: add task card with live streaming and message input"
```

---

## Chunk 5: UI — Pages

### Task 12: Main feed page

**Files:**
- Modify: `src/app/page.tsx`
- Create: `src/components/task-feed.tsx`

- [ ] **Step 1: Create task feed component**

Create `src/components/task-feed.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { TaskCard } from "./task-card";

type Task = {
  id: string;
  title: string;
  status: string;
  description: string;
  updatedAt: string;
};

export function TaskFeed() {
  const [tasks, setTasks] = useState<Task[]>([]);

  useEffect(() => {
    loadTasks();
    const interval = setInterval(loadTasks, 3000);
    return () => clearInterval(interval);
  }, []);

  async function loadTasks() {
    const res = await fetch("/api/tasks");
    if (res.ok) {
      setTasks(await res.json());
    }
  }

  if (tasks.length === 0) {
    return (
      <div className="py-12 text-center text-muted-foreground">
        No tasks yet. Create one to get started.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {tasks.map((task) => (
        <TaskCard key={task.id} task={task} />
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Update main page**

Modify `src/app/page.tsx`:

```tsx
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { TaskFeed } from "@/components/task-feed";

export default function Home() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Tasks</h1>
        <Button asChild>
          <Link href="/tasks/new">New Task</Link>
        </Button>
      </div>
      <TaskFeed />
    </div>
  );
}
```

- [ ] **Step 3: Verify in browser**

Open http://localhost:3000. Should show "No tasks yet" message with a "New Task" button.

- [ ] **Step 4: Commit**

```bash
git add src/app/page.tsx src/components/task-feed.tsx
git commit -m "feat: add main feed page with task list"
```

---

### Task 13: New task page

**Files:**
- Create: `src/app/tasks/new/page.tsx`
- Create: `src/components/new-task-form.tsx`
- Create: `src/components/project-selector.tsx`

- [ ] **Step 1: Create project selector**

Create `src/components/project-selector.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type Project = {
  id: string;
  name: string;
};

export function ProjectSelector({
  value,
  onChange,
}: {
  value: string;
  onChange: (id: string) => void;
}) {
  const [projects, setProjects] = useState<Project[]>([]);

  useEffect(() => {
    fetch("/api/projects")
      .then((r) => r.json())
      .then(setProjects);
  }, []);

  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger>
        <SelectValue placeholder="Select a project" />
      </SelectTrigger>
      <SelectContent>
        {projects.map((p) => (
          <SelectItem key={p.id} value={p.id}>
            {p.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
```

- [ ] **Step 2: Create new task form**

Create `src/components/new-task-form.tsx`:

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ProjectSelector } from "./project-selector";

export function NewTaskForm() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [projectId, setProjectId] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !projectId || submitting) return;

    setSubmitting(true);
    const res = await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: title.trim(),
        description: description.trim(),
        projectId,
      }),
    });

    if (res.ok) {
      const task = await res.json();
      router.push(`/tasks/${task.id}`);
    }
    setSubmitting(false);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <label className="text-sm font-medium">Project</label>
        <ProjectSelector value={projectId} onChange={setProjectId} />
      </div>
      <div className="space-y-2">
        <label className="text-sm font-medium">Title</label>
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What should the agent do?"
        />
      </div>
      <div className="space-y-2">
        <label className="text-sm font-medium">Description</label>
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Additional context, requirements, constraints..."
          rows={4}
        />
      </div>
      <Button type="submit" disabled={submitting || !title.trim() || !projectId}>
        {submitting ? "Creating..." : "Create Task"}
      </Button>
    </form>
  );
}
```

- [ ] **Step 3: Create new task page**

Create `src/app/tasks/new/page.tsx`:

```tsx
import { NewTaskForm } from "@/components/new-task-form";

export default function NewTaskPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">New Task</h1>
      <NewTaskForm />
    </div>
  );
}
```

- [ ] **Step 4: Verify in browser**

Navigate to http://localhost:3000/tasks/new. Create a project first (via settings page or curl), then create a task. Should redirect to the task detail page.

- [ ] **Step 5: Commit**

```bash
git add src/app/tasks/new/ src/components/new-task-form.tsx src/components/project-selector.tsx
git commit -m "feat: add new task page with project selector"
```

---

### Task 14: Task detail page

**Files:**
- Create: `src/app/tasks/[id]/page.tsx`

- [ ] **Step 1: Create task detail page**

Create `src/app/tasks/[id]/page.tsx`:

```tsx
import { db } from "@/db";
import { tasks } from "@/db/schema";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { StatusBadge } from "@/components/status-badge";
import { TaskStream } from "@/components/task-stream";
import { MessageInput } from "@/components/message-input";

export default async function TaskDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const task = db.select().from(tasks).where(eq(tasks.id, id)).get();

  if (!task) notFound();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{task.title}</h1>
        <StatusBadge status={task.status} />
      </div>

      {task.description && (
        <p className="text-muted-foreground">{task.description}</p>
      )}

      <TaskStream taskId={task.id} />

      {(task.status === "running" || task.status === "blocked") && (
        <MessageInput taskId={task.id} />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify in browser**

Navigate to a task URL directly. Should show the task title, status, message stream, and reply input (if running/blocked).

- [ ] **Step 3: Commit**

```bash
git add src/app/tasks/\[id\]/page.tsx
git commit -m "feat: add task detail page with live streaming"
```

---

### Task 15: Settings page (project management)

**Files:**
- Create: `src/app/settings/page.tsx`
- Create: `src/components/project-list.tsx`

- [ ] **Step 1: Create project list component**

Create `src/components/project-list.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

type Project = {
  id: string;
  name: string;
  githubRepo: string | null;
  createdAt: string;
};

export function ProjectList() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    loadProjects();
  }, []);

  async function loadProjects() {
    const res = await fetch("/api/projects");
    if (res.ok) setProjects(await res.json());
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || creating) return;

    setCreating(true);
    await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim() }),
    });
    setName("");
    setCreating(false);
    loadProjects();
  }

  return (
    <div className="space-y-4">
      <form onSubmit={handleCreate} className="flex gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Project name"
          className="flex-1"
        />
        <Button type="submit" disabled={creating || !name.trim()}>
          Add
        </Button>
      </form>

      {projects.length === 0 ? (
        <p className="text-muted-foreground">No projects yet.</p>
      ) : (
        <div className="space-y-2">
          {projects.map((p) => (
            <Card key={p.id}>
              <CardHeader className="py-3">
                <span className="font-medium">{p.name}</span>
              </CardHeader>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Create settings page**

Create `src/app/settings/page.tsx`:

```tsx
import { ProjectList } from "@/components/project-list";

export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Settings</h1>
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Projects</h2>
        <ProjectList />
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Verify in browser**

Navigate to http://localhost:3000/settings. Add a project, verify it appears in the list.

- [ ] **Step 4: Commit**

```bash
git add src/app/settings/ src/components/project-list.tsx
git commit -m "feat: add settings page with project management"
```

---

## Chunk 6: PWA + Polish

### Task 16: PWA manifest

**Files:**
- Create: `src/app/manifest.ts`

- [ ] **Step 1: Create PWA manifest**

Create `src/app/manifest.ts`:

```typescript
import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Interlude",
    short_name: "Interlude",
    description: "Agent-first development environment",
    start_url: "/",
    display: "standalone",
    background_color: "#09090b",
    theme_color: "#09090b",
    icons: [
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
      },
    ],
  };
}
```

- [ ] **Step 2: Add viewport meta for mobile**

Ensure `src/app/layout.tsx` metadata includes:

```typescript
export const metadata: Metadata = {
  title: "Interlude",
  description: "Agent-first development environment",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Interlude",
  },
};
```

- [ ] **Step 3: Commit**

```bash
git add src/app/manifest.ts src/app/layout.tsx
git commit -m "feat: add PWA manifest for installability"
```

---

### Task 17: End-to-end smoke test

No new files — this is a manual verification task.

- [ ] **Step 1: Start dev server**

```bash
pnpm dev
```

- [ ] **Step 2: Create a project**

Go to http://localhost:3000/settings, add a project called "test-project".

- [ ] **Step 3: Create a task**

Go to http://localhost:3000/tasks/new, select the project, enter a title, submit.

- [ ] **Step 4: Trigger mock agent**

```bash
curl -s -X POST http://localhost:3000/api/tasks/TASK_ID/mock-run \
  -H 'Content-Type: application/json' -d '{}'
```

- [ ] **Step 5: Watch the stream**

Go back to http://localhost:3000. The task should auto-expand and show messages streaming in live. Verify:
- Messages appear one by one
- Status badge updates
- Reply input is visible while running
- Task collapses when completed (on next feed refresh)

- [ ] **Step 6: Test on mobile viewport**

Use browser DevTools to switch to a mobile viewport (375px wide). Verify the layout is usable.

- [ ] **Step 7: Commit any fixes**

If any issues found, fix and commit.

---

That's the full Phase 1 plan — 17 tasks across 6 chunks.
