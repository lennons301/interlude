/**
 * Shared atoms of the fleet's metering language: everything countable is
 * discrete segments or pips, everything continuous is a 3px hairline gauge
 * with a tick at its ceiling. Color is strictly semantic.
 */

import type { PickupPause } from "@/lib/fleet/fleet-view";

/** The system's one focus affordance: a hairline ring in the quietest ink, so
 * keyboard users get a visible target without a colour that means something. */
export const FOCUS_RING =
  "focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-fl-ink-3";

/** The one text-input skin in the system — a fleet card behind a hairline, Plex
 * on top. Shared by every form the app has so a field can't drift between
 * screens. */
export const FIELD =
  "w-full rounded-[4px] border border-fl-line bg-fl-card px-3 py-2 text-sm text-fl-ink " +
  "placeholder:text-fl-ink-3 focus:border-fl-line-strong focus:outline-none";

/** The geometry every panel and card in the system shares. Left untinted so a
 * caller can compose it with a `TONES` entry when the panel carries a state the
 * owner must not miss — a held fleet, a confirmation waiting on a press. */
export const PANEL = "space-y-2.5 rounded-[4px] border px-3 py-2.5";

/** A panel in its ordinary clothes: hairline over the card ground. */
export const PANEL_PLAIN = `${PANEL} border-fl-line bg-fl-card`;

export function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="font-plex-mono text-[11px] font-medium uppercase tracking-[0.14em] text-fl-ink-3">
      {children}
    </h2>
  );
}

export function Money({ usd }: { usd: number }) {
  return (
    <span className="font-plex-mono tabular-nums">${usd.toFixed(2)}</span>
  );
}

/** 3px hairline gauge; the tick marks the budget ceiling. */
export function Gauge({
  value,
  max,
  tone,
}: {
  value: number;
  max: number;
  tone: "green" | "red" | "cool";
}) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const fill =
    tone === "red"
      ? "bg-fl-red"
      : tone === "cool"
        ? "bg-fl-cool"
        : "bg-fl-green";
  return (
    <div className="relative h-[3px] w-full bg-fl-line">
      <div className={`absolute inset-y-0 left-0 ${fill}`} style={{ width: `${pct}%` }} />
      <div className="absolute -top-[2px] right-0 h-[7px] w-px bg-fl-line-strong" />
    </div>
  );
}

/** Attempt pips: ●●○ = attempt 2 of 3. */
export function AttemptPips({ current, max }: { current: number; max: number }) {
  return (
    <span className="font-plex-mono text-[11px] tracking-[0.1em] text-fl-ink-2" title={`attempt ${current}/${max}`}>
      {Array.from({ length: max }, (_, i) => (i < current ? "●" : "○")).join("")}
    </span>
  );
}

/** The one tone→classes map in the design system: border, wash, ink. Exported
 * because chips are not the only thing tinted by tone — the dashboard's pause
 * banner reads it too, rather than restating the class strings. */
export const TONES = {
  green: "border-fl-green/45 bg-fl-green/13 text-fl-green",
  cool: "border-fl-cool/45 bg-fl-cool/13 text-fl-cool",
  amber: "border-fl-amber/45 bg-fl-amber/13 text-fl-amber",
  red: "border-fl-red/45 bg-fl-red/13 text-fl-red",
  quiet: "border-fl-line bg-transparent text-fl-ink-3",
} as const;

