/**
 * The words both surfaces use for the tier and harness figures (issues #198,
 * #223). The dashboard's Tiers and Harnesses panels and the digest's sections
 * of the same names render one `TierView` and one `HarnessView`, and the
 * *derived readings* of a row — how its verdicts read, what the no-tier and
 * unknown-harness rows are called, how a count is pluralised — live here so
 * the two cannot word the same row differently (the #148 argument, one level
 * up from the numbers). The run cards, the ledger and the needs-you lines
 * name a harness through the same `harnessLabel`.
 *
 * A leaf module importing only a type, deliberately: the panels are client
 * components, and a value import from the read model would pull its whole
 * graph — budgets, the money guards, the quota gate — into the browser bundle.
 */
import type { VerdictTally } from "./fleet-view";

/** "1 attempt" / "3 attempts" — and "2 passes", given its plural. */
export function counted(count: number, noun: string, plural = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : plural}`;
}

/** How a row's posted verdicts read — "2 approve / 1 changes" — or null when
 * it has none, so both surfaces fall back to the same "no verdicts". */
export function describeVerdicts(verdicts: VerdictTally): string | null {
  const parts = [
    verdicts.approve > 0 ? `${verdicts.approve} approve` : null,
    verdicts.requestChanges > 0 ? `${verdicts.requestChanges} changes` : null,
    verdicts.escalate > 0 ? `${verdicts.escalate} escalate` : null,
  ].filter((part) => part !== null);
  return parts.length > 0 ? parts.join(" / ") : null;
}

/** What a row is called on either surface, the no-tier row included. */
export function tierLabel(tier: string | null): string {
  return tier ?? "no tier";
}

/**
 * What a harness is called wherever one is named (issue #223): the adapter id
 * as stamped, or "unknown harness" for a row written before the stamp existed
 * — said, rather than attributed to whatever adapter the lane file names for
 * its lane today.
 */
export function harnessLabel(harness: string | null): string {
  return harness ?? "unknown harness";
}
