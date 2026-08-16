"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Chip,
  ControlButton,
  FIELD,
  TONES,
} from "@/components/fleet/fleet-bits";
import {
  armBlocker,
  canArm,
  preflightVerdict,
  type ProjectAutonomy,
} from "@/lib/projects/autonomy";
import {
  DEFAULT_ATTEMPT_BUDGET_USD,
  MAX_ATTEMPTS,
} from "@/lib/orchestrator/autonomy/budgets";

/**
 * The project half of the control room (issue #119). Each card says what the
 * fleet will do with the project unattended — armed or not, and whether its
 * preflight passes — and is where the owner arms it.
 *
 * Arming is the one control here that starts unattended spend, so it is the one
 * control that asks twice: `canArm` (pure, tested) decides whether the ordinary
 * affordance is offered at all, and a failing preflight replaces it with an
 * explicit override beside its reason. Disarming and every other edit are
 * single-press — reversible things shouldn't be made to feel dangerous.
 */

interface Project extends ProjectAutonomy {
  id: string;
  name: string;
  githubRepo: string | null;
  gitUrl: string | null;
  /** Presence only — the screen never renders the token itself. */
  dopplerToken: string | null;
  discordChannelId: string | null;
}

export function ProjectList() {
  // null = never loaded, so a failed load can't masquerade as "no projects" —
  // the same distinction the archive draws.
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;

    (async () => {
      try {
        const res = await fetch("/api/projects", { signal: controller.signal });
        if (!res.ok) throw new Error(`the server answered ${res.status}`);
        const data: Project[] = await res.json();
        if (stopped) return;
        setProjects(data);
        setError(null);
      } catch (err) {
        if (stopped || controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "the request failed");
      }
    })();

    return () => {
      stopped = true;
      controller.abort();
    };
  }, [reloadKey]);

  /** A PATCH answers with the whole updated row — including the preflight the
   * server just re-ran — so the changed card is replaced from the response
   * rather than re-fetching the list and hoping it agrees. */
  const replace = useCallback((updated: Project) => {
    setProjects((current) =>
      current === null
        ? current
        : current.map((p) => (p.id === updated.id ? updated : p))
    );
  }, []);

  return (
    <div className="space-y-4">
      <NewProjectForm onCreated={reload} />

      {error !== null && projects === null ? (
        <div className="space-y-2">
          <p role="alert" className="text-[13px] text-fl-red">
            Couldn&apos;t load your projects — {error}.
          </p>
          <ControlButton
            onClick={() => {
              setError(null);
              reload();
            }}
          >
            retry
          </ControlButton>
        </div>
      ) : projects === null ? (
        <p className="font-plex-mono text-[11px] text-fl-ink-3">loading…</p>
      ) : projects.length === 0 ? (
        <p className="text-[13px] text-fl-ink-3">
          No projects yet — add one above to give the fleet something to work on.
        </p>
      ) : (
        <ul className="space-y-2">
          {projects.map((project) => (
            <li key={project.id}>
              <ProjectCard
                project={project}
                onUpdated={replace}
                onSaved={reload}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ProjectCard({
  project,
  onUpdated,
  onSaved,
}: {
  project: Project;
  onUpdated: (updated: Project) => void;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const verdict = preflightVerdict(project);

  return (
    <div className="space-y-2.5 rounded-[4px] border border-fl-line bg-fl-card px-3 py-2.5">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
        <div className="min-w-0">
          <span className="block truncate text-sm text-fl-ink">
            {project.name}
          </span>
          <span className="block truncate font-plex-mono text-[11px] text-fl-ink-3">
            {project.githubRepo ?? project.gitUrl ?? "no repo configured"}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Chip tone={project.autonomyEnabled ? "green" : "quiet"}>
            {project.autonomyEnabled ? "armed" : "disarmed"}
          </Chip>
          <Chip tone={verdict.tone}>preflight {verdict.state}</Chip>
        </div>
      </div>

      {verdict.detail !== null && (
        <p className="text-[13px] text-fl-ink-3">{verdict.detail}</p>
      )}

      {/* The loop fails closed on any preflight that isn't passing, so an armed
          project sitting on one is armed and idle — which looks identical to
          armed and quiet unless the card says so. */}
      {project.autonomyEnabled && verdict.state !== "passing" && (
        <p className="text-[13px] text-fl-amber">
          Armed, but nothing is claimed until preflight passes.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <AutonomyControl project={project} onUpdated={onUpdated} />
        <ControlButton
          aria-expanded={editing}
          onClick={() => setEditing((open) => !open)}
        >
          {editing ? "close" : "edit"}
        </ControlButton>
      </div>

      {editing && <ProjectEditForm project={project} onSaved={onSaved} />}
    </div>
  );
}

/** Arm / disarm, and the confirmation that stands between the owner and
 * unattended spend. `intent` is what the owner has asked for but not yet
 * confirmed: `arm` from the ordinary affordance, `override` from the one a
 * failing preflight leaves in its place. */
function AutonomyControl({
  project,
  onUpdated,
}: {
  project: Project;
  onUpdated: (updated: Project) => void;
}) {
  const [intent, setIntent] = useState<null | "arm" | "override">(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const blocker = armBlocker(project);

  async function setAutonomy(enabled: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${project.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // An explicit boolean: the endpoint refuses anything else, and this is
        // not a field to be clever about.
        body: JSON.stringify({ autonomyEnabled: enabled }),
      });
      if (!res.ok) throw new Error(`the server answered ${res.status}`);
      onUpdated(await res.json());
      setIntent(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "the request failed");
    }
    setBusy(false);
  }

  if (project.autonomyEnabled) {
    return (
      <>
        <ControlButton disabled={busy} onClick={() => setAutonomy(false)}>
          {busy ? "disarming…" : "disarm"}
        </ControlButton>
        <Failure error={error} verb="disarm" />
      </>
    );
  }

  if (intent === null) {
    return canArm(project) ? (
      <ControlButton tone="cool" onClick={() => setIntent("arm")}>
        arm…
      </ControlButton>
    ) : (
      <>
        <ControlButton tone="amber" onClick={() => setIntent("override")}>
          arm anyway…
        </ControlButton>
        <Failure error={error} verb="arm" />
      </>
    );
  }

  const tone = intent === "override" ? "amber" : "cool";
  return (
    <div
      role="group"
      aria-label={`Confirm arming ${project.name}`}
      className={`w-full space-y-2 rounded-[4px] border px-3 py-2.5 ${TONES[tone]}`}
    >
      <p className="text-[13px]">
        Arm {project.name} for unattended work? The loop will claim its
        ready-for-agent tickets on its own, spending up to $
        {DEFAULT_ATTEMPT_BUDGET_USD} an attempt and {MAX_ATTEMPTS} attempts a
        ticket.
      </p>
      {intent === "override" && (
        <p className="text-[13px]">
          Preflight is failing ({blocker}). Arming records your intent, but the
          loop still claims nothing until that is fixed.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <ControlButton tone={tone} disabled={busy} onClick={() => setAutonomy(true)}>
          {busy ? "arming…" : "confirm arm"}
        </ControlButton>
        <ControlButton disabled={busy} onClick={() => setIntent(null)}>
          cancel
        </ControlButton>
      </div>
      <Failure error={error} verb="arm" />
    </div>
  );
}

function Failure({ error, verb }: { error: string | null; verb: string }) {
  if (error === null) return null;
  return (
    <p role="alert" className="w-full text-[13px] text-fl-red">
      Couldn&apos;t {verb} this project — {error}.
    </p>
  );
}

function NewProjectForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [gitUrl, setGitUrl] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || creating) return;

    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          gitUrl: gitUrl.trim() || undefined,
        }),
      });
      if (!res.ok) throw new Error(`the server answered ${res.status}`);
      setName("");
      setGitUrl("");
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "the request failed");
    }
    setCreating(false);
  }

  return (
    <form onSubmit={handleCreate} className="space-y-2">
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          className={FIELD}
          aria-label="Project name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Project name"
        />
        <input
          className={FIELD}
          aria-label="Git URL"
          value={gitUrl}
          onChange={(e) => setGitUrl(e.target.value)}
          placeholder="https://github.com/user/repo.git"
        />
        <button
          type="submit"
          disabled={creating || !name.trim()}
          className="shrink-0 rounded-[4px] bg-fl-cool px-4 py-2 text-sm font-medium text-fl-ground transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {creating ? "Adding…" : "Add"}
        </button>
      </div>
      {error !== null && (
        <p role="alert" className="text-[13px] text-fl-red">
          Couldn&apos;t add the project — {error}.
        </p>
      )}
    </form>
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
  const [error, setError] = useState<string | null>(null);

  const hasDoppler = project.dopplerToken !== null;

  async function save() {
    if (saving) return;

    const updates: Record<string, string | null> = {};
    if (name.trim() !== project.name) updates.name = name.trim();
    if (gitUrl.trim() !== (project.gitUrl ?? ""))
      updates.gitUrl = gitUrl.trim() || null;
    if (githubRepo.trim() !== (project.githubRepo ?? ""))
      updates.githubRepo = githubRepo.trim() || null;
    if (dopplerToken.trim()) updates.dopplerToken = dopplerToken.trim();

    if (Object.keys(updates).length === 0) return;

    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${project.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      if (!res.ok) throw new Error(`the server answered ${res.status}`);
      setDopplerToken("");
      onSaved();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "the request failed");
    }
    setSaving(false);
  }

  return (
    <form
      // Enter in any field saves, exactly as pressing the button does — both
      // routes go through the one `save`.
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
      className="space-y-2 border-t border-fl-line pt-2.5"
    >
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Field label="name">
          <input
            className={FIELD}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="git url">
          <input
            className={FIELD}
            value={gitUrl}
            onChange={(e) => setGitUrl(e.target.value)}
            placeholder="https://github.com/user/repo.git"
          />
        </Field>
        <Field label="github repo">
          <input
            className={FIELD}
            value={githubRepo}
            onChange={(e) => setGithubRepo(e.target.value)}
            placeholder="owner/repo"
          />
        </Field>
        <Field label={hasDoppler ? "doppler token · set" : "doppler token"}>
          <input
            className={FIELD}
            type="password"
            value={dopplerToken}
            onChange={(e) => setDopplerToken(e.target.value)}
            placeholder={hasDoppler ? "Leave blank to keep current" : "dp.st.dev.xxxxx"}
          />
        </Field>
        {project.discordChannelId !== null && (
          <Field label="discord channel · linked">
            <input
              className={`${FIELD} font-plex-mono text-xs opacity-60`}
              value={project.discordChannelId}
              disabled
            />
          </Field>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <ControlButton tone="cool" disabled={saving} onClick={save}>
          {saving ? "saving…" : "save"}
        </ControlButton>
        {saved && (
          <span className="font-plex-mono text-[11px] text-fl-green">saved</span>
        )}
        {error !== null && (
          <span role="alert" className="text-[13px] text-fl-red">
            Couldn&apos;t save — {error}.
          </span>
        )}
      </div>
    </form>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="block font-plex-mono text-[11px] lowercase text-fl-ink-3">
        {label}
      </span>
      {children}
    </label>
  );
}
