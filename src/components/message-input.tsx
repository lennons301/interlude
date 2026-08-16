"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { FOCUS_RING } from "@/components/fleet/fleet-bits";
import { composerState, resolvePrimary } from "@/lib/chat/composer";
import { applySlashCommand, slashMenu, type SlashCommand } from "@/lib/chat/slash";

/**
 * The live view's write side (issue #122). Answering a grilling agent is the
 * interaction this app most needs to do well, so the composer is a first-class
 * input rather than a bare textarea: it grows with the answer, says plainly
 * whether the agent is working, idle or holding your message in a queue, makes
 * the session skills discoverable from a slash, and puts continuing or ending
 * the session where you can see them.
 *
 * Every decision about what the task's state *means* is made by
 * `composerState`; this file draws it and owns only draft-local concerns.
 */

interface MessageInputProps {
  taskId: string;
  containerStatus: string | null;
  taskStatus: string;
  /** Messages of yours the agent has not been handed yet. */
  queued: number;
  /** Non-null on a generation session, where the orchestrator re-frames a
   * leading skill slash (issue #63) — the only place the menu means anything.
   * A plain chat task gets no menu, because the framing it advertises (and the
   * `gh` token a publishing skill needs) is not there. */
  sessionSkill: string | null;
}

/** The autosize measurement has to happen before paint or the field visibly
 * jumps a frame behind the typing; on the server there is no paint to be before
 * and useLayoutEffect would only warn. */
const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

const DOT_TONE = {
  green: "bg-fl-green",
  amber: "bg-fl-amber",
  quiet: "bg-fl-ink-3",
} as const;

const QUIET_BUTTON = `font-plex-mono text-[11px] lowercase text-fl-ink-3 hover:text-fl-ink disabled:cursor-default disabled:text-fl-ink-3/50 disabled:hover:text-fl-ink-3/50 ${FOCUS_RING}`;

/** A fixed id, not `useId`: there is exactly one composer on a page, and the
 * generated id came out different on the server and the client here, which is
 * a hydration mismatch for an attribute that only has to point at a sibling. */
const HINT_ID = "composer-hint";

