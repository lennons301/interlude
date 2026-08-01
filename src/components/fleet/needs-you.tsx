import Link from "next/link";
import type { FleetView, NeedsYouItem } from "@/lib/fleet/fleet-view";
import { Chip, Eyebrow } from "./fleet-bits";

const CAUSE_LABEL: Record<NeedsYouItem["cause"], string> = {
  blocked: "blocked question",
  signoff: "sign-off",
  exhausted: "exhausted",
  cap: "cap pause",
  preflight: "preflight",
};

const CAUSE_TONE: Record<NeedsYouItem["cause"], "amber" | "red"> = {
  blocked: "amber",
  signoff: "amber",
  exhausted: "red",
  cap: "red",
  preflight: "amber",
};

/** Quiet confirmation sub-line: "No active runs · queue empty · autonomy on" */
function quietSubline(view: FleetView): string {
  const parts = [
    view.running.length === 0
      ? "No active runs"
      : `${view.running.length} active run${view.running.length === 1 ? "" : "s"}`,
  ];
  if (view.queue.readyForAgent !== null) {
    parts.push(
      view.queue.readyForAgent === 0
        ? "queue empty"
        : `${view.queue.readyForAgent} ticket${view.queue.readyForAgent === 1 ? "" : "s"} still ready-for-agent`
    );
  }
  parts.push(view.autonomyOn ? "autonomy on" : "autonomy off");
  return parts.join(" · ");
}

export function NeedsYou({ view }: { view: FleetView }) {
  const items = view.needsYou;
  return (
    <section aria-label="Needs you" className="space-y-3">
      <div className="flex items-center gap-2">
        <Eyebrow>Needs you</Eyebrow>
        {items.length > 0 && (
          <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-[4px] bg-fl-amber px-1 font-plex-mono text-[11px] font-medium tabular-nums text-fl-on-amber">
            {items.length}
          </span>
        )}
      </div>

      {items.length === 0 ? (
        <div>
          <p className="text-sm text-fl-ink">Nothing needs you.</p>
          <p className="mt-0.5 font-plex-mono text-[11px] text-fl-ink-3">
            {quietSubline(view)}
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {items.map((item, i) => (
            <li
              key={i}
              className={`rounded-[4px] border border-fl-line bg-fl-card border-l-[3px] ${
                item.severity === "red" ? "border-l-fl-red" : "border-l-fl-amber"
              }`}
            >
              <div className="space-y-1.5 px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <Chip tone={CAUSE_TONE[item.cause]}>{CAUSE_LABEL[item.cause]}</Chip>
                  <span className="truncate font-plex-mono text-[11px] tabular-nums text-fl-ink-3">
                    {item.context}
                  </span>
                </div>
                <p className="text-sm leading-snug text-fl-ink">{item.body}</p>
                {item.action && (
                  <ActionLink href={item.action.href} label={item.action.label} />
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ActionLink({ href, label }: { href: string; label: string }) {
  const className =
    "font-plex-mono text-[12px] text-fl-cool underline decoration-fl-cool/45 underline-offset-2 hover:decoration-fl-cool";
  return href.startsWith("/") ? (
    <Link href={href} className={className}>
      {label} →
    </Link>
  ) : (
    <a href={href} target="_blank" rel="noreferrer" className={className}>
      {label} →
    </a>
  );
}
