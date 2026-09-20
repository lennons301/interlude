/**
 * One durable, serialized writer per ChatGPT account. Doppler supplies a seed;
 * subsequent turns use the CLI's updated cache, never that original seed.
 * Credentials stay out of the DB, streams, command line and host bind mounts.
 *
 * A durable in-flight marker intentionally fails closed after a crash or a
 * failed write-back: replaying the old refresh token can revoke the session.
 * A fresh, independently minted login reseeds it. No automatic stale-lock
 * deletion: a second orchestrator must not race a still-running first one.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { HarnessAuthIO } from "../adapter";
import type { TurnResult } from "../turn-result";
import type { ResolvedLane } from "../../lanes/resolve";

export const AUTH_ENV = "CODEX_AUTH_JSON";
export const AUTH_HOME_ENV = "INTERLUDE_CODEX_AUTH_HOME";
export const MAX_AUTH_BYTES = 64 * 1024;
const queues = new Map<string, Promise<void>>();

type Auth = { auth_mode: "chatgpt"; tokens: {
  account_id: string; access_token: string; refresh_token: string; id_token: string;
}; [key: string]: unknown };

export function parseManagedAuth(raw: string): Auth {
  // Never include the parser's exception or the supplied JSON in an error.
  try {
    if (Buffer.byteLength(raw) > MAX_AUTH_BYTES) throw new Error();
    const auth = JSON.parse(raw);
    if (auth.auth_mode !== "chatgpt" || auth.OPENAI_API_KEY ||
        !["account_id", "access_token", "refresh_token", "id_token"].every(
          key => typeof auth.tokens?.[key] === "string" && auth.tokens[key].length > 0
        )) throw new Error();
    return auth;
  } catch {
    throw new Error("Codex subscription needs a managed ChatGPT login from codex login (CODEX_AUTH_JSON).");
  }
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export function authStoreDirectory(databaseUrl = process.env.DATABASE_URL): string {
  return path.join(path.dirname(databaseUrl ?? "local.db"), "harness-auth", "codex");
}

async function atomicWrite(file: string, data: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(data));
    await handle.sync();
  } finally { await handle.close(); }
  await fs.rename(temporary, file);
  const directory = await fs.open(path.dirname(file), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

function refusal(message: string): TurnResult {
  return {
    sessionId: null, costUsd: 0, finalMessage: message,
    outcome: { kind: "refused", refusal: { kind: "auth", resumeAfter: null, limitType: null } },
    terminalResult: null, rateLimit: null, usage: null,
  };
}

export async function withCodexTurnAuth(
  lane: ResolvedLane, io: HarnessAuthIO,
  run: (lane: ResolvedLane) => Promise<TurnResult>,
  directory = authStoreDirectory()
): Promise<TurnResult> {
  const seed = lane.auth[AUTH_ENV];
  if (!seed) return run(lane);
  let auth: Auth;
  try { auth = parseManagedAuth(seed); } catch {
    return refusal("Codex subscription needs a fresh managed ChatGPT login in CODEX_AUTH_JSON.");
  }
  const key = hash(auth.tokens.account_id);
  const previous = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  queues.set(key, current);
  await previous;
  const file = path.join(directory, `${key}.json`);
  const lock = path.join(directory, `${key}.lock`);
  let ownsLock = false;
  let pending = false;
  let result: TurnResult | null = null;
  try {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    // Exclusive across processes as well as the in-process queue above.
    await fs.mkdir(lock, { mode: 0o700 });
    ownsLock = true;
    const seedHash = hash(auth.tokens.refresh_token);
    let state: { seedHash: string; auth: Auth; pending?: string } | null = null;
    try {
      state = JSON.parse(await fs.readFile(file, "utf8"));
      if (!state || typeof state.seedHash !== "string" || !/^[a-f0-9]{64}$/.test(state.seedHash)) {
        throw new Error("Invalid credential store metadata");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (state?.seedHash === seedHash) {
      if (state.pending) return refusal(
        "Codex credential write-back was interrupted. Sign in again with a dedicated production login and replace CODEX_AUTH_JSON before retrying."
      );
      auth = parseManagedAuth(JSON.stringify(state.auth));
      if (hash(auth.tokens.account_id) !== key) throw new Error("Account mismatch");
    }
    const home = `/home/node/.codex-exec.${randomUUID()}`;
    await atomicWrite(file, { seedHash, auth, pending: home });
    pending = true;
    const resolved = { ...lane, auth: { ...lane.auth,
      [AUTH_ENV]: JSON.stringify(auth), [AUTH_HOME_ENV]: home,
    } };
    result = await run(resolved);
    // The command leaves its managed home for us. It is removed only after
    // the new credential is durably stored, even for a refused/failed turn.
    const raw = await io.readFile(`${home}/auth.json`, MAX_AUTH_BYTES);
    if (!raw) throw new Error("Credential handoff unavailable");
    const updated = parseManagedAuth(raw.toString("utf8"));
    if (updated.tokens.account_id !== auth.tokens.account_id) throw new Error("Account mismatch");
    await atomicWrite(file, { seedHash, auth: updated, pending: home });
    await io.removeDirectory(home);
    await atomicWrite(file, { seedHash, auth: updated });
    pending = false;
    return result;
  } catch {
    // Provider errors and Docker errors can contain exec env. Do not log them.
    const message = pending
      ? "Codex credential write-back failed. The lane is held; provision a fresh production login before retrying."
      : "Codex credential storage is unavailable or locked by another process. Check the private harness-auth store before retrying.";
    // If the model already did work, retain its usage and session. A storage
    // failure is not a provider refusing the request before any work happened.
    return result ? { ...result, outcome: { kind: "failed", reason: message } } : refusal(message);
  } finally {
    if (ownsLock) await fs.rmdir(lock).catch(() => {});
    release();
    if (queues.get(key) === current) queues.delete(key);
  }
}
