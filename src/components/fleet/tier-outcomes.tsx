import type { FleetView, TierOutcome } from "@/lib/fleet/fleet-view";
import { counted, describeVerdicts, tierLabel } from "@/lib/fleet/tier-prose";
import { Eyebrow, Money } from "./fleet-bits";

/**
 * Whether per-ticket tier routing is actually running, and what each tier has
 * been costing (issue #198).
 *
 * Two readings, both straight off the shared read model — the digest prints
 * the same figures — so this panel is a renderer and nothing here decides
 * anything:
 *
 *  - **Coverage**, in the header: how many of the week's claims carried a
 *    declared tier. Without it a savings claim is drawn from the tickets that
 *    happened to declare one — a biased sample — which is why the claims that
 *    declared none are said in their own line rather than left as the gap
 *    between two numbers.
 *  - **Outcome by tier**, one row each: attempts on how many tickets, the
 *    attempts burned, the review verdicts and the spend. Routing work down
 *    fails by burning extra attempts and a repair, costing more than the tier
 *    saved, and that shows up here as attempts per ticket and failures beside
 *    a dollar figure. `declared` says how much of the row is routed work, and
 *    `stepped down` how much of it arrived by the ladder rather than by a
 *    ticket's choice.
 *
 * A quiet panel: a tier is not a severity, so the rows carry no tone. Only
 * the count of burned attempts reads red, as a failed item does in the ledger
 * above it.
 */
export function TierOutcomes({ view }: { view: FleetView }) {
  const { coverage, byTier, windowDays } = view.tiers;
  return (
    <section aria-label="Tiers" className="space-y-3">
      <div className="flex items-baseline justify-between">
        <Eyebrow>Tiers · {windowDays} days</Eyebrow>
        {coverage.claimed > 0 && (
          <span className="font-plex-mono text-[11px] tabular-nums text-fl-ink-3">
            {coverage.declared}/{coverage.claimed} declared · {coverage.percent}%
          </span>
        )}
      </div>
      {coverage.claimed === 0 ? (
        <p className="font-plex-mono text-[11px] text-fl-ink-3">
          no tickets claimed this week
        </p>
      ) : (
        <>
          {coverage.undeclared > 0 && (
            <p className="font-plex-mono text-[11px] text-fl-ink-3">
              {counted(coverage.undeclared, "attempt")} ran on the default tier —
              the ticket named none
            </p>
          )}
          <table className="w-full table-fixed border-collapse text-sm">
            <tbody>
              {byTier.map((row) => (
                <TierRow key={row.tier ?? "none"} row={row} />
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

function TierRow({ row }: { row: TierOutcome }) {
  return (
    <tr className="border-t border-fl-line first:border-t-0">
      <td className="w-[4.5rem] py-2 pr-2 align-top">
        {/* The tier is a name, not a state — and a pinned raw model id is a
            long one, so it truncates rather than wrapping the row. */}
        <span
          className={`block truncate font-plex-mono text-[12px] ${
            row.tier === null ? "text-fl-ink-3" : "text-fl-ink"
          }`}
        >
          {tierLabel(row.tier)}
        </span>
      </td>
      <td className="py-2 pr-2 align-top">
        <span className="block truncate font-plex-mono text-[12px] tabular-nums leading-snug text-fl-ink-2">
          {counted(row.attempts, "attempt")} · {counted(row.tickets, "ticket")}
        </span>
        <span className="block truncate font-plex-mono text-[11px] tabular-nums text-fl-ink-3">
          <span className={row.failed > 0 ? "text-fl-red" : undefined}>
            {row.failed} failed
          </span>
          {" · "}
          {describeVerdicts(row.verdicts) ?? "no verdicts"}
          {" · "}
          {row.declared} declared
          {row.degraded > 0 && `, ${row.degraded} stepped down`}
        </span>
      </td>
      <td className="w-16 py-2 text-right align-top font-plex-mono text-[12px] tabular-nums text-fl-ink-2">
        <Money usd={row.spendUsd} />
      </td>
    </tr>
  );
}
