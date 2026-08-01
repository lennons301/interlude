import { FleetDashboard } from "@/components/fleet/fleet-dashboard";
import { plexMono, plexSans } from "./fleet-fonts";

// Apply a stored theme override before first paint so the dashboard never
// flashes the wrong ground.
const themeScript = `try{var t=localStorage.getItem("fleet-theme");if(t==="dark"||t==="light")document.documentElement.setAttribute("data-fleet-theme",t)}catch(e){}`;

export default function Home() {
  return (
    <div
      className={`${plexSans.variable} ${plexMono.variable} fleet min-h-dvh bg-fl-ground font-plex text-fl-ink antialiased`}
    >
      <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      <FleetDashboard />
    </div>
  );
}
