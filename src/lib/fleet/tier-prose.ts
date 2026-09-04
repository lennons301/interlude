/**
 * The words both surfaces use for the tier figures (issue #198). The
 * dashboard's Tiers panel and the digest's Tiers section render one
 * `TierView`, and the *derived readings* of a row — how its verdicts read,
 * what the no-tier row is called, how a count is pluralised — live here so the
 * two cannot word the same row differently (the #148 argument, one level up
 * from the numbers).
 *
 * A leaf module importing only a type, deliberately: the panel is a client
 * component, and a value import from the read model would pull its whole
 * graph — budgets, the money guards, the quota gate — into the browser bundle.
 */
import type { TierOutcome } from "./fleet-view";

/** "1 attempt" / "3 attempts". */
export function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** How a row's posted verdicts read — "2 approve / 1 changes" — or null when
 * it has none, so both surfaces fall back to the same "no verdicts". */
export function describeVerdicts(verdicts: TierOutcome["verdicts"]): string | null {
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
