/**
 * The harness adapter seam (issues #172, #214) — what it takes to run one
 * agent turn, expressed as an interface so the substrate is pluggable.
 *
 * Issue #172 drew the seam at the three functions that were already pure and
 * already unit-tested: build the exec environment, build the harness command,
 * create the output handler. Everything else about running a pass —
 * provisioning the container, minting the git token, streaming into the feed,
 * parking and resuming — is the orchestrator's and does not vary by vendor.
 *
 * Issue #214 widened it to what a **second** harness actually needs, in an
 * expand step that changes nothing about the Claude lane. A second harness
 * has its own image, its own way of being asked to load a skill, its own
 * session artefacts, its own effort dial, and — the load-bearing one — its
 * own way of saying how a turn ended. So an adapter now also declares:
 *
 * - `image`: which agent image its containers run — a thin layer on the shared
 *   agent base, built and kept current by the image builder. Image selection
 *   is the adapter's fact; the turn manager reads it off the resolved lane's
 *   adapter and hands it to container creation (issue #216).
 * - `capabilities`: static booleans — skills, quota telemetry, cost
 *   reporting, session resume — read by the lane parser, the router and the
 *   dashboard. Declared once, and pinned to the descriptor table the parser
 *   reads (`descriptors.ts`), so the two cannot drift.
 * - `composeSkillInvocation`: the text that makes this harness load a named
 *   skill with an agenda. Claude Code keeps its slash; Codex mentions a
 *   `$skill`; a harness that loads skills through a tool is told to.
 * - `sessionArtifactPaths`: the container paths that hold a session's
 *   replayable state — what a pause copies out and a resume copies back.
 * - `mapEffort`: the harness's own name for a fleet effort level, or null for
 *   "no equivalent" — the level is then omitted, never guessed at.
 * - A **normalised outcome** on the turn result (`turn-result.ts`): the turn
 *   manager and the reducer branch on `completed | turn-limit | refused |
 *   failed` and on nothing else. The vendor's verbatim fields stay on the
 *   result for the recorder.
 *
 * The review that shaped the seam still holds, and is why nothing here names
 * a vendor:
 *
 * - A resolved lane hands over `auth` as `harness variable -> value` rather
 *   than "the OAuth token", because which variable a harness reads is the
 *   harness's fact and which secret goes in it is the lane's; a second adapter
 *   changes the former without touching `lanes.yaml`'s shape.
 * - A lane's `baseUrl` is handed over as a *value*, not as a variable name: a
 *   lane knows *which endpoint*, and how a harness is told about it — Claude
 *   Code's `ANTHROPIC_BASE_URL`, some other harness's flag or config file — is
 *   the adapter's own business, settled inside `buildExecEnv`.
 * - `createOutputHandler` is part of the interface rather than a shared
 *   utility because a different harness emits a different stream format. It
 *   is the member most likely to be mistaken for orchestrator code, which is
 *   why the Claude Code stream parser lives under its adapter
 *   (`claude-code/stream-parser.ts`) and the orchestrator does not import it.
 * - Prompt delivery is deliberately *not* a parameter of the command builder:
 *   Claude Code takes the prompt through an environment variable so it never
 *   lands in a shell command line, and another harness may take a file or
 *   stdin. The env builder and the command builder are handed the same inputs
 *   and agree between themselves.
 *
 * **A limit, now enforced (issues #199, #217): a lane move carries the
 * session only between lanes on the same adapter.** The Claude lanes all run
 * the one Claude Code adapter, differing only in endpoint, credential variable
 * and model identifiers — which is *why* a pass refused on one of them can
 * continue the same conversation on another (#176's failover, #199's early
 * resume of a paused run): the artefacts `session-transcript.ts` copies out of
 * the refused container are one harness's format, replayed under a session id
 * only that harness has heard of. Two members make that stay true now that the
 * Codex lanes (#221) name a second adapter. `sessionArtifactPaths` makes the
 * artefacts the adapter's rather than a fixed path — the store copies exactly
 * what the adapter names, and nothing at all for an adapter whose
 * `sessionResume` is false. And `restoreSessionTranscript` in the turn manager
 * — the one seam that knows both the lane the pass is starting on and the pass
 * it continues (`tasks.resumedFromTaskId` -> its `lane` -> its adapter) —
 * decides through the pure `decideSessionCarry` (`session-carry.ts`) whether
 * the conversation crosses: the same adapter on both ends puts the artefacts
 * back and resumes by id; a different adapter, or a harness that cannot
 * resume, starts the pass again on the branch with the work already pushed,
 * clears its session id and tells the owner on the feed which two lanes and
 * why. The lane ranking is unchanged — a cross-adapter lane is a legal
 * failover target; it costs the conversation, not the attempt.
 */

