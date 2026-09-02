/**
 * The harness adapter seam (issue #172) — what it takes to run one agent turn,
 * expressed as an interface so the substrate is pluggable.
 *
 * The three functions below are the ones issue #164 named, and they were
 * chosen because they were already pure and already unit-tested: build the
 * exec environment, build the harness command, create the output handler. A
 * harness is exactly those three answers plus the variable names it reads its
 * credentials from — everything else about running a pass (provisioning the
 * container, minting the git token, streaming into the feed, parking and
 * resuming) is the orchestrator's and does not vary by vendor.
 *
 * **One adapter ships** — Claude Code. The interface is reviewed against what
 * an OpenCode or Codex adapter would need, and that review is what shaped it:
 *
 * - Nothing here names a vendor. A resolved lane hands over `auth` as
 *   `harness variable -> value` rather than "the OAuth token", because which
 *   variable a harness reads is the harness's fact and which secret goes in it
 *   is the lane's; a second adapter changes the former without touching
 *   `lanes.yaml`'s shape.
 * - A lane's `baseUrl` is handed over as a *value*, not as a variable name: a
 *   lane knows *which endpoint*, and how a harness is told about it — Claude
 *   Code's `ANTHROPIC_BASE_URL`, some other harness's flag or config file — is
 *   the adapter's own business, settled inside `buildExecEnv`.
 * - `createOutputHandler` is part of the interface rather than a shared
 *   utility because a different harness emits a different stream format. It is
 *   the member most likely to be mistaken for orchestrator code, and the one a
 *   second adapter would most certainly have to replace.
 * - Prompt delivery is deliberately *not* a parameter of the command builder:
 *   Claude Code takes the prompt through an environment variable so it never
 *   lands in a shell command line, and another harness may take a file or
 *   stdin. The env builder and the command builder are handed the same inputs
 *   and agree between themselves.
 */

import type { ResolvedLane } from "../lanes/resolve";
import type { LaneAdapterId } from "../lanes/lane-config";
import type { TurnResult } from "../orchestrator/output-parser";

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
  /** Reasoning-effort level (issue #81), or null for the harness's default. */
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

export interface HarnessAdapter {
  readonly id: LaneAdapterId;
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
}
