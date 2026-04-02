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
  dopplerToken: string | null;
  createdAt: string;
};

export function ProjectList() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [name, setName] = useState("");
  const [gitUrl, setGitUrl] = useState("");
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

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
                <div
                  className="flex items-center justify-between cursor-pointer"
                  onClick={() => setEditingId(editingId === p.id ? null : p.id)}
                >
                  <div>
                    <span className="font-medium">{p.name}</span>
                    {p.gitUrl && (
                      <span className="text-sm text-muted-foreground ml-2">{p.gitUrl}</span>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {editingId === p.id ? "collapse" : "edit"}
                  </span>
                </div>
                {editingId === p.id && (
                  <ProjectEditForm
                    project={p}
                    onSaved={() => setRefreshKey((k) => k + 1)}
                  />
                )}
              </CardHeader>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectEditForm({
  project,
  onSaved,
}: {
  project: Project;
  onSaved: () => void;
}) {
  const [name, setName] = useState(project.name);
  const [gitUrl, setGitUrl] = useState(project.gitUrl ?? "");
  const [githubRepo, setGithubRepo] = useState(project.githubRepo ?? "");
  const [dopplerToken, setDopplerToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const hasDoppler = project.dopplerToken !== null;

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);

    const updates: Record<string, string | null> = {};
    if (name.trim() !== project.name) updates.name = name.trim();
    if (gitUrl.trim() !== (project.gitUrl ?? "")) updates.gitUrl = gitUrl.trim() || null;
    if (githubRepo.trim() !== (project.githubRepo ?? "")) updates.githubRepo = githubRepo.trim() || null;
    if (dopplerToken.trim()) updates.dopplerToken = dopplerToken.trim();

    if (Object.keys(updates).length > 0) {
      await fetch(`/api/projects/${project.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      onSaved();
    }

    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <form onSubmit={handleSave} className="mt-3 space-y-2">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <div>
          <label className="text-xs text-muted-foreground">Name</label>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className="text-xs text-muted-foreground">Git URL</label>
          <Input
            value={gitUrl}
            onChange={(e) => setGitUrl(e.target.value)}
            placeholder="https://github.com/user/repo.git"
          />
        </div>
        <div>
          <label className="text-xs text-muted-foreground">GitHub Repo</label>
          <Input
            value={githubRepo}
            onChange={(e) => setGithubRepo(e.target.value)}
            placeholder="owner/repo"
          />
        </div>
        <div>
          <label className="text-xs text-muted-foreground">
            Doppler Token {hasDoppler && <span className="text-green-400">(set)</span>}
          </label>
          <Input
            value={dopplerToken}
            onChange={(e) => setDopplerToken(e.target.value)}
            placeholder={hasDoppler ? "Leave blank to keep current" : "dp.st.stg.xxxxx"}
            type="password"
          />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={saving}>
          {saving ? "Saving..." : "Save"}
        </Button>
        {saved && <span className="text-xs text-green-400">Saved</span>}
      </div>
    </form>
  );
}
