"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function Header() {
  const pathname = usePathname();
  // The fleet dashboard (home) and the session entry screen (/tasks/new) carry
  // their own instrument-panel chrome (issue #64)
  if (pathname === "/" || pathname === "/tasks/new") return null;

  return (
    <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex h-14 max-w-2xl items-center justify-between px-4">
        <Link href="/" className="text-lg font-semibold">
          Interlude
        </Link>
        <nav className="flex items-center gap-4 text-sm">
          <Link
            href="/tasks"
            className="text-muted-foreground hover:text-foreground"
          >
            Tasks
          </Link>
          <Link
            href="/settings"
            className="text-muted-foreground hover:text-foreground"
          >
            Settings
          </Link>
        </nav>
      </div>
    </header>
  );
}
