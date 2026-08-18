/**
 * What a task's stored status means, for everyone who has to ask. It lives here
 * rather than beside any one consumer because three very different callers need
 * the same answer: the composer's state machine, the live view that gates the
 * composer, and the queue's slot accounting (issue #151) — and a fleet that
 * disagreed with itself about whether a task had finished is exactly how a
 * reservation came to outlive its task.
 */

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

/** A task that has stopped for good — one-way: nothing moves a task back out of
 * these, so whatever it held (a container, a queue reservation) is releasable. */
export function isTerminalTaskStatus(status: string): boolean {
  return TERMINAL.has(status);
}
