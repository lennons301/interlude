"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { SessionSkill } from "@/db/schema";
import type { OpenIssue } from "@/lib/github/issues";
import { Eyebrow, FIELD, PRIMARY_BUTTON } from "@/components/fleet/fleet-bits";

// A new task is either a plain chat task (the default, unchanged) or a
// generation session running one of the estate's generation skills (issue #64).
type TaskType = "chat" | SessionSkill;

// One-line blurbs so the choice is legible one-handed on a phone. Keyed by
// SessionSkill, so a skill added to the schema fails the type check here until
// it gets a blurb — the selector can never silently drop one. Insertion order
// is the display order (grills first, then the spec→tickets pipeline, then the
// standalone passes); SESSION_SKILLS in the schema stays the runtime source of
// truth.
const SESSION_BLURBS: Record<SessionSkill, string> = {
  "grill-me": "Stress-test an idea until its decisions resolve",
  "grill-with-docs": "Grill an idea with the project's docs in context",
  "to-spec": "Turn resolved decisions into a spec",
  "to-tickets": "Decompose a spec into executable tickets",
  triage: "Move an issue through the label lifecycle",
  wayfinder: "Chart a new map of the territory",
};
const SESSION_ORDER = Object.keys(SESSION_BLURBS) as SessionSkill[];

