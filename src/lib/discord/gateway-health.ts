/**
 * What the Discord gateway has delivered to this process lately, against what
 * this process has sent (issue #135).
 *
 * Everything Interlude *sends* to Discord goes out over REST; everything that
 * comes *in* — a blocked run's answer, an arming "yes", a ✅ completion, a new
 * task — arrives over exactly one gateway session. The two halves fail
 * independently, and only the outbound half was observable: on 2026-08-13 the
 * fleet kept posting embeds for hours while a correct reply to a blocked run's
 * question never reached the process, and the run sat `blocked` for 6.5 hours
 * behind a card that looked like one nobody had answered.
 *
 * The signal that makes the deaf half visible is the **echo**: every message
 * the bot posts comes back to it as a `MESSAGE_CREATE` dispatch, like any other
 * message in a channel it can see. So "we sent something and the gateway has
 * delivered nothing since" is a precise statement that inbound is dead — it
 * cannot fire on a quiet fleet (nothing sent, nothing expected), and it does
 * fire on a zombie session whose heartbeats still ACK but whose dispatches
 * have stopped, which discord.js itself cannot detect. The evaluator in
 * `fleet/health.ts` decides; this only remembers the two clocks.
 *
 * On `globalThis` via `processSingleton` because outbound sends happen from
 * both module graphs — `POST /api/tasks/[id]/complete` posts the completed
 * embed from a route handler — while the gateway and the sweep live in the
 * orchestrator's.
 */

import { processSingleton } from "@/lib/process-singleton";
import type { DiscordGatewayObservation } from "../fleet/health";

interface GatewayHealth {
  lastInboundMs: number | null;
  lastOutboundMs: number | null;
  /** When the current session became ready (ms); null until the bot has
   * connected once this process — and so also the "is this bot meant to be
   * receiving at all" switch the watchdog reads. */
  connectedSinceMs: number | null;
  /** Fresh clients logged in after the library gave a shard up, for the log line. */
  relogins: number;
}

const state = processSingleton<GatewayHealth>("discord.gatewayHealth", () => ({
  lastInboundMs: null,
  lastOutboundMs: null,
  connectedSinceMs: null,
  relogins: 0,
}));

/** Any event the gateway delivered — a message, a reaction, a resume. */
export function recordDiscordInbound(nowMs: number = Date.now()): void {
  state.lastInboundMs = nowMs;
}

/** A message the bot posted over REST and should see echoed back. Record it
 * on success only: a send that failed produced nothing to echo. */
export function recordDiscordOutbound(nowMs: number = Date.now()): void {
  state.lastOutboundMs = nowMs;
}

export function recordDiscordConnected(nowMs: number = Date.now()): void {
  state.connectedSinceMs = nowMs;
  // A fresh session is a fresh gateway: it has delivered nothing yet, and an
  // outbound that predates it is not owed an echo by it.
  state.lastInboundMs = nowMs;
}

export function recordDiscordRelogin(): number {
  return ++state.relogins;
}

/** The two clocks for the watchdog, or null while the bot has never connected
 * this process (not configured, or still logging in) — null decides nothing. */
export function observeDiscordGateway(): DiscordGatewayObservation | null {
  if (state.connectedSinceMs == null) return null;
  return { lastOutboundMs: state.lastOutboundMs, lastInboundMs: state.lastInboundMs };
}

/** For tests. */
export function resetDiscordGatewayHealth(): void {
  state.lastInboundMs = null;
  state.lastOutboundMs = null;
  state.connectedSinceMs = null;
  state.relogins = 0;
}
