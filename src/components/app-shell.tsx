import Link from "next/link";
import { FOCUS_RING } from "@/components/fleet/fleet-bits";
import { ThemeToggle } from "@/components/fleet/theme-toggle";

/**
 * The one application shell (issue #117). Every screen wears the same chrome —
 * the mono `interlude / <section>` wordmark, the lowercase mono nav, and the
 * theme toggle — so the app reads as a single product instead of the two it had
 * grown into. The fleet fonts, `.fleet` token scope and pre-paint theme script
 * live in the root layout, so a shell is only chrome + layout, never theming.
 *
 * No `"use client"` here: a shell holds no state of its own, and the one
 * interactive part — the theme toggle — is its own client island. A page states
 * its own section rather than the shell sniffing the pathname, so there is no
 * client-side routing dependency and a new route can't silently inherit the
 * wrong marker.
 */

export type Section = "fleet" | "new" | "tasks" | "settings";

const NAV_ITEMS: ReadonlyArray<{ key: Section; href: string }> = [
  { key: "fleet", href: "/" },
  { key: "new", href: "/tasks/new" },
  { key: "tasks", href: "/tasks" },
  { key: "settings", href: "/settings" },
];

/** Measure of the screen: the dashboard widens to two columns on desktop,
 * the session-entry form stays one-handed, and the not-yet-reskinned screens
 * keep the reading width they have today. */
const WIDTHS = {
  narrow: "max-w-md",
  prose: "max-w-2xl",
  wide: "max-w-md min-[900px]:max-w-4xl",
} as const;

export function AppShell({
  section,
  width = "prose",
  accessory,
  children,
}: {
  section: Section;
  width?: keyof typeof WIDTHS;
  /** Status that belongs beside the wordmark — the fleet's SSE dot, say. */
  accessory?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className={`mx-auto w-full px-4 pb-10 ${WIDTHS[width]}`}>
      <header className="flex h-14 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="font-plex-mono text-[13px] font-medium lowercase">
            interlude <span className="text-fl-ink-3">/ {section}</span>
          </span>
          {accessory}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <nav
            aria-label="Sections"
            className="flex items-center gap-3 font-plex-mono text-[11px] lowercase"
          >
            {NAV_ITEMS.map((item) => (
              <Link
                key={item.key}
                href={item.href}
                aria-current={item.key === section ? "page" : undefined}
                className={`${FOCUS_RING} ${
                  item.key === section
                    ? "border-b border-fl-line-strong text-fl-ink"
                    : "text-fl-ink-3 hover:text-fl-ink"
                }`}
              >
                {item.key}
              </Link>
            ))}
          </nav>
          <ThemeToggle />
        </div>
      </header>
      <main>{children}</main>
    </div>
  );
}

/**
 * The slim variant, for the full-height live view: a compact bar with
 * back-to-fleet and the task's identity, no nav, so chat and preview keep every
 * pixel of vertical space. Owns the viewport height; children get a
 * `min-h-0 flex-1` column to fill.
 */
export function SlimShell({
  title,
  accessory,
  children,
}: {
  title: string;
  /** Live status that belongs in the bar rather than the transcript. */
  accessory?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-dvh flex-col">
      <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-fl-line px-4">
        <span className="flex min-w-0 items-center gap-3">
          <Link
            href="/"
            className={`shrink-0 font-plex-mono text-[11px] lowercase text-fl-ink-3 hover:text-fl-ink ${FOCUS_RING}`}
          >
            ← fleet
          </Link>
          <span className="truncate text-[13px] text-fl-ink">{title}</span>
        </span>
        <span className="flex shrink-0 items-center gap-3">
          {accessory}
          <ThemeToggle />
        </span>
      </header>
      <main className="flex min-h-0 flex-1 flex-col">{children}</main>
    </div>
  );
}