export function NewTaskForm() {
  const router = useRouter();
  const [projectId, setProjectId] = useState("");
  const [taskType, setTaskType] = useState<TaskType>("chat");
  const [issueRef, setIssueRef] = useState(""); // "" = freeform (no anchor)
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  // null = the current project's issues aren't loaded yet (a session picker
  // renders "loading…"); an array = the loaded list ([] means none open).
  const [issues, setIssues] = useState<OpenIssue[] | null>(null);
  // The project the loaded issues belong to, so toggling chat↔session for the
  // same project doesn't re-hit GitHub.
  const loadedFor = useRef<string | null>(null);

  const isSession = taskType !== "chat";

  useEffect(() => {
    fetch("/api/projects")
      .then((r) => r.json())
      .then(setProjects)
      .catch(() => setProjects([]));
  }, []);

  // A new repo invalidates the loaded issues and any picked anchor, so both
  // reset on the project change (an event handler — not the load effect, where
  // a synchronous setState is a cascading-render smell). Switching between
  // session types keeps them: the same project's issues are still valid.
  function handleProjectChange(id: string) {
    setProjectId(id);
    setIssueRef("");
    setIssues(null);
    loadedFor.current = null;
  }

  // Load the picked project's open issues once a session is being composed,
  // once per project (the ref guards the chat↔session toggle). Freeform stays
  // available whatever the fetch returns.
  useEffect(() => {
    if (!isSession || !projectId || loadedFor.current === projectId) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/issues`);
        const data: OpenIssue[] = res.ok ? await res.json() : [];
        if (!cancelled) {
          setIssues(data);
          loadedFor.current = projectId;
        }
      } catch {
        if (!cancelled) {
          setIssues([]);
          loadedFor.current = projectId;
        }
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [isSession, projectId]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !projectId || submitting) return;

    setSubmitting(true);
    setError(null);
    // Plain chat sends exactly what it always did — no session fields — so its
    // creation path is unchanged. A session adds the skill and (if anchored)
    // the issue ref; the orchestrator composes the seed from these on run.
    const payload: Record<string, string> = {
      title: title.trim(),
      description: description.trim(),
      projectId,
    };
    if (isSession) {
      payload.sessionSkill = taskType;
      // Only anchor to an issue still present in the shown list, so a ref the
      // picker no longer offers is never submitted silently.
      if (issueRef && issues?.some((i) => i.ref === issueRef)) {
        payload.sessionIssue = issueRef;
      }
    }

    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        const task = await res.json();
        router.push(`/tasks/${task.id}`);
        return; // navigating away; leave submitting set to avoid a re-enable flash
      }
      const body = await res.json().catch(() => null);
      setError(body?.error ?? `Could not create the task (HTTP ${res.status}).`);
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    }
    setSubmitting(false);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="space-y-2">
        <Eyebrow>project</Eyebrow>
        <SelectField value={projectId} onChange={handleProjectChange} aria-label="Project">
          <option value="" disabled>
            Select a project
          </option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </SelectField>
      </div>

      <fieldset className="m-0 space-y-2 border-0 p-0">
        <legend className="sr-only">Task type</legend>
        <Eyebrow>type</Eyebrow>
        <TypeOption
          name="chat"
          blurb="A plain chat task — the agent works from your prompt"
          selected={taskType === "chat"}
          onSelect={() => setTaskType("chat")}
        />
        <p className="pt-1 font-plex-mono text-[11px] uppercase tracking-[0.14em] text-fl-ink-3">
          or start a session
        </p>
        {SESSION_ORDER.map((skill) => (
          <TypeOption
            key={skill}
            name={skill}
            blurb={SESSION_BLURBS[skill]}
            selected={taskType === skill}
            onSelect={() => setTaskType(skill)}
          />
        ))}
      </fieldset>

      {isSession && (
        <div className="space-y-2">
          <Eyebrow>anchor</Eyebrow>
          {!projectId ? (
            <p className="font-plex-mono text-[11px] text-fl-ink-3">
              pick a project to list its issues
            </p>
          ) : issues === null ? (
            <p className="font-plex-mono text-[11px] text-fl-ink-3">loading issues…</p>
          ) : issues.length === 0 ? (
            <p className="font-plex-mono text-[11px] text-fl-ink-3">
              no open issues — this session will be freeform
            </p>
          ) : (
            <SelectField value={issueRef} onChange={setIssueRef} aria-label="Issue to anchor to">
              <option value="">Freeform — no issue</option>
              {issues.map((i) => (
                <option key={i.ref} value={i.ref}>
                  #{i.number} · {i.title}
                </option>
              ))}
            </SelectField>
          )}
          <p className="text-[13px] text-fl-ink-3">
            Anchor to an issue to open the session with it as context, or leave freeform.
          </p>
        </div>
      )}

      <div className="space-y-2">
        <Eyebrow>{isSession ? "agenda" : "task"}</Eyebrow>
        <input
          className={FIELD}
          aria-label={isSession ? "Session agenda" : "Task title"}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={isSession ? "What should this session focus on?" : "What should the agent do?"}
        />
        {isSession && (
          <p className="text-[13px] text-fl-ink-3">
            Becomes the session&apos;s opening prompt, after the{" "}
            <span className="font-plex-mono">{taskType}</span> skill.
          </p>
        )}
      </div>

      <div className="space-y-2">
        <Eyebrow>{isSession ? "context" : "description"}</Eyebrow>
        <textarea
          className={`${FIELD} min-h-24`}
          aria-label={isSession ? "Session context" : "Task description"}
          rows={4}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={
            isSession
              ? "Any extra context, constraints, or angle to take…"
              : "Additional context, requirements, constraints…"
          }
        />
      </div>

      {error && (
        <p role="alert" className="text-[13px] text-fl-red">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={submitting || !title.trim() || !projectId}
        className={`w-full ${PRIMARY_BUTTON}`}
      >
        {submitting
          ? isSession
            ? "Starting…"
            : "Creating…"
          : isSession
            ? `Start ${taskType} session`
            : "Create task"}
      </button>
    </form>
  );
}

/** One tappable task-type option, a native radio styled as a fleet row: native
 * radios give the group arrow-key navigation and screen-reader semantics for
 * free. Cool marks the selection — everything started here is the owner
 * driving, the fleet's one cool hue (issue #21). */
function TypeOption({
  name,
  blurb,
  selected,
  onSelect,
}: {
  name: string;
  blurb: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <label
      className={`flex w-full cursor-pointer items-start gap-3 rounded-[4px] border px-3 py-2.5 text-left transition-colors focus-within:border-fl-cool ${
        selected
          ? "border-fl-cool/45 bg-fl-cool/13"
          : "border-fl-line bg-fl-card hover:border-fl-line-strong"
      }`}
    >
      <input
        type="radio"
        name="task-type"
        className="sr-only"
        checked={selected}
        onChange={onSelect}
      />
      <span
        aria-hidden
        className={`mt-0.5 h-3.5 w-3.5 shrink-0 rounded-full border ${
          selected ? "border-fl-cool bg-fl-cool" : "border-fl-line-strong"
        }`}
      />
      <span className="min-w-0">
        <span className={`block font-plex-mono text-[13px] ${selected ? "text-fl-cool" : "text-fl-ink"}`}>
          {name}
        </span>
        <span className="block text-[13px] text-fl-ink-3">{blurb}</span>
      </span>
    </label>
  );
}

/** Fleet-styled native select: the native control gives the OS picker on a
 * phone (reliable one-handed), themed with fleet tokens. The option list itself
 * is browser-rendered — acceptable, and it matches the system theme on mobile. */
function SelectField({
  value,
  onChange,
  children,
  ...rest
}: {
  value: string;
  onChange: (v: string) => void;
  children: React.ReactNode;
} & Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "value" | "onChange">) {
  return (
    <div className="relative">
      <select
        {...rest}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`${FIELD} appearance-none pr-8`}
      >
        {children}
      </select>
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-3 flex items-center font-plex-mono text-[11px] text-fl-ink-3"
      >
        ▾
      </span>
    </div>
  );
}
