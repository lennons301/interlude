import { FleetDashboard } from "@/components/fleet/fleet-dashboard";

// The dashboard wears the shared shell itself (issue #117) — it feeds the SSE
// liveness dot into the shell's wordmark accessory, which only the client
// component knows about. Fonts, tokens and the pre-paint theme script are the
// root layout's job now.
export default function Home() {
  return <FleetDashboard />;
}
