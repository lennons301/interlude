/**
 * A wall-clock bound on every outbound GitHub request (issue #151).
 *
 * A stalled call is not a failed call. Every helper in this directory catches
 * errors and degrades to null, but nothing bounded a request that simply never
 * answered — and on 2026-08-18 a post-turn `createDraftPr` that never returned
 * left the promise driving a queue reservation unsettled, wedging the box's only
 * slot until a restart. Same discipline as the Docker admission probe (#128): a
 * stalled dependency must never freeze dispatch.
 *
 * Installed as a `request.fetch` wrapper rather than a client option because
 * @octokit/request (v10) has no timeout of its own — it forwards only `fetch`
 * and `signal` from `request`. The wrapper is the better seam anyway: each
 * request gets its own deadline, so a paginated read is not racing one budget
 * across every page, and the signal it passes down bounds reading the response
 * body too, not just receiving the headers.
 */

/**
 * How long one GitHub request may take before it is aborted. Generous next to
 * GitHub's own latency (whole seconds are already an anomaly) and small next to
 * "never". Octokit's retry plugin will re-issue a timed-out request up to three
 * times with its own backoff, so a black-holed endpoint costs about a minute in
 * total rather than the life of the process.
 */
export const GITHUB_REQUEST_TIMEOUT_MS = 10_000;

type FetchImpl = typeof globalThis.fetch;

/** The request being timed out, for the log line and the error message. */
function requestTarget(input: Parameters<FetchImpl>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/**
 * Wrap a fetch implementation so no request can outlive `timeoutMs`. Both
 * halves matter: the deadline signal aborts the underlying request (so a
 * stalled connection is torn down rather than abandoned mid-flight), and the
 * race guarantees the *caller* is released at the deadline even if the fetch
 * implementation should ignore the signal it was given.
 *
 * `timeoutMs`/`fetchImpl` are injectable for tests; production callers use the
 * defaults, as with the admission probe's own bound.
 */
export function boundedFetch(
  timeoutMs: number = GITHUB_REQUEST_TIMEOUT_MS,
  fetchImpl: FetchImpl = (...args) => globalThis.fetch(...args)
): FetchImpl {
  return async (input, init) => {
    const target = requestTarget(input);
    const controller = new AbortController();
    // A caller's own signal still applies — this bound is layered on top of it,
    // never in place of it.
    const signal = init?.signal
      ? AbortSignal.any([init.signal, controller.signal])
      : controller.signal;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const message = `GitHub request ${target} timed out after ${timeoutMs}ms`;
        console.error(`[github] ${message} — aborting the request`);
        controller.abort(new Error(message));
        reject(new Error(message));
      }, timeoutMs);
      // Never a reason to hold the process open on its own.
      timer.unref?.();
    });

    try {
      return await Promise.race([fetchImpl(input, { ...init, signal }), deadline]);
    } finally {
      clearTimeout(timer);
    }
  };
}
