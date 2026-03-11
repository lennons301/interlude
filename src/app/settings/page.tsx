import { ProjectList } from "@/components/project-list";
import { DockerStatus } from "@/components/docker-status";

export default function SettingsPage() {
  return (
    <div className="space-y-6">
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
  );
}
