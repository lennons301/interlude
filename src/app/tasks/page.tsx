import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { FOCUS_RING } from "@/components/fleet/fleet-bits";
import { TaskFeed } from "@/components/task-feed";

// The archive of every session and run, in the fleet system (issue #120). The
// heading matches /tasks/new's; the shell already carries the nav, so the entry
// point here is a quiet mono link rather than a second primary button.
export default function TasksPage() {
  return (
    <AppShell section="tasks">
      <div className="space-y-6">
        <div className="mb-6 mt-2 flex items-baseline justify-between gap-3">
          <h1 className="text-lg text-fl-ink">Tasks</h1>
          <Link
            href="/tasks/new"
            className={`font-plex-mono text-[11px] lowercase text-fl-cool hover:underline ${FOCUS_RING}`}
          >
            + new task
          </Link>
        </div>
        <TaskFeed />
      </div>
    </AppShell>
  );
}
