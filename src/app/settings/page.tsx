import { AppShell } from "@/components/app-shell";
import { ProjectList } from "@/components/project-list";
import { DockerStatus } from "@/components/docker-status";

// Settings is reskinned (and gains the autonomy controls) by its own ticket;
// here it just moves inside the shared shell (issue #117).
export default function SettingsPage() {
  return (
    <AppShell section="settings">
      <div className="space-y-6 py-2">
        <h1 className="text-2xl font-bold">Settings</h1>
        <div className="space-y-4">
          <h2 className="text-lg font-semibold">Docker</h2>
          <DockerStatus />
        </div>
        <div className="space-y-4">
          <h2 className="text-lg font-semibold">Projects</h2>
          <ProjectList />
        </div>
      </div>
    </AppShell>
  );
}
