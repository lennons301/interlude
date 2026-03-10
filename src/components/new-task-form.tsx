"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ProjectSelector } from "./project-selector";

export function NewTaskForm() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [projectId, setProjectId] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !projectId || submitting) return;

    setSubmitting(true);
    const res = await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: title.trim(),
        description: description.trim(),
        projectId,
      }),
    });

    if (res.ok) {
      const task = await res.json();
      router.push(`/tasks/${task.id}`);
    }
    setSubmitting(false);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <label className="text-sm font-medium">Project</label>
        <ProjectSelector value={projectId} onChange={setProjectId} />
      </div>
      <div className="space-y-2">
        <label className="text-sm font-medium">Title</label>
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What should the agent do?"
        />
      </div>
      <div className="space-y-2">
        <label className="text-sm font-medium">Description</label>
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Additional context, requirements, constraints..."
          rows={4}
        />
      </div>
      <Button type="submit" disabled={submitting || !title.trim() || !projectId}>
        {submitting ? "Creating..." : "Create Task"}
      </Button>
    </form>
  );
}