export function MessageInput({
  taskId,
  containerStatus,
  taskStatus,
  queued,
  sessionSkill,
}: MessageInputProps) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [confirmingComplete, setConfirmingComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The draft the slash menu was dismissed for: Escape closes it until you type
  // something else, which is the only thing "dismissed" can sensibly mean for a
  // menu whose trigger is the draft itself.
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const state = composerState({ taskStatus, containerStatus, queued });
  const primary = resolvePrimary(draft, state.allowsContinue);
  const canSubmit =
    state.accepting && !sending && (draft.trim() !== "" || state.allowsContinue);

  const menu = useMemo(
    () => (sessionSkill && dismissed !== draft ? slashMenu(draft) : null),
    [draft, dismissed, sessionSkill]
  );
  const matches = menu?.matches ?? [];
  const menuOpen = matches.length > 0;
  const activeIndex = Math.min(active, matches.length - 1);

  /**
   * A phone's return key is the only newline it has — there is no Shift on a
   * touch keyboard — so Enter-to-send everywhere would make the multiline
   * composer this ticket asks for unusable on the device the owner reads
   * sessions on. Enter sends where a real keyboard is likely; on touch the
   * return key writes a newline and the send button sends. The hint below the
   * field always says which of the two you have.
   */
  const [enterSends, setEnterSends] = useState(true);
  useEffect(() => {
    const coarse = window.matchMedia("(pointer: coarse)");
    const apply = () => setEnterSends(!coarse.matches);
    apply();
    coarse.addEventListener("change", apply);
    return () => coarse.removeEventListener("change", apply);
  }, []);

  // Grow to fit the draft, shrink back when it is sent. Height is measured from
  // zero rather than from the current height, or the field could only ever get
  // taller; the cap is CSS, so the field scrolls once it reaches it.
  useIsomorphicLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);

  async function submit(text: string) {
    if (!canSubmit) return;

    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/tasks/${taskId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text, role: "user" }),
      });
      if (!res.ok) {
        // The draft is deliberately left in the field — a failed send must not
        // eat what you wrote.
        setError("Couldn't send that message. Try again.");
        return;
      }
      setDraft("");
    } catch {
      setError("Couldn't reach the server. Try again.");
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  }

  async function handleComplete() {
    setCompleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/tasks/${taskId}/complete`, { method: "POST" });
      if (!res.ok) {
        setError("Couldn't complete the task. Try again.");
        setCompleting(false);
      }
      // On success the view flips to its terminal state over SSE, so the button
      // stays in its "completing…" state until it does.
    } catch {
      setError("Couldn't reach the server. Try again.");
      setCompleting(false);
    }
    setConfirmingComplete(false);
  }

  function pick(command: SlashCommand) {
    setDraft(applySlashCommand(command.name));
    setActive(0);
    textareaRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Mid-composition (IME) Enter commits the candidate word; it is never a send.
    const composing = e.nativeEvent.isComposing;

    if (menuOpen && !composing) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((i) => (Math.min(i, matches.length - 1) + 1) % matches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive(
          (i) => (Math.min(i, matches.length - 1) - 1 + matches.length) % matches.length
        );
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissed(draft);
        return;
      }
      if ((e.key === "Enter" && !e.shiftKey) || (e.key === "Tab" && !e.shiftKey)) {
        e.preventDefault();
        pick(matches[activeIndex]);
        return;
      }
    }

    if (e.key === "Escape" && confirmingComplete) {
      e.preventDefault();
      setConfirmingComplete(false);
      return;
    }

    if (e.key === "Enter" && !e.shiftKey && enterSends && !composing) {
      e.preventDefault();
      void submit(primary.text);
    }
  }

  const keyHint = enterSends
    ? "enter to send · shift+enter for a newline"
    : "return for a newline · tap send";
  const hint = sessionSkill ? `${keyHint} · / for session commands` : keyHint;

  return (
    <div className="shrink-0 border-t border-fl-line bg-fl-surface px-3 py-2.5">
      {menuOpen && (
        <SlashCommandMenu matches={matches} activeIndex={activeIndex} onPick={pick} />
      )}

      <div className="mb-1.5 flex items-center justify-between gap-3">
        {/* Announced, because "your message is queued behind a turn" is the one
            thing about this screen you cannot see by looking at the field. */}
        <p
          role="status"
          className="flex min-w-0 items-center gap-1.5 font-plex-mono text-[11px] lowercase text-fl-ink-2"
        >
          <span
            aria-hidden
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT_TONE[state.tone]} ${
              state.phase === "working" ? "fleet-pulse" : ""
            }`}
          />
          {/* The confirmation takes the row: on a phone there is not width for
              both, and for the second it is up, the question is the status. */}
          {!confirmingComplete && (
            <>
              <span className="truncate">{state.label}</span>
              {state.queuedNote && (
                <span className="shrink-0 text-fl-ink-3">· {state.queuedNote}</span>
              )}
            </>
          )}
        </p>

        {confirmingComplete ? (
          <span className="flex shrink-0 items-center gap-2.5 font-plex-mono text-[11px] lowercase">
            <span className="text-fl-ink-2">end this session?</span>
            <button
              type="button"
              onClick={handleComplete}
              className={`text-fl-amber hover:opacity-80 ${FOCUS_RING}`}
            >
              confirm
            </button>
            <button
              type="button"
              onClick={() => setConfirmingComplete(false)}
              className={QUIET_BUTTON}
            >
              cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmingComplete(true)}
            disabled={!state.canComplete || completing}
            title={
              state.canComplete
                ? "End this session and mark its PR ready"
                : "Available between turns, once the agent is idle"
            }
            className={`shrink-0 ${QUIET_BUTTON}`}
          >
            {completing ? "completing…" : "complete"}
          </button>
        )}
      </div>

      <div
        className={`flex items-end gap-2 rounded-[4px] border bg-fl-card px-2.5 py-1.5 ${
          state.accepting
            ? "border-fl-line focus-within:border-fl-line-strong"
            : "border-fl-line opacity-60"
        }`}
      >
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setActive(0);
          }}
          onKeyDown={handleKeyDown}
          placeholder={state.placeholder}
          rows={1}
          disabled={!state.accepting}
          aria-label="Message the agent"
          aria-describedby={HINT_ID}
          className="max-h-40 min-w-0 flex-1 resize-none bg-transparent py-1 text-sm text-fl-ink outline-none placeholder:text-fl-ink-3 disabled:cursor-not-allowed"
        />
        <button
          type="button"
          onClick={() => void submit(primary.text)}
          disabled={!canSubmit}
          className={`shrink-0 rounded-[4px] bg-fl-cool px-3 py-1.5 font-plex-mono text-[12px] lowercase text-fl-ground transition-opacity hover:opacity-90 disabled:opacity-40 ${FOCUS_RING}`}
        >
          {sending ? "sending…" : primary.label}
        </button>
      </div>

      {error ? (
        <p role="alert" className="mt-1 font-plex-mono text-[11px] text-fl-red">
          {error}
        </p>
      ) : (
        // Wrapping, not truncating: on a phone the whole line is the point,
        // and an ellipsis would eat the half that says how to type a newline.
        <p
          id={HINT_ID}
          className="mt-1 font-plex-mono text-[11px] leading-snug text-fl-ink-3"
        >
          {hint}
        </p>
      )}
    </div>
  );
}

/**
 * The session skills, offered above the field. Buttons rather than listbox
 * options: they are reachable by Tab as well as by the arrow keys the textarea
 * handles, which is the accessible behaviour that costs nothing here. The
 * highlighted row is marked `aria-current`, so what Enter will accept is not
 * carried by the tint alone.
 */
function SlashCommandMenu({
  matches,
  activeIndex,
  onPick,
}: {
  matches: readonly SlashCommand[];
  activeIndex: number;
  onPick: (command: SlashCommand) => void;
}) {
  return (
    <div
      aria-label="Session commands"
      className="mb-2 max-h-52 overflow-y-auto rounded-[4px] border border-fl-line bg-fl-card"
    >
      {matches.map((command, i) => (
        <button
          key={command.name}
          type="button"
          aria-current={i === activeIndex ? "true" : undefined}
          // Keep the caret in the field: a mousedown that blurs the textarea
          // would close the menu before the click lands.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(command)}
          // Cool marks the highlighted row, the same hue the session-entry
          // form marks a picked session with: colour here means the owner is
          // choosing, not that anything is live or wrong.
          className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left ${FOCUS_RING} ${
            i === activeIndex ? "bg-fl-cool/13" : "hover:bg-fl-surface"
          }`}
        >
          <span className="shrink-0 font-plex-mono text-[12px] text-fl-ink">
            /{command.name}
          </span>
          <span className="min-w-0 flex-1 truncate text-[12px] text-fl-ink-3">
            {command.summary}
          </span>
        </button>
      ))}
    </div>
  );
}
