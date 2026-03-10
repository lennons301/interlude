"use client";

import { useEffect, useState } from "react";
import { TaskCard } from "./task-card";

type Task = {
  id: string;
  title: string;
  status: string;
  description: string;
  updatedAt: string;
};

export function TaskFeed() {
  const [tasks, setTasks] = useState<Task[]>([]);

  useEffect(() => {
    loadTasks();
    const interval = setInterval(loadTasks, 3000);
    return () => clearInterval(interval);
  }, []);

  async function loadTasks() {
    const res = await fetch("/api/tasks");
    if (res.ok) {
      setTasks(await res.json());
    }
  }

  if (tasks.length === 0) {
    return (
      <div className="py-12 text-center text-muted-foreground">
        No tasks yet. Create one to get started.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {tasks.map((task) => (
        <TaskCard key={task.id} task={task} />
      ))}
    </div>
  );
}
