"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardHeader } from "@/components/ui/card";

type Project = {
  id: string;
  name: string;
  githubRepo: string | null;
  gitUrl: string | null;
  createdAt: string;
};

export function ProjectList() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [name, setName] = useState("");
  const [gitUrl, setGitUrl] = useState("");
  const [creating, setCreating] = useState(false);

  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    fetch("/api/projects").then(async (res) => {
      if (res.ok) setProjects(await res.json());
    });
  }, [refreshKey]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || creating) return;

    setCreating(true);
    await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim(), gitUrl: gitUrl.trim() || undefined }),
    });
    setName("");
    setGitUrl("");
    setCreating(false);
    setRefreshKey((k) => k + 1);
  }

  return (
    <div className="space-y-4">
      <form onSubmit={handleCreate} className="flex gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Project name"
          className="flex-1"
        />
        <Input
          value={gitUrl}
          onChange={(e) => setGitUrl(e.target.value)}
          placeholder="https://github.com/user/repo.git"
          className="flex-1"
        />
        <Button type="submit" disabled={creating || !name.trim()}>
          Add
        </Button>
      </form>

      {projects.length === 0 ? (
        <p className="text-muted-foreground">No projects yet.</p>
      ) : (
        <div className="space-y-2">
          {projects.map((p) => (
            <Card key={p.id}>
              <CardHeader className="py-3">
                <span className="font-medium">{p.name}</span>
                {p.gitUrl && (
                  <span className="text-sm text-muted-foreground">{p.gitUrl}</span>
                )}
              </CardHeader>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
