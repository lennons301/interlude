/**
 * The composer's slash awareness (issue #122). Typing `/` in a generation
 * session opens a menu of the estate's session skills, so the follow-on slash
 * routing that already exists server-side (`composeSessionTurn`, issue #63) is
 * discoverable instead of being lore you have to remember.
 *
 * Pure by design: what counts as a trigger, what matches a query, and what the
 * draft becomes when a command is accepted are the decisions worth testing, so
 * they live here and the menu component only draws the result.
 */

import type { SessionSkill } from "@/db/schema";
import { SESSION_BLURBS, SESSION_ORDER } from "@/lib/sessions/skills";

export interface SlashCommand {
  name: SessionSkill;
  summary: string;
}

/** The offered commands, in the session-entry form's order. Deliberately only
 * the session skills: those are the ones the orchestrator re-frames on the way
 * to the agent. Any other slash the CLI expands itself, unaided and unlisted. */
export const SLASH_COMMANDS: readonly SlashCommand[] = SESSION_ORDER.map(
  (name) => ({ name, summary: SESSION_BLURBS[name] })
);

export interface SlashMenu {
  /** What has been typed after the slash, lowercased. */
  query: string;
  matches: readonly SlashCommand[];
}

/**
 * The trigger: the whole draft is a slash and the command word being typed —
 * nothing more. Once a space follows the command the agenda has begun and the
 * menu gets out of the way, and a slash mid-sentence was never a command.
 * Leading whitespace is tolerated because `composeSessionTurn` tolerates it
 * too, so the menu offers exactly what the server would route.
 */
const TRIGGER = /^\s*\/(\S*)$/;

/** The menu for a draft, or null when the draft is not a command being typed.
 * An empty query lists everything — pressing `/` is how you find out what
 * exists. */
export function slashMenu(draft: string): SlashMenu | null {
  const match = TRIGGER.exec(draft);
  if (!match) return null;

  const query = match[1].toLowerCase();
  return { query, matches: matchCommands(query) };
}

/** Prefix matches first, then anything containing the query: typing `to` should
 * offer `to-spec` and `to-tickets` before `grill-with-docs`, which only matches
 * because of its middle. Each group keeps the canonical order. */
export function matchCommands(query: string): readonly SlashCommand[] {
  if (query === "") return SLASH_COMMANDS;

  const prefix = SLASH_COMMANDS.filter((c) => c.name.startsWith(query));
  const rest = SLASH_COMMANDS.filter(
    (c) => !c.name.startsWith(query) && c.name.includes(query)
  );
  return [...prefix, ...rest];
}

/**
 * Accepting a command replaces the draft outright — the trigger guarantees the
 * draft was only the half-typed command — and leaves a trailing space, because
 * what follows a session skill is its agenda.
 */
export function applySlashCommand(name: string): string {
  return `/${name} `;
}
