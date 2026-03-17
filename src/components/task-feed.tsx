"use client";

import { useEffect, useState } from "react";
import { TaskCard } from "./task-card";

type Task = {
  id: string;
  title: string;
  status: string;
  description: string;
  containerStatus: string | null;
  updatedAt: string;
};

export function TaskFeed() {
  const [tasks, setTasks] = useState<Task[]>([]);

  useEffect(() => {
    const fetchTasks = () => {
      fetch("/api/tasks").then(async (res) => {
        if (res.ok) setTasks(await res.json());
      });
    };
    fetchTasks();
    const interval = setInterval(fetchTasks, 3000);
    return () => clearInterval(interval);
  }, []);

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
