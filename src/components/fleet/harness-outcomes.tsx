import type { FleetView, HarnessOutcome } from "@/lib/fleet/fleet-view";
import { counted, describeVerdicts, harnessLabel } from "@/lib/fleet/tier-prose";
import { Eyebrow, Money } from "./fleet-bits";

/**
 * What each harness has been costing (issue #223) — the Tiers panel's shape,
 * read one axis over, so "is the cheaper vendor costing me attempts?" is
 * answered from evidence rather than impression.
 *
 * Straight off the shared read model — the digest prints the same figures —
 * so this panel is a renderer and nothing here decides anything. One row per
 * harness: attempts on how many tickets, the attempts burned, the review
 * verdicts, and the spend over the passes that ran there. The two units are
 * deliberate and the row says both: an attempt is consumed once and sits
 * under the harness that did its work last, while spend follows each pass to
 * the harness that spent it, so a run that moved across adapters charges each
 * vendor for its own work — and a harness with passes but no attempts is one
 * that worked on attempts that ended elsewhere.
 *
 * A quiet panel, as Tiers is: a harness is a name, not a severity. Only the
 * count of burned attempts reads red. A row from before the stamp existed is
 * "unknown harness", quieter still, rather than a guess from the lane file.
 */
export function HarnessOutcomes({ view }: { view: FleetView }) {
  const { byHarness, windowDays } = view.harnesses;
  return (
    <section aria-label="Harnesses" className="space-y-3">
      <Eyebrow>Harnesses · {windowDays} days</Eyebrow>
      {byHarness.length === 0 ? (
        <p className="font-plex-mono text-[11px] text-fl-ink-3">
          no tickets claimed this week
        </p>
      ) : (
        <table className="w-full table-fixed border-collapse text-sm">
          <tbody>
            {byHarness.map((row) => (
              <HarnessRow key={row.harness ?? "unknown"} row={row} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function HarnessRow({ row }: { row: HarnessOutcome }) {
  return (
    <tr className="border-t border-fl-line first:border-t-0">
      <td className="w-[6rem] py-2 pr-2 align-top">
        <span
          className={`block truncate font-plex-mono text-[12px] ${
            row.harness === null ? "text-fl-ink-3" : "text-fl-ink"
          }`}
        >
          {harnessLabel(row.harness)}
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
          {counted(row.passes, "pass", "passes")}
        </span>
      </td>
      <td className="w-16 py-2 text-right align-top font-plex-mono text-[12px] tabular-nums text-fl-ink-2">
        <Money usd={row.spendUsd} />
      </td>
    </tr>
  );
}
