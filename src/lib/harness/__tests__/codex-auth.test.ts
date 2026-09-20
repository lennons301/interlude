import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AUTH_ENV, AUTH_HOME_ENV, parseManagedAuth, withCodexTurnAuth } from "../codex/auth";
import type { ResolvedLane } from "../../lanes/resolve";
import type { TurnResult } from "../turn-result";

const roots: string[] = [];
const auth = (refresh = "original", account = "account-one") => JSON.stringify({
  auth_mode: "chatgpt", tokens: { account_id: account, access_token: "access", refresh_token: refresh, id_token: "id" },
});
const lane = (seed = auth()) => ({ id: "subscription", label: "Subscription", adapter: "codex", billing: "subscription",
  capabilities: { userInvokedSkills: true, quotaTelemetry: false, reportsCost: false, sessionResume: true },
  baseUrl: null, tier: "standard", model: "gpt-5.6-terra", prices: null, declaresPrices: false, caps: { dailyBudgetUsd: null },
  auth: { [AUTH_ENV]: seed } }) satisfies ResolvedLane;
const completed: TurnResult = {
  sessionId: "thread", costUsd: 0, finalMessage: "done", outcome: { kind: "completed" },
  terminalResult: null, rateLimit: null, usage: null,
};
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "interlude-auth-test-"));
  roots.push(root);
  const io = { readFile: vi.fn(async (): Promise<Buffer | null> => Buffer.from(auth("rotated"))), removeDirectory: vi.fn(async () => {}) };
  return { root, io };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

describe("managed subscription credential lifecycle", () => {
  it("writes back rotated tokens before cleanup and uses them for a fresh subsequent turn", async () => {
    const { root, io } = await setup();
    io.removeDirectory.mockImplementation(async () => {
      const name = (await fs.readdir(root)).find(name => name.endsWith(".json"))!;
      expect(JSON.parse(await fs.readFile(path.join(root, name), "utf8")).auth.tokens.refresh_token).toBe("rotated");
      expect((await fs.stat(path.join(root, name))).mode & 0o777).toBe(0o600);
    });
    const first = vi.fn(async (resolved: ResolvedLane) => {
      expect(resolved.auth[AUTH_HOME_ENV]).toMatch(/^\/home\/node\/\.codex-exec\.[a-f0-9-]+$/);
      return completed;
    });
    expect(await withCodexTurnAuth(lane(), io, first, root)).toEqual(completed);
    const second = vi.fn(async (resolved: ResolvedLane) => {
      expect(parseManagedAuth(resolved.auth[AUTH_ENV]).tokens.refresh_token).toBe("rotated");
      return completed;
    });
    expect(await withCodexTurnAuth(lane(), io, second, root)).toEqual(completed);
    expect(io.removeDirectory).toHaveBeenCalledTimes(2);
  });

  it("serializes two lanes on one account so the second sees the first refresh", async () => {
    const { root, io } = await setup();
    let finish!: () => void;
    let started!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    const one = withCodexTurnAuth(lane(), io, async () => { started(); await gate; return completed; }, root);
    await entered;
    const runTwo = vi.fn(async (resolved: ResolvedLane) => {
      expect(parseManagedAuth(resolved.auth[AUTH_ENV]).tokens.refresh_token).toBe("rotated");
      return completed;
    });
    const two = withCodexTurnAuth({ ...lane(), id: "another-lane" }, io, runTwo, root);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(runTwo).not.toHaveBeenCalled();
    finish();
    await Promise.all([one, two]);
    expect(runTwo).toHaveBeenCalledOnce();
  });

  it("holds the next turn if a completed turn's credential cannot be saved, retaining its usage", async () => {
    const { root, io } = await setup();
    io.readFile.mockResolvedValueOnce(null);
    const result = await withCodexTurnAuth(lane(), io, async () => ({ ...completed, costUsd: 2 }), root);
    expect(result).toMatchObject({ costUsd: 2, sessionId: "thread", outcome: { kind: "failed" } });
    const run = vi.fn(async () => completed);
    expect(await withCodexTurnAuth(lane(), io, run, root)).toMatchObject({ outcome: { kind: "refused", refusal: { kind: "auth" } } });
    expect(run).not.toHaveBeenCalled();
    expect(io.removeDirectory).not.toHaveBeenCalled();
    // An independently minted seed is an explicit recovery, never the old seed.
    expect(await withCodexTurnAuth(lane(auth("new-login")), io, run, root)).toEqual(completed);
  });

  it("does not copy or clear an in-flight credential when process exit was not confirmed", async () => {
    const { root, io } = await setup();
    await withCodexTurnAuth(lane(), io, async () => { throw new Error("exec still running with sensitive env"); }, root);
    expect(io.readFile).not.toHaveBeenCalled();
    expect(io.removeDirectory).not.toHaveBeenCalled();
    const run = vi.fn(async () => completed);
    const next = await withCodexTurnAuth(lane(), io, run, root);
    expect(run).not.toHaveBeenCalled();
    expect(JSON.stringify(next)).not.toContain("sensitive env");
  });

  it("rejects account swaps and corrupt credential output without logging its contents", async () => {
    for (const bad of [auth("private-refresh", "different-account"), "private-invalid-json"]) {
      const { root, io } = await setup();
      io.readFile.mockResolvedValue(Buffer.from(bad));
      const result = await withCodexTurnAuth(lane(), io, async () => completed, root);
      expect(result.outcome?.kind).toBe("failed");
      expect(JSON.stringify(result)).not.toContain("private-");
      expect(io.removeDirectory).not.toHaveBeenCalled();
    }
  });

  it("saves updated auth even when the provider refused the turn", async () => {
    const { root, io } = await setup();
    const result: TurnResult = { ...completed, outcome: { kind: "refused", refusal: { kind: "quota", resumeAfter: null, limitType: null } } };
    expect(await withCodexTurnAuth(lane(), io, async () => result, root)).toEqual(result);
    expect(io.removeDirectory).toHaveBeenCalledOnce();
  });

  it("passes API-key lanes through without creating storage or touching files", async () => {
    const { root, io } = await setup();
    const api = { ...lane(), auth: { CODEX_API_KEY: "key" } };
    const run = vi.fn(async () => completed);
    expect(await withCodexTurnAuth(api, io, run, root)).toEqual(completed);
    expect(run).toHaveBeenCalledWith(api);
    expect(await fs.readdir(root)).toEqual([]);
    expect(io.readFile).not.toHaveBeenCalled();
  });

  it("does not replay the original seed over corrupt persisted metadata", async () => {
    const { root, io } = await setup();
    await withCodexTurnAuth(lane(), io, async () => completed, root);
    const file = path.join(root, (await fs.readdir(root)).find(name => name.endsWith(".json"))!);
    for (const damaged of ["null", "{}", "not-json"]) {
      await fs.writeFile(file, damaged);
      const run = vi.fn(async () => completed);
      expect((await withCodexTurnAuth(lane(), io, run, root)).outcome).toMatchObject({ kind: "refused" });
      expect(run).not.toHaveBeenCalled();
    }
  });

  it("refuses API auth, missing refresh tokens, oversized and malformed seeds", async () => {
    for (const seed of ["not-json", "x".repeat(70_000), '{"auth_mode":"apikey"}', '{"auth_mode":"chatgpt","tokens":{}}']) {
      const { root, io } = await setup();
      const run = vi.fn(async () => completed);
      expect((await withCodexTurnAuth(lane(seed), io, run, root)).outcome).toMatchObject({ kind: "refused", refusal: { kind: "auth" } });
      expect(run).not.toHaveBeenCalled();
    }
  });
});
