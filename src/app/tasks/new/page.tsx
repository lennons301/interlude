import Link from "next/link";
import { NewTaskForm } from "@/components/new-task-form";
import { plexMono, plexSans } from "@/lib/fleet-fonts";

// Apply a stored theme override before first paint so the screen never flashes
// the wrong ground — mirrors the fleet dashboard (app/page.tsx).
const themeScript = `try{var t=localStorage.getItem("fleet-theme");if(t==="dark"||t==="light")document.documentElement.setAttribute("data-fleet-theme",t)}catch(e){}`;

// The session entry screen carries the fleet instrument-panel chrome so it
// reads as the same product as the dashboard (issue #64); the global header is
// suppressed here (see components/header.tsx).
export default function NewTaskPage() {
  return (
    <div
      className={`${plexSans.variable} ${plexMono.variable} fleet min-h-dvh bg-fl-ground font-plex text-fl-ink antialiased`}
    >
      <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      <div className="mx-auto w-full max-w-md px-4 pb-12">
        <header className="flex h-14 items-center justify-between">
          <span className="font-plex-mono text-[13px] font-medium lowercase">
            interlude <span className="text-fl-ink-3">/ new</span>
          </span>
          <nav className="flex items-center gap-3 font-plex-mono text-[11px] lowercase">
            <Link href="/" className="text-fl-ink-3 hover:text-fl-ink">
              fleet
            </Link>
            <Link href="/tasks" className="text-fl-ink-3 hover:text-fl-ink">
              tasks
            </Link>
          </nav>
        </header>
        <h1 className="mb-6 mt-2 text-lg text-fl-ink">New task</h1>
        <NewTaskForm />
      </div>
    </div>
  );
}
