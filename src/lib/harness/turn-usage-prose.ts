/**
 * The tokens clause of a harness's turn-complete note, written once for every
 * adapter whose stream reports usage but no trustworthy dollar figure (issues
 * #225, #224): `N input tokens, of which M cache reads and W cache writes,
 * K output tokens`.
 *
 * "Input tokens" is the total the provider counted — plain, cache-read and
 * cache-written together — with the cached share broken out after it, because
 * a lane prices each share at its own rate and the split is what lets a booked
 * charge be checked against the rate card off the feed (and, on the same model
 * through two harnesses, what tells a native path from a skin path). The
 * clause names only what happened: a turn that touched no cache says nothing
 * about one. A leaf, in the fleet's `TurnTokenUsage` vocabulary, so any adapter
 * may use it and no feed drifts from another by copy.
 */

import type { TurnTokenUsage } from "../lanes/lane-cost";

/** The cached share as the clause after the input total, or "" when none. */
export function cacheDetail(usage: TurnTokenUsage): string {
  const parts: string[] = [];
  if (usage.cacheReadTokens > 0) parts.push(`${usage.cacheReadTokens} cache reads`);
  if (usage.cacheWriteTokens > 0) parts.push(`${usage.cacheWriteTokens} cache writes`);
  return parts.length === 0 ? "" : `, of which ${parts.join(" and ")}`;
}

/** The whole tokens clause: input total, its cached share, output. */
export function describeTurnTokens(usage: TurnTokenUsage): string {
  const input = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  return `${input} input tokens${cacheDetail(usage)}, ${usage.outputTokens} output tokens`;
}
