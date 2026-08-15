import type { Metadata } from "next";
import "./globals.css";
import { plexMono, plexSans } from "@/lib/fleet-fonts";
import { THEME_PRE_PAINT_SCRIPT } from "@/lib/fleet-theme";

export const metadata: Metadata = {
  title: "Interlude",
  description: "Agent-first development environment",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Interlude",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // The fleet design system is the app's ground, not one screen's (issue
    // #117): the self-hosted Plex fonts and the `.fleet` token scope are global,
    // so every route is fleet-themed from the first paint. The `dark` class
    // stays for the shadcn tokens the not-yet-reskinned screens still use —
    // they render exactly as before until their own ticket lands.
    //
    // suppressHydrationWarning: the pre-paint script below sets
    // data-fleet-theme on <html> before hydration.
    <html
      lang="en"
      className={`dark ${plexSans.variable} ${plexMono.variable}`}
      suppressHydrationWarning
    >
      <body className="fleet min-h-dvh bg-fl-ground font-plex text-fl-ink antialiased">
        <script dangerouslySetInnerHTML={{ __html: THEME_PRE_PAINT_SCRIPT }} />
        {children}
      </body>
    </html>
  );
}
