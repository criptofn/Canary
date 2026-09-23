#!/usr/bin/env node
/**
 * Reproduce the guarded-arm hang, narrowly.
 *
 * A guarded trial timed out at 600s with ZERO tokens while the plain arm on the same fixture
 * finished in 183s. `setup` had succeeded (READY, hook installed) and the agent was spawned with
 * credentials forwarded, so the hang is in the guarded arm's agent invocation specifically.
 *
 * This probe runs the SAME minimal prompt twice on the same project — once with a trivial prompt on
 * a bare git repo, once with the Canary-wired project — so the difference is the wiring and nothing
 * else. It uses file-descriptor capture and a hard timeout, and it reports time-to-first-byte, which
 * is the fact that distinguishes "slow" from "hung".
 *
 * Usage: node tooling/probes/v12-guarded-hang.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const CLI = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');
const FIX = path.join(REPO, 'tooling', 'benchmark', 'fixtures', 'cli-exit-codes');
const TIMEOUT_MS = Number(process.env.HANG_PROBE_TIMEOUT_MS ?? 120_000);

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    if (e.isDirectory()) copyDir(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

function runSync(cmd, args, cwd) {
  return spawnSync(cmd, args, { cwd, encoding: 'utf8', windowsHide: true });
}

/**
 * Spawn `claude -p` with the SAME flags the trial runner uses, and observe time to first output.
 * Output is appended to a file so that a hang after partial output is still visible.
 */
function probe(label, projectDir, prompt) {
  return new Promise((resolve) => {
    const outPath = path.join(projectDir, 'probe-agent.out');
    const errPath = path.join(projectDir, 'probe-agent.err');
    const outFd = fs.openSync(outPath, 'w');
    const errFd = fs.openSync(errPath, 'w');
    const args = [
      '-p', prompt,
      '--output-format', 'stream-json', '--verbose',
      '--permission-mode', 'acceptEdits',
      '--strict-mcp-config',
      '--setting-sources', 'project,local',
      '--allowedTools', 'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep',
    ];
    const started = Date.now();
    const child = spawn('claude', args, { cwd: projectDir, windowsHide: true, stdio: ['ignore', outFd, errFd] });
    let firstByteAt = null;
    const watch = setInterval(() => {
      if (firstByteAt === null) {
        try {
          if (fs.statSync(outPath).size > 0) firstByteAt = Date.now();
        } catch { /* not yet */ }
      }
    }, 250);
    const timer = setTimeout(() => {
      clearInterval(watch);
      try { child.kill('SIGKILL'); } catch { /* gone */ }
      finish('TIMEOUT');
    }, TIMEOUT_MS);
    const finish = (how) => {
      clearTimeout(timer);
      clearInterval(watch);
      try { fs.closeSync(outFd); fs.closeSync(errFd); } catch { /* closed */ }
      const out = (() => { try { return fs.readFileSync(outPath, 'utf8'); } catch { return ''; } })();
      const err = (() => { try { return fs.readFileSync(errPath, 'utf8'); } catch { return ''; } })();
      console.log(`${how === 'TIMEOUT' ? 'FAIL' : 'PASS'} ${label}: ${how} after ${Math.round((Date.now() - started) / 100) / 10}s`);
      console.log(`     time to first output byte: ${firstByteAt === null ? 'NEVER' : `${Math.round((firstByteAt - started) / 100) / 10}s`}`);
      console.log(`     stdout bytes: ${out.length}, stderr bytes: ${err.length}`);
      if (err.trim() !== '') console.log(`     stderr: ${err.trim().split('\n').slice(0, 3).join(' | ').slice(0, 300)}`);
      if (out.trim() !== '') {
        const lines = out.trim().split('\n');
        const first = lines[0] ?? '';
        console.log(`     first stream line: ${first.slice(0, 400)}`);
        // Surface an error/result event: the reason an invocation fails is IN the stream, not on stderr.
        for (const line of lines) {
          if (/"type":"result"/.test(line) || /"is_error":true/.test(line) || /"subtype":"error/.test(line)) {
            console.log(`     stream says: ${line.slice(0, 400)}`);
          }
        }
      }
      resolve({ how, stdout: out, stderr: err });
    };
    child.on('error', (e) => { console.log(`     spawn error: ${e.message}`); finish('SPAWN-ERROR'); });
    child.on('close', (code) => finish(`exit ${String(code)}`));
  });
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-hang-'));

try {
  // --- bare repo, no Canary wiring
  const bare = path.join(root, 'bare');
  copyDir(path.join(FIX, 'project'), bare);
  runSync('git', ['init', '-b', 'main'], bare);
  runSync('git', ['-c', 'user.email=b@c.d', '-c', 'user.name=B', 'add', '-A'], bare);
  runSync('git', ['-c', 'user.email=b@c.d', '-c', 'user.name=B', 'commit', '-m', 'init'], bare);

  // --- same project, wired by canary setup
  const wired = path.join(root, 'wired');
  copyDir(path.join(FIX, 'project'), wired);
  // v1.4 — declare the harness IN THE FIXTURE: `setup` requires a detected harness and reads
  // `<root>/.claude` or the operator's `~/.claude`, so without this the "Canary-wired" repository
  // of this probe was wired only on a machine that has Claude Code installed.
  fs.mkdirSync(path.join(wired, '.claude'), { recursive: true });
  runSync('git', ['init', '-b', 'main'], wired);
  runSync('git', ['-c', 'user.email=b@c.d', '-c', 'user.name=B', 'add', '-A'], wired);
  runSync('git', ['-c', 'user.email=b@c.d', '-c', 'user.name=B', 'commit', '-m', 'init'], wired);
  const setup = runSync(process.execPath, [CLI, 'setup', '--yes', wired], wired);
  console.log(`canary setup: exit ${String(setup.status)}, hook installed: ${fs.existsSync(path.join(wired, '.claude', 'settings.json'))}`);
  console.log('');

  const PROMPT = 'Reply with exactly: PROBE-OK. Do not read or modify any file.';
  await probe('bare repo (no Canary)', bare, PROMPT);
  await probe('Canary-wired repo', wired, PROMPT);

  if (fs.existsSync(path.join(wired, '.claude', 'settings.json'))) {
    console.log('\n--- the settings Canary installed (project scope) ---');
    console.log(fs.readFileSync(path.join(wired, '.claude', 'settings.json'), 'utf8').slice(0, 900));
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
