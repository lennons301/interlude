import { useCallback, useEffect, useState } from "react";

/**
 * One GET, held honestly: the screens that read a small JSON resource all want
 * the same three things, and each hand-rolling them is how one of them ends up
 * telling a different story about a failure than its neighbour.
 *
 * - `data === null` means *not loaded yet*, never "loaded, and empty" — that
 *   distinction is what stops a failed fetch rendering as an empty list.
 * - A failure surfaces as `error` and leaves whatever is already on screen
 *   alone, so a failed refresh is a staleness warning rather than a wipe.
 * - The request is aborted on unmount and on every reload, so a slow answer
 *   can't land on a screen that has moved on.
 *
 * `setData` is here because a mutation's own response is usually the freshest
 * copy there is (`PATCH /api/projects/[id]` answers with the re-preflighted
 * row): taking it beats re-fetching and hoping the two agree.
 *
 * The archive's poller (`task-feed.tsx`) deliberately stays its own: it
 * schedules by backoff on a cadence this has no opinion about, and folding both
 * into one hook would make it a configuration exercise.
 */
export interface Loaded<T> {
  /** null until the first successful load. */
  data: T | null;
  /** Why the last attempt failed, or null. Cleared by a successful load. */
  error: string | null;
  /** Re-run the GET; clears the current error. */
  reload: () => void;
  /** Put a value on screen the caller already has. */
  setData: React.Dispatch<React.SetStateAction<T | null>>;
}

export function useLoad<T>(url: string): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;

    (async () => {
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error(`the server answered ${res.status}`);
        const body: T = await res.json();
        if (stopped) return;
        setData(body);
        setError(null);
      } catch (err) {
        if (stopped || controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "the request failed");
      }
    })();

    return () => {
      stopped = true;
      controller.abort();
    };
  }, [url, attempt]);

  const reload = useCallback(() => {
    setError(null);
    setAttempt((n) => n + 1);
  }, []);

  return { data, error, reload, setData };
}
