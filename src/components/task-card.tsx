import Link from "next/link";
import { Chip, FOCUS_RING, Money, formatElapsed } from "@/components/fleet/fleet-bits";
import {
  taskChip,
  taskTicket,
  type TaskChip,
  type TaskListRow,
} from "@/lib/tasks/organize-tasks";

/**
 * One row of the archive, in the fleet's card language (issue #120) — the same
 * shape as the dashboard's running cards, so a task reads identically wherever
 * you meet it: project and kind on top, the title as the line you scan, then
 * status, spend and last activity.
 */

// Tone follows the dashboard's mode vocabulary: work a human is driving reads
// cool, work the fleet drove itself reads green, and a read-only triage pass
// stays quiet.
const CHIP_TONE: Record<TaskChip, "cool" | "green" | "quiet"> = {
  chat: "cool",
  grill: "cool",
  spec: "cool",
  tickets: "cool",
  wayfinder: "cool",
  implement: "green",
  review: "green",
  repair: "green",
  triage: "quiet",
};

// Status is the one thing on the card that carries urgency, so it is coloured
// ink rather than a second chip: blocked wants you, failed went wrong, and a
// finished task recedes into the archive.
const STATUS_INK: Record<TaskListRow["status"], string> = {
  queued: "text-fl-cool",
  running: "text-fl-green",
  blocked: "text-fl-amber",
  completed: "text-fl-ink-3",
  failed: "text-fl-red",
  cancelled: "text-fl-ink-3",
};

export function TaskCard({ row, now }: { row: TaskListRow; now: number }) {
  const chip = taskChip(row);
  const ticket = taskTicket(row);

  return (
    <Link href={`/tasks/${row.id}`} className={`block ${FOCUS_RING}`}>
      <div
        className={`space-y-1.5 rounded-[4px] border border-fl-line bg-fl-card px-3 py-2.5 transition-colors hover:border-fl-line-strong ${
          row.status === "cancelled" ? "opacity-60" : ""
        }`}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="truncate font-plex-mono text-[12px] text-fl-ink-2">
            {row.projectName ?? "—"}
            {ticket && <span className="text-fl-ink"> {ticket}</span>}
          </span>
          <Chip tone={CHIP_TONE[chip]}>{chip}</Chip>
        </div>

        <p className="truncate text-sm text-fl-ink">{row.title}</p>

        <div className="flex items-center justify-between gap-2 font-plex-mono text-[11px] tabular-nums">
          <span className={STATUS_INK[row.status]}>{row.status}</span>
          <span className="flex items-center gap-2.5">
            <span className={row.costUsd > 0 ? "text-fl-ink-2" : "text-fl-ink-3"}>
              <Money usd={row.costUsd} />
            </span>
            <time dateTime={row.updatedAt} className="text-fl-ink-3">
              {formatElapsed(row.updatedAt, now)}
            </time>
          </span>
        </div>
      </div>
    </Link>
  );
}
