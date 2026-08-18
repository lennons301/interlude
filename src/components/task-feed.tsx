"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ControlButton, Eyebrow, FOCUS_RING } from "@/components/fleet/fleet-bits";
import { TaskCard } from "./task-card";
import {
  filterOptions,
  listState,
  organizeTasks,
  TASK_LIST_LIMIT,
  type ChipCount,
  type TaskFilter,
  type TaskListRow,
} from "@/lib/tasks/organize-tasks";

/**
 * The archive of every session and run (issue #120). The list, the screen's
 * state and the filter row's options are all pure selectors' output; this
 * component owns only the read path and the filter state.
 *
 * The read path is deliberate about the three things that made this screen lie
 * in production: a poll is scheduled only once the previous one has settled
 * (never overlapping, and aborted on unmount), a failed load renders as a
 * failure with a retry rather than as an empty archive, and the empty state is
 * reached only from a confirmed empty result that nothing has failed since —
 * now `listState`, out where it can be tested.
 *
 * The filter goes to the server (issue #142). It has to: the archive is bounded
 * to the most recent rows, so narrowing after the bound could only ever narrow
 * the window, and the sessions worth revisiting had already fallen out of it.
 */

/** An archive, not a live surface — the dashboard is where seconds matter, so
 * this refreshes at a rate a phone on mobile data can afford. */
const POLL_MS = 10_000;

/** While the load is failing, back off rather than hammering a server that is
 * already unwell; `retry` is what shortcuts back to the fast cadence. */
const MAX_BACKOFF_MS = 60_000;

/** What the last *unfiltered* load found: the filter row is drawn from this, so
 * every other kind stays on offer while one of them is active. */
interface Vocabulary {
  chips: ChipCount[];
  total: number;
}

export function TaskFeed() {
  // null = never loaded. Distinguishing "no answer yet" from "answered, empty"
  // is the whole reason a failed fetch can't masquerade as an empty archive.
  const [rows, setRows] = useState<TaskListRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [vocabulary, setVocabulary] = useState<Vocabulary | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;

    const poll = async () => {
      try {
        // The route's `kind` vocabulary is this component's own filter type, so
        // the active filter goes over as it stands — `all` included.
        const res = await fetch(
          `/api/tasks?kind=${filter}&limit=${TASK_LIST_LIMIT}`,
          { signal: controller.signal }
        );
        if (!res.ok) throw new Error(`the server answered ${res.status}`);
        const data: TaskListRow[] = await res.json();
        if (stopped) return;
        setRows(data);
        // Only an unfiltered answer describes the whole archive, so only one
        // refreshes the filter row; a narrowed answer would otherwise leave the
        // active chip as the only way out of itself.
        if (filter === "all") {
          setVocabulary({
            chips: organizeTasks(data, "all").chips,
            total: data.length,
          });
        }
        setError(null);
        failures = 0;
      } catch (err) {
        if (stopped || controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "the request failed");
        failures += 1;
      }
      // Scheduled only after a request has settled, so a slow connection can
      // never pile polls on top of each other.
      if (!stopped) {
        timer = setTimeout(
          poll,
          Math.min(POLL_MS * 2 ** failures, MAX_BACKOFF_MS)
        );
      }
    };

    poll();

    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [reloadKey, filter]);

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

  // Memoised so the 30s clock tick — which exists only to age the relative
  // times — doesn't re-derive the whole list behind it. The filter is applied
  // here as well as in SQL: between pressing a chip and its answer arriving,
  // these are still the previous query's rows, and narrowing them is what makes
  // the list correct in the meantime instead of briefly wrong.
  const organized = useMemo(
    () => organizeTasks(rows ?? [], filter),
    [rows, filter]
  );

  const view = listState(rows, error, filter !== "all");

  if (view.state === "failed") {
    return (
      <div className="space-y-3 py-12 text-center">
        <p role="alert" className="text-sm text-fl-red">
          Couldn&apos;t load your tasks — {view.error}.
        </p>
        <RetryButton onClick={retry} />
      </div>
    );
  }

  if (view.state === "loading") {
    return (
      <p className="py-12 text-center font-plex-mono text-[11px] text-fl-ink-3">
        loading…
      </p>
    );
  }

  if (view.state === "empty") {
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

  // Before the first unfiltered answer lands there is nothing else to read the
  // vocabulary from, and under `all` the two agree by construction.
  const seen = vocabulary ?? { chips: organized.chips, total: organized.total };
  const options = filterOptions(seen.chips, organized.chips, filter);
  const emptyNote = filter === "all" ? "none yet" : "none of this kind";
  const bounded = (rows ?? []).length >= TASK_LIST_LIMIT;

  return (
    <div className="space-y-6">
      {/* A refresh that failed while rows are already on screen is a staleness
          warning, not a wipe — the list stays, and says so. */}
      {view.stale !== null && (
        <p
          role="alert"
          className="flex flex-wrap items-center gap-2 rounded-[4px] border border-fl-amber/45 bg-fl-amber/13 px-3 py-2 text-[13px] text-fl-amber"
        >
          <span>Not refreshing — {view.stale}.</span>
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
          count={seen.total}
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

      {bounded && (
        <p className="font-plex-mono text-[11px] text-fl-ink-3">
          showing the {TASK_LIST_LIMIT} most recently active{" "}
          {filter === "all" ? "tasks" : `${filter} tasks`}
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
  return <ControlButton onClick={onClick}>retry</ControlButton>;
}
