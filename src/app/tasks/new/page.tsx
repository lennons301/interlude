import { NewTaskForm } from "@/components/new-task-form";

export default function NewTaskPage() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-6 space-y-6">
      <h1 className="text-2xl font-bold">New Task</h1>
      <NewTaskForm />
    </div>
  );
}
