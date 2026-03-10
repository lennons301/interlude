import { NewTaskForm } from "@/components/new-task-form";

export default function NewTaskPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">New Task</h1>
      <NewTaskForm />
    </div>
  );
}
