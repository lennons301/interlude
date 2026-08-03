import type { FleetView } from "@/lib/fleet/fleet-view";
import { Eyebrow, Money, formatDay } from "./fleet-bits";

/** Quiet 7-day ledger with the week total in the section header. */
export function RecentLedger({ view, now }: { view: FleetView; now: Date }) {
  const { items, totalUsd } = view.recent;
  return (
    <section aria-label="Recent" className="space-y-3">
      <div className="flex items-baseline justify-between">
        <Eyebrow>Recent · 7 days</Eyebrow>
        <span className="font-plex-mono text-[11px] tabular-nums text-fl-ink-3">
          <Money usd={totalUsd} />
        </span>
      </div>
      {items.length === 0 ? (
        <p className="font-plex-mono text-[11px] text-fl-ink-3">
          nothing completed this week
        </p>
      ) : (
        <table className="w-full table-fixed border-collapse text-sm">
          <tbody>
            {items.map((item, i) => (
              <tr key={i} className="border-t border-fl-line first:border-t-0">
                <td className="w-14 py-2 pr-2 align-top font-plex-mono text-[12px]">
                  {item.prUrl ? (
                    <a
                      href={item.prUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-fl-cool hover:underline"
                    >
                      #{item.prNumber}
                    </a>
                  ) : (
                    <span className="text-fl-ink-3">—</span>
                  )}
                </td>
                <td className="py-2 pr-2 align-top">
                  <span
                    className={`block truncate leading-snug ${
                      item.outcome === "failed" || item.outcome === "exhausted"
                        ? "text-fl-red"
                        : "text-fl-ink"
                    }`}
                  >
                    {item.title}
                  </span>
                  <span className="block truncate font-plex-mono text-[11px] text-fl-ink-3">
                    {item.projectName}
                  </span>
                </td>
                <td className="w-16 py-2 pr-2 text-right align-top font-plex-mono text-[12px] tabular-nums text-fl-ink-2">
                  <Money usd={item.costUsd} />
                </td>
                <td className="w-10 py-2 text-right align-top font-plex-mono text-[11px] text-fl-ink-3">
                  {formatDay(item.finishedAt, now)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
