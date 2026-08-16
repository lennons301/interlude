"use client";

import { ControlButton, PANEL, TONES } from "@/components/fleet/fleet-bits";

/**
 * The pause between pressing a control and it happening, for the two controls
 * on the settings screen that authorise unattended spend: arming a project, and
 * lifting the fleet-wide kill switch. One component so the two can't drift into
 * asking differently — the tone says which kind of yes this is (`cool` for the
 * ordinary one, `amber` when it overrides a warning), and the prose above the
 * buttons says exactly what will happen.
 *
 * Full width and last in its row: it opens *under* whatever was pressed, so the
 * card doesn't rearrange itself beneath the owner's finger.
 */
export function ConfirmStrip({
  label,
  tone,
  confirm,
  busyLabel,
  busy,
  error,
  onConfirm,
  onCancel,
  children,
}: {
  /** Names the decision for a screen reader, e.g. "Confirm arming lemons". */
  label: string;
  tone: "cool" | "amber";
  /** The affirmative button's text — always a verb, never "OK". */
  confirm: string;
  busyLabel: string;
  busy: boolean;
  /** Why the last confirmation didn't take, if it didn't. */
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  /** What is about to happen, in the owner's language. */
  children: React.ReactNode;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={`order-last w-full ${PANEL} ${TONES[tone]}`}
    >
      {children}
      <div className="flex flex-wrap gap-2">
        <ControlButton tone={tone} disabled={busy} onClick={onConfirm}>
          {busy ? busyLabel : confirm}
        </ControlButton>
        <ControlButton disabled={busy} onClick={onCancel}>
          cancel
        </ControlButton>
      </div>
      {error !== null && (
        <p role="alert" className="text-[13px] text-fl-red">
          {error}
        </p>
      )}
    </div>
  );
}
