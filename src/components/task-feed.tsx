"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Eyebrow, FOCUS_RING } from "@/components/fleet/fleet-bits";
import { TaskCard } from "./task-card";
import {
  organizeTasks,
  type TaskFilter,
  type TaskListRow,
} from "@/lib/tasks/organize-tasks";

/**
 * The archive of every session and run (issue #120). The list itself is the
 * pure `organizeTasks` selector's output; this component owns only the read
 * path and the filter state.
 *
 * The read path is deliberate about three things that made this screen lie in
 * production: a poll is scheduled only once the previous one has settled (never
 * overlapping, and aborted on unmount), a failed load renders as a failure with
 * a retry rather than as an empty archive, and the empty state is shown only
 * for a confirmed empty result.
 */

const POLL_MS = 3000;

/** Matches the API's default bound; stated here so the list can say when it is
 * showing a capped view rather than everything. */
const LIST_LIMIT = 200;

export function TaskFeed() {
  // null = never loaded. Distinguishing "no answer yet" from "answered, empty"
  // is the whole reason a failed fetch can't masquerade as an empty archive.
  const [rows, setRows] = useState<TaskListRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const res = await fetch(`/api/tasks?limit=${LIST_LIMIT}`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`the server answered ${res.status}`);
        const data: TaskListRow[] = await res.json();
        if (stopped) return;
        setRows(data);
        setError(null);
      } catch (err) {
        if (stopped || controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "the request failed");
      }
      // Scheduled only after a request has settled, so a slow connection can
      // never pile polls on top of each other.
      if (!stopped) timer = setTimeout(poll, POLL_MS);
    };

    poll();

    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [reloadKey]);

  // Local clock for the relative times, ticking between polls. Only ever read
  // once rows have arrived (client-side), so the SSR pass renders no time.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const retry = () => {
    setError(null);
    setReloadKey((key) => key + 1);
  };

  if (rows === null) {
    return error === null ? (
      <p className="py-12 text-center font-plex-mono text-[11px] text-fl-ink-3">
        loading…
      </p>
    ) : (
      <div className="space-y-3 py-12 text-center">
        <p role="alert" className="text-sm text-fl-red">
          Couldn&apos;t load your tasks — {error}.
        </p>
        <RetryButton onClick={retry} />
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="space-y-3 py-12 text-center">
        <p className="text-sm text-fl-ink-2">No tasks yet.</p>
        <p className="text-[13px] text-fl-ink-3">
          Start a chat task or a generation session from{" "}
          <Link href="/tasks/new" className={`text-fl-cool hover:underline ${FOCUS_RING}`}>
            new
          </Link>
          , or label a GitHub issue <span className="font-plex-mono">interlude</span>.
        </p>
      </div>
    );
  }

  const organized = organizeTasks(rows, filter);
  // The filter offers only kinds that exist — plus the active one if the data
  // has moved on beneath it, so a narrowed-to-nothing list is never a dead end.
  const options =
    filter === "all" || organized.chips.some((c) => c.chip === filter)
      ? organized.chips
      : [...organized.chips, { chip: filter, count: 0 }];
  const emptyNote = filter === "all" ? "none yet" : "none of this kind";

  return (
    <div className="space-y-6">
      {/* A refresh that failed while rows are already on screen is a staleness
          warning, not a wipe — the list stays, and says so. */}
      {error !== null && (
        <p
          role="alert"
          className="flex flex-wrap items-center gap-2 rounded-[4px] border border-fl-amber/45 bg-fl-amber/13 px-3 py-2 text-[13px] text-fl-amber"
        >
          <span>Not refreshing — {error}.</span>
          <RetryButton onClick={retry} />
        </p>
      )}

      <div
        role="group"
        aria-label="Filter by kind"
        className="flex flex-wrap items-center gap-x-3 gap-y-1.5 font-plex-mono text-[11px] lowercase"
      >
        <FilterOption
          label="all"
          count={organized.total}
          active={filter === "all"}
          onSelect={() => setFilter("all")}
        />
        {options.map(({ chip, count }) => (
          <FilterOption
            key={chip}
            label={chip}
            count={count}
            active={filter === chip}
            onSelect={() => setFilter(chip)}
          />
        ))}
      </div>

      <Section
        title="Sessions"
        empty={emptyNote}
        rows={organized.interactive}
        now={now}
      />
      <Section
        title="Autonomous runs"
        empty={emptyNote}
        rows={organized.autonomous}
        now={now}
      />

      {rows.length >= LIST_LIMIT && (
        <p className="font-plex-mono text-[11px] text-fl-ink-3">
          showing the {LIST_LIMIT} most recent
        </p>
      )}
    </div>
  );
}

function Section({
  title,
  empty,
  rows,
  now,
}: {
  title: string;
  empty: string;
  rows: TaskListRow[];
  now: number;
}) {
  return (
    <section aria-label={title} className="space-y-3">
      <Eyebrow>{title}</Eyebrow>
      {rows.length === 0 ? (
        <p className="font-plex-mono text-[11px] text-fl-ink-3">{empty}</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => (
            <li key={row.id}>
              <TaskCard row={row} now={now} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function FilterOption({
  label,
  count,
  active,
  onSelect,
}: {
  label: string;
  count: number;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onSelect}
      className={`${FOCUS_RING} ${
        active
          ? "border-b border-fl-line-strong text-fl-ink"
          : "text-fl-ink-3 hover:text-fl-ink"
      }`}
    >
      {label} <span className="tabular-nums text-fl-ink-3">{count}</span>
    </button>
  );
}

function RetryButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-[4px] border border-fl-line px-2 py-0.5 font-plex-mono text-[11px] lowercase text-fl-ink-2 hover:border-fl-line-strong hover:text-fl-ink ${FOCUS_RING}`}
    >
      retry
    </button>
  );
}
