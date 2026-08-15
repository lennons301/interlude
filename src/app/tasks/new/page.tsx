import { AppShell } from "@/components/app-shell";
import { NewTaskForm } from "@/components/new-task-form";

export default function NewTaskPage() {
  return (
    <AppShell section="new" width="narrow">
      <h1 className="mb-6 mt-2 text-lg text-fl-ink">New task</h1>
      <NewTaskForm />
    </AppShell>
  );
}