export function Chip({
  tone,
  children,
}: {
  tone: keyof typeof TONES;
  children: React.ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-[4px] border px-1.5 py-px font-plex-mono text-[11px] lowercase ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}

/** A control in the instrument-panel voice: a chip you can press. Tone carries
 * the same meaning it carries everywhere — `cool` is the owner acting, `amber`
 * a deliberate hold or an override, `quiet` everything reversible — so a button
 * never invents a colour of its own. */
const BUTTON_TONES = {
  quiet: "border-fl-line text-fl-ink-2 hover:border-fl-line-strong hover:text-fl-ink",
  cool: `${TONES.cool} hover:opacity-90`,
  amber: `${TONES.amber} hover:opacity-90`,
} as const;

export function ControlButton({
  tone = "quiet",
  onClick,
  disabled,
  children,
  ...rest
}: {
  tone?: keyof typeof BUTTON_TONES;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
} & Pick<React.ButtonHTMLAttributes<HTMLButtonElement>, "aria-expanded" | "aria-label">) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-[4px] border px-2 py-0.5 font-plex-mono text-[11px] lowercase transition-opacity disabled:opacity-40 ${BUTTON_TONES[tone]} ${FOCUS_RING}`}
      {...rest}
    >
      {children}
    </button>
  );
}

/** The system's one filled control, for the single primary action on a form —
 * cool, because everything started from a form is the owner acting. */
export const PRIMARY_BUTTON =
  "rounded-[4px] bg-fl-cool px-4 py-2.5 text-sm font-medium text-fl-ground " +
  `transition-opacity hover:opacity-90 disabled:opacity-40 ${FOCUS_RING}`;

/** A resource that wouldn't load, said once for the whole app: what was being
 * read, why it failed, and the way back. */
export function LoadFailure({
  what,
  error,
  onRetry,
}: {
  what: string;
  error: string;
  onRetry: () => void;
}) {
  return (
    <div className="space-y-2">
      <p role="alert" className="text-[13px] text-fl-red">
        Couldn&apos;t load {what} — {error}.
      </p>
      <ControlButton onClick={onRetry}>retry</ControlButton>
    </div>
  );
}

/** The one ambient animation on the page. `held` is a deliberate operator hold
 * on pickup — the kill switch (issue #118) — so it reads amber like the banner
 * beside it, where `paused` (the breached daily cap) reads red. `off` is the
 * boot master `AUTONOMY_ENABLED` (issue #148): amber too, because it is just as
 * deliberate, but its own word — the dot prints its state, and an owner who
 * reads `held` goes to press a switch that cannot start a sweep. */
export type LiveDotState = "live" | "off" | "held" | "paused" | "offline";

const DOT_COLOR: Record<LiveDotState, string> = {
  live: "bg-fl-green",
  off: "bg-fl-amber",
  held: "bg-fl-amber",
  paused: "bg-fl-red",
  offline: "bg-fl-ink-3",
};

/**
 * How a fleet-wide hold on pickup reads (issues #118, #148) — one map, here,
 * because more than one component names the hold and they must not drift: the
 * dot and banner at the top of the dashboard, and the quiet sub-line under
 * "Nothing needs you", which would otherwise still report the fleet as armed.
 *
 * A deliberate operator hold is amber and says "held"; the boot master is amber
 * too but says "off", because it is not the switch and is not lifted like one;
 * a breached spend ceiling is red and says "paused" — the estate's severity
 * vocabulary, and three states that are not the same news. Both maps are keyed
 * by the reason union, so a fourth hold fails the build rather than rendering
 * as though nothing were wrong.
 */
export const PAUSE_DOT: Record<PickupPause["reason"], LiveDotState> = {
  "autonomy-off-at-boot": "off",
  "kill-switch": "held",
  "daily-cap": "paused",
};

export const PAUSE_TONE: Record<PickupPause["reason"], keyof typeof TONES> = {
  "autonomy-off-at-boot": "amber",
  "kill-switch": "amber",
  "daily-cap": "red",
};

export function LiveDot({ state }: { state: LiveDotState }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={`h-1.5 w-1.5 rounded-full ${DOT_COLOR[state]} ${state === "live" ? "fleet-dot-live" : ""}`}
      />
      {state !== "live" && (
        <span className="font-plex-mono text-[11px] text-fl-ink-3">{state}</span>
      )}
    </span>
  );
}

export function formatElapsed(startedAt: string, now: number): string {
  const mins = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** Ledger day column: today / yest / mon…sun. */
export function formatDay(iso: string, now: Date): string {
  const date = new Date(iso);
  const startOfDay = (d: Date) => new Date(d).setHours(0, 0, 0, 0);
  const days = Math.round(
    (startOfDay(now) - startOfDay(date)) / (24 * 60 * 60 * 1000)
  );
  if (days <= 0) return "today";
  if (days === 1) return "yest";
  return date
    .toLocaleDateString("en-GB", { weekday: "short" })
    .toLowerCase();
}