import type { ResolvedLane } from "../lanes/resolve";
import type { HarnessCapabilities } from "./descriptors";
import type { TurnResult } from "./turn-result";

export type {
  TurnOutcome,
  TurnRefusal,
  TurnRefusalKind,
  TurnResult,
} from "./turn-result";
export type { HarnessCapabilities } from "./descriptors";

export interface HarnessExecEnvInput {
  /** The turn's prompt. */
  prompt: string;
  /** Short-lived GitHub App installation token for the git credential helper.
   * Exec-scoped like everything else here. */
  gitAuthToken: string;
  /**
   * The same App token, exposed to `gh` for a generation-session exec only
   * (issue #62), and null for every autonomous pass kind — a token that can
   * create issues can also apply the launch-button label.
   */
  ghToken: string | null;
  /** The lane this turn runs on: its auth values and endpoint. */
  lane: ResolvedLane;
}

export interface HarnessCommandInput {
  /** Resume a prior session rather than starting fresh. */
  sessionId?: string;
  /** Per-exec budget ceiling; falls back to the configured default. */
  maxBudgetUsd?: number;
  /** Per-exec turn ceiling; falls back to the configured default. */
  maxTurns?: number;
  /**
   * The fleet's reasoning-effort level (issue #81), or null for the harness's
   * default. Always one of `ALLOWED_TICKET_EFFORTS` — both entry points
   * validate against that list — and the adapter maps it through its own
   * `mapEffort`, omitting the flag where it has no equivalent.
   */
  effort?: string | null;
  /** The lane this turn runs on — the model identifier comes from it. */
  lane: ResolvedLane;
}

/** What the orchestrator streams a turn's raw output into. */
export interface HarnessOutputHandler {
  write(chunk: Buffer): void;
  flush(): TurnResult;
  onDone(callback: () => void): void;
}

/**
 * The agent image an adapter's containers run: the tag to run and the
 * Dockerfile it is built from. One image per adapter (issue #216): the
 * Dockerfile is the adapter's *layer* — `FROM` the shared agent base
 * (`Dockerfile.agent-base`, which carries git, gh, yq, jq, pnpm, the workspace
 * user and the pinned skills), installing one harness and pre-accepting its
 * headless mode. The image builder builds the base first, stamps the adapter
 * image with a hash over both files, and rebuilds it when either changes.
 */
export interface HarnessImage {
  /** The image reference, as `docker run` takes it (`name:tag`). */
  name: string;
  /** The Dockerfile the image is built from, as a path relative to the repo
   * root — by convention `Dockerfile.agent-<adapter id>` at the root. */
  dockerfile: string;
}

export interface HarnessAdapter {
  /**
   * The id a lane names in `lanes.yaml`. A string rather than the production
   * table's literal union, because the registry accepts a test double
   * (`registerHarnessAdapter`) that the table deliberately does not describe;
   * the pin test holds the production registry to the table.
   */
  readonly id: string;
  /** The agent image this adapter's containers run. */
  readonly image: HarnessImage;
  /** What this harness can do, declared once — see `descriptors.ts`. */
  readonly capabilities: HarnessCapabilities;
  /** The environment one `docker exec` of a turn runs with. */
  buildExecEnv(input: HarnessExecEnvInput): string[];
  /** The shell command that runs one turn inside the container. */
  buildCommand(input: HarnessCommandInput): string;
  /**
   * A handler for this harness's output stream.
   *
   * Takes the lane for the same reason the other two members do (issue #175):
   * a stream carries quota telemetry, and quota belongs to the lane's account,
   * not to the fleet. Handing the lane over here rather than letting the
   * handler reach for a fleet-wide default is what keeps a lane that reports no
   * quota from inheriting one.
   */
  createOutputHandler(taskId: string, lane: ResolvedLane): HarnessOutputHandler;
  /**
   * The text that makes this harness load the named skill and follow it, with
   * the agenda (if any) as the skill's argument. The seed composer and the
   * follow-on slash router ask this rather than emitting `/skill` text (issue
   * #218); on Claude Code it is exactly the slash they emit today.
   */
  composeSkillInvocation(skill: string, agenda: string | null): string;
  /**
   * The container paths holding everything needed to resume `sessionId` for a
   * pass working in `cwd` — what a pause copies out and a resume copies back
   * (issues #169, #217). Empty for a harness that cannot resume a session.
   */
  sessionArtifactPaths(sessionId: string, cwd: string): string[];
  /**
   * This harness's own name for a fleet effort level, or null when it has no
   * equivalent — in which case the level is omitted from the command (and
   * noted on the task, which the first adapter with a partial map brings:
   * issues #221, #222), never approximated silently.
   */
  mapEffort(level: string): string | null;
}
