/**
 * The first turn of an ordinary chat task and of a live-preview session
 * (issue #160). A generation session's seed is `composeSeed` in `./seed.ts`;
 * an autonomous pass carries its fully framed brief in its description. This
 * is everything else: the owner's prompt, the standing commit instruction, and
 * — for a live-preview session — the preview contract.
 */

/** Appended to every chat seed, unchanged since Phase 2b. */
export const STANDING_INSTRUCTION =
  "When you are done with each request, commit all your changes with a " +
  "descriptive commit message. Stay ready for follow-up instructions.";

/** The log a detached dev server is told to write to, so a later turn — or the
 * owner, through the agent — has somewhere to look when the pane is wrong. */
export const DEV_SERVER_LOG = "/tmp/dev-server.log";

/**
 * What a live-preview session's agent has to know that no other session does
 * (issue #160, defect 4). Each line answers a way the preview failed in
 * production:
 *  - the server must be *detached*, because a plain background job dies with
 *    the tool call and the turn that started it (the first server in the #160
 *    session lasted exactly one turn; the `setsid nohup` restart survived);
 *  - it must bind all interfaces, because the proxy reaches the container over
 *    the Docker network and a localhost bind is invisible to it (Vite's
 *    default);
 *  - it must sit on a conventional port, because the scanner refuses the
 *    ephemeral range;
 *  - there is no Docker daemon (issue #161) — stated up front so the agent
 *    plans around it instead of discovering `docker: command not found` on its
 *    second tool call.
 */
export const PREVIEW_CONTRACT = [
  "This is a live-preview session: the owner is watching your dev server in a " +
    "preview pane beside this chat, often on a phone, and wants to see the UI " +
    "change as you work. The preview contract:",
  "- Start the project's dev server early, before the main work, and leave it " +
    "running for the rest of the session, including across follow-up turns. " +
    "Do not stop it when a request is done.",
  "- Start it detached so it outlives the tool call and the turn that started " +
    `it: \`setsid nohup <dev command> > ${DEV_SERVER_LOG} 2>&1 < /dev/null &\`. ` +
    "A plain background job is killed when the turn ends and the preview goes " +
    "dark with it.",
  "- Bind it to all interfaces (0.0.0.0 — e.g. `--hostname 0.0.0.0` for Next, " +
    "`--host 0.0.0.0` for Vite/Astro). The preview proxy reaches the server " +
    "over the container network, so a server bound to localhost is invisible " +
    "to it. Use a conventional port (3000, 5173, 8080, …), never an ephemeral one.",
  "- The orchestrator detects the listening port itself and points the pane at " +
    "it; you do not need to report a URL. If you restart the server, restart it " +
    `the same way. \`${DEV_SERVER_LOG}\` is where to look when the pane is wrong.`,
  "- There is no Docker daemon in this container, by design, so `docker`, " +
    "`docker compose` and anything that needs a locally started service will " +
    "not work. Run what the repo can run in-process (SQLite, fixtures, mocks) " +
    "or reach remote services through the secrets already in `.env.local`. If " +
    "the app cannot run without a local service, say so plainly and show what " +
    "you can.",
].join("\n");

export interface ChatSeedInput {
  /** The owner's prompt: the title, with the description below it if any. */
  userPrompt: string;
  livePreview: boolean;
}

/**
 * A plain chat's seed is byte-identical to what it has always been. A
 * live-preview session's carries the contract between the prompt and the
 * standing instruction: the request first, then how this session differs.
 */
export function composeChatSeed({ userPrompt, livePreview }: ChatSeedInput): string {
  const parts = [userPrompt];
  if (livePreview) parts.push(PREVIEW_CONTRACT);
  parts.push(STANDING_INSTRUCTION);
  return parts.join("\n\n");
}
