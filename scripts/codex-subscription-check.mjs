#!/usr/bin/env node
// Attended probe using an explicitly selected, dedicated ChatGPT login.
// It never prints credential contents or raw CLI output. Keep this home: the
// refreshed auth.json, not its original copy, is the credential to provision.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { parse } from 'yaml';

const args = process.argv.slice(2);
const homeIndex = args.indexOf('--home');
if (homeIndex < 0 || !args[homeIndex + 1]) {
  console.error('Usage: node scripts/codex-subscription-check.mjs --home /private/dedicated-codex-home [--exercise-refresh]');
  process.exit(2);
}
const home = path.resolve(args[homeIndex + 1]);
const file = path.join(home, 'auth.json');
const auth = () => JSON.parse(fs.readFileSync(file, 'utf8'));
const initial = auth();
if (initial.auth_mode !== 'chatgpt' || !initial.tokens?.refresh_token || initial.OPENAI_API_KEY) {
  throw new Error('The selected home must contain a managed ChatGPT login, not an API key.');
}
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'interlude-subscription-probe-'));
const catalog = parse(fs.readFileSync(new URL('../lanes.yaml', import.meta.url), 'utf8'));
const lane = catalog.lanes.find(lane => lane.id === 'codex-subscription');
const models = ['light', 'standard', 'heavy'].map(tier => lane.models[tier]);
function turn(model, prompt, session) {
  const command = ['--sandbox', 'read-only', 'exec'];
  if (session) command.push('resume', session);
  command.push('--json', '--skip-git-repo-check', '-c', 'features.plugins=false', '-c', 'model_reasoning_effort="low"', '-m', model, '-');
  // Explicit env allowlist: do not inherit API credentials or provider URLs.
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, CODEX_HOME: home };
  for (const name of ['SSL_CERT_FILE', 'CODEX_CA_CERTIFICATE', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  const result = spawnSync('codex', command, { cwd, env, input: prompt, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  const events = result.stdout?.split('\n').flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  }) ?? [];
  const completed = events.some(event => event.type === 'turn.completed');
  const failed = events.some(event => event.type === 'turn.failed');
  console.log(JSON.stringify({ model, resumed: !!session, exitCode: result.status, completed, failed }));
  if (result.status !== 0 || !completed || failed) throw new Error('Codex probe did not complete. No raw output was printed because it may contain account information.');
  return events.find(event => event.type === 'thread.started')?.thread_id;
}
try {
  const thread = turn(models[0], 'Reply exactly INTERLUDE_CODEX_OK. Do not use tools.');
  if (!thread) throw new Error('Codex did not report a resumable thread.');
  turn(models[0], 'Reply exactly INTERLUDE_RESUME_OK. Do not use tools.', thread);
  for (const model of models.slice(1)) turn(model, 'Reply exactly INTERLUDE_CODEX_OK. Do not use tools.');
  if (args.includes('--exercise-refresh')) {
    const before = auth();
    // Ask the official app-server auth endpoint to force a managed refresh.
    // Merely aging last_refresh is not sufficient on every CLI version.
    await new Promise((resolve, reject) => {
      const child = spawn('codex', ['app-server', '-c', 'features.plugins=false'], {
        cwd, env: { PATH: process.env.PATH, HOME: process.env.HOME, CODEX_HOME: home },
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      let buffer = '';
      const timer = setTimeout(() => finish(new Error('Managed refresh timed out.')), 30_000);
      let done = false;
      function finish(error) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        child.kill();
        if (error) reject(error); else resolve();
      }
      child.on('error', () => finish(new Error('Could not start the auth probe.')));
      child.on('exit', () => { if (!done) finish(new Error('Auth probe exited before replying.')); });
      child.stdout.on('data', chunk => {
        buffer += chunk;
        while (buffer.includes('\n')) {
          const index = buffer.indexOf('\n');
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          let event;
          try { event = JSON.parse(line); } catch { continue; }
          if (event.error) return finish(new Error('Managed auth refresh was refused.'));
          if (event.id === 1) {
            child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
            child.stdin.write(JSON.stringify({ method: 'account/read', id: 2, params: { refreshToken: true } }) + '\n');
          }
          if (event.id === 2) {
            if (event.result?.account?.type !== 'chatgpt') return finish(new Error('Auth probe did not confirm ChatGPT authentication.'));
            finish();
          }
        }
      });
      child.stdin.write(JSON.stringify({ method: 'initialize', id: 1, params: {
        clientInfo: { name: 'interlude_subscription_probe', version: '1.0.0' },
      } }) + '\n');
    });
    const after = auth();
    const refreshed = after.last_refresh !== before.last_refresh;
    const rotated = before.tokens.refresh_token !== after.tokens.refresh_token;
    console.log(JSON.stringify({ refreshed, refreshTokenRotated: rotated }));
    if (!refreshed) throw new Error('A real credential refresh was not observed.');
    turn(models[0], 'Reply exactly INTERLUDE_AFTER_REFRESH_OK. Do not use tools.');
  }
} finally { fs.rmSync(cwd, { recursive: true, force: true }); }
