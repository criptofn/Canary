#!/usr/bin/env node
/**
 * Does the trial harness's OWN prompt + environment still produce a working agent run?
 *
 * The plain arm ran 198k tokens at 15:xx and a guarded arm minutes later hung for 600s producing
 * zero tokens. A harness that succeeds and then hangs with no change is more likely an ENVIRONMENT
 * problem (a credential the harness forwards, a quota, a temporary outage) than a code problem.
 *
 * This probe reproduces the harness's invocation exactly:
 *   - the same flags;
 *   - the same environment, built the way `run-trial.mjs` builds it (the project/local settings
 *     `env` block forwarded into the child);
 *   - a trivial prompt that needs no tools.
 *
 * It then reports latency, exit code and the stream's own usage numbers, so "the model answered"
 * and "the request never reached a model" are distinguishable facts.
 *
 * Usage: node tooling/probes/v12-agent-env-smoke.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const TIMEOUT_MS = Number(process.env.AGENT_SMOKE_TIMEOUT_MS ?? 120_000);
const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');

/** The env the trial runner builds: process.env, then the user settings `env` block for gaps. */
function harnessEnv() {
  const env = { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  const forwarded = [];
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
    for (const [k, v] of Object.entries(raw.env ?? {})) {
      if (typeof v === 'string' && (env[k] === undefined || env[k] === '')) {
        env[k] = v;
        forwarded.push(k);
      }
    }
  } catch (e) {
    console.log(`could not read ${SETTINGS}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { env, forwarded };
}

function smoke(label, env) {
  return new Promise((resolve) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-smoke-'));
    const outPath = path.join(dir, 'out.jsonl');
    const errPath = path.join(dir, 'err.txt');
    const outFd = fs.openSync(outPath, 'w');
    const errFd = fs.openSync(errPath, 'w');
    const args = [
      '-p', 'Reply with exactly: SMOKE-OK',
      '--output-format', 'stream-json', '--verbose',
      '--permission-mode', 'acceptEdits',
      '--strict-mcp-config',
      '--setting-sources', 'project,local',
      '--allowedTools', 'Read',
    ];
    const started = Date.now();
    const child = spawn('claude', args, { cwd: dir, windowsHide: true, stdio: ['ignore', outFd, errFd], env });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, TIMEOUT_MS);
    child.on('error', (e) => {
      clearTimeout(timer);
      console.log(`FAIL ${label}: spawn error ${e.message}`);
      resolve(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      try { fs.closeSync(outFd); fs.closeSync(errFd); } catch { /* closed */ }
      const out = (() => { try { return fs.readFileSync(outPath, 'utf8'); } catch { return ''; } })();
      const err = (() => { try { return fs.readFileSync(errPath, 'utf8'); } catch { return ''; } })();
      const secs = Math.round((Date.now() - started) / 100) / 10;
      let usage = null;
      for (const line of out.split('\n')) {
        if (/"type":"result"/.test(line)) {
          try {
            const ev = JSON.parse(line);
            usage = { total: ev.usage?.output_tokens, apiMs: ev.duration_api_ms, cost: ev.total_cost_usd, subtype: ev.subtype, isError: ev.is_error };
          } catch { /* ignore */ }
        }
      }
      const answered = usage !== null && (usage.total ?? 0) > 0;
      console.log(`${answered ? 'PASS' : 'FAIL'} ${label}: exit=${String(code)} in ${secs}s usage=${JSON.stringify(usage)}`);
      if (!answered) {
        const first = out.split('\n').find((l) => l.trim() !== '') ?? '';
        console.log(`     first stream line: ${first.slice(0, 300)}`);
        if (err.trim() !== '') console.log(`     stderr: ${err.trim().split('\n').slice(0, 3).join(' | ').slice(0, 300)}`);
      }
      fs.rmSync(dir, { recursive: true, force: true });
      resolve(answered);
    });
  });
}

const { env, forwarded } = harnessEnv();
console.log(`forwarded from ${SETTINGS}: ${forwarded.length > 0 ? forwarded.join(', ') : '(nothing — all already present)'}`);
console.log(`ANTHROPIC_BASE_URL present: ${typeof env.ANTHROPIC_BASE_URL === 'string' && env.ANTHROPIC_BASE_URL !== ''}`);
console.log(`ANTHROPIC_AUTH_TOKEN present: ${typeof env.ANTHROPIC_AUTH_TOKEN === 'string' && env.ANTHROPIC_AUTH_TOKEN !== ''} (value never printed)`);
console.log('');

const ok = await smoke('harness env (settings forwarded)', env);

// A second run without the forwarded credential, to confirm the credential is what decides it.
const stripped = { ...env };
delete stripped.ANTHROPIC_AUTH_TOKEN;
const okStripped = await smoke('control: same env WITHOUT the auth token', stripped);

console.log('');
console.log(ok
  ? 'VERDICT: the harness environment still produces a model response — the earlier guarded timeout is not explained by the environment.'
  : 'VERDICT: the harness environment does NOT produce a model response — every trial will burn its full timeout with zero tokens, and this must be fixed before any comparison is run.');
console.log(`(control without the token: ${okStripped ? 'still answered — the token is not required here' : 'no response, as expected if the token is what authorizes'})`);
