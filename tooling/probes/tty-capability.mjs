#!/usr/bin/env node
/**
 * DIAGNOSTIC (not a gate): what real-terminal facility does THIS host offer?
 *
 * `pre10-acceptance` (and `f3-acceptance-growth`) drive the human acceptance act
 * through a REAL pty via util-linux `script -qec`. That tool does not exist on
 * Windows, so those probes were reported host-bound. This probe measures the
 * alternatives instead of assuming there are none:
 *
 *   - plain spawnSync                              (the agent posture: no tty)
 *   - winpty.exe, shipped with Git for Windows     (a real Windows console)
 *   - script(1), util-linux                        (the POSIX path)
 *   - wsl.exe <distro> script(1)                   (a real Linux pty, if present)
 *
 * It runs `tty-probe.mjs` under each and prints `TTY stdin=… stdout=…` verbatim,
 * plus whether an input line actually round-trips (`READ "…"`). Exits 0 always:
 * the answer is data, not a verdict. Pair with `node --version`, `git --version`.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const FX = path.join(REPO, 'tooling', 'test-support', 'fixtures', 'tty-probe.mjs');
if (!fs.existsSync(FX)) { console.error(`missing ${FX}`); process.exit(2); }

function firstExisting(cands) { return cands.find((c) => { try { return fs.existsSync(c); } catch { return false; } }) ?? null; }
function onPath(name) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'sh',
    process.platform === 'win32' ? [name] : ['-c', `command -v ${name}`],
    { encoding: 'utf8', timeout: 15_000 });
  return (r.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] ?? null;
}

const WINPTY = process.platform === 'win32'
  ? (onPath('winpty') ?? firstExisting([
    'C:\\Program Files\\Git\\usr\\bin\\winpty.exe',
    'C:\\Program Files (x86)\\Git\\usr\\bin\\winpty.exe',
  ]))
  : null;
const SCRIPT = onPath('script');
const WSL = process.platform === 'win32' ? firstExisting(['C:\\WINDOWS\\system32\\wsl.exe']) : null;

function banner(t) { console.log(`\n${'='.repeat(70)}\n${t}\n${'='.repeat(70)}`); }
function run(label, cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 60_000, input: 'canary-typed\n', ...opts });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  console.log(`\n--- ${label} ---`);
  console.log(`cmd: ${cmd} ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`);
  console.log(`status=${r.status} signal=${r.signal} error=${r.error ? `${r.error.code ?? ''} ${r.error.message}` : 'none'}`);
  for (const line of out.split(/\r?\n/)) if (line.trim()) console.log(`| ${line}`);
  return { out, status: r.status };
}

console.log(`node: ${process.execPath}`);
console.log(`platform: ${process.platform} ${process.arch}`);
console.log(`winpty: ${String(WINPTY)}`);
console.log(`script: ${String(SCRIPT)}`);
console.log(`wsl:    ${String(WSL)}`);

banner('1. plain spawn (no terminal expected)');
run('plain node tty-probe.mjs', process.execPath, [FX]);

if (WINPTY !== null) {
  banner('2. winpty (Git for Windows console bridge)');
  run('winpty node tty-probe.mjs', WINPTY, [process.execPath, FX], { cwd: REPO });
  // winpty needs a CONSOLE to size its pty. Spawning it detached on Windows
  // gives the child its own console window (node docs, `options.detached`), so
  // winpty stops asserting on cols/rows and `-Xallow-non-tty` can take effect.
  banner('2b. winpty, detached (own console) + allow-non-tty');
  run('winpty -Xallow-non-tty (detached) node tty-probe.mjs', WINPTY,
    ['-Xallow-non-tty', process.execPath, FX], { cwd: REPO, detached: true });
  banner('2c. winpty, new console, -Xallow-non-tty (spawn collect)');
  {
    const r = spawnSync(WINPTY, ['-Xallow-non-tty', process.execPath, FX],
      { cwd: REPO, encoding: 'utf8', timeout: 60_000, input: 'canary-typed\n', detached: true, windowsHide: false, shell: false });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
    console.log(`status=${r.status} error=${r.error ? r.error.code : 'none'}`);
    for (const line of out.split(/\r?\n/)) if (line.trim()) console.log(`| ${line}`);
  }
} else {
  banner('2. winpty');
  console.log('(winpty not found)');
}

if (SCRIPT !== null) {
  banner('3. util-linux script');
  run('script -qec', SCRIPT, ['-qec', `${process.execPath} ${FX}`, '/dev/null']);
} else {
  banner('3. util-linux script');
  console.log('(script not found)');
}

if (WSL !== null) {
  banner('4. wsl (Linux pty, if a distro is present)');
  run('wsl script -qec', WSL, ['-e', 'script', '-qec', 'node --version', '/dev/null']);
} else {
  banner('4. wsl');
  console.log('(wsl not found)');
}

banner('SUMMARY');
console.log('A line "TTY stdin=true stdout=true" identifies a facility that gives the child a');
console.log('real terminal — the precondition `canary accept` asserts, and the reason');
console.log('pre10-acceptance needed util-linux `script`.');
