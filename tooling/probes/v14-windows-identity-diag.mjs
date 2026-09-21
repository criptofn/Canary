#!/usr/bin/env node
/**
 * v1.4 investigation — WHY does `candidateIdentity()` return `resolved: false`
 * on GitHub Actions Windows and nowhere else?
 *
 * THE SYMPTOM (measured, run 35530519454, job 106130188538): on the
 * `windows-latest` core leg, ~119 tests fail with
 *   `isolate: the trusted base identity is unresolvable (broken .git?)`
 * while the byte-identical commit is GREEN on the ubuntu leg and GREEN on a
 * real Windows workstation. That asymmetry is the whole question.
 *
 * WHAT THE CODE DOES (`apps/cli/src/onboarding.ts`):
 *   candidateIdentity(root)
 *     -> gitWithinRoot(root, ['rev-parse', 'HEAD'])
 *        -> gitCommand(root, args)
 *           -> gitExe(): the FIRST EXISTING entry of a FIXED LITERAL list —
 *              never PATH, deliberately, so no shim can become git:
 *                C:\Program Files\Git\cmd\git.exe
 *                C:\Program Files (x86)\Git\cmd\git.exe
 *                C:\Windows\System32\git.exe
 *                <NODE_DIR>\git.exe
 *           -> null when none exists  =>  gitWithinRoot null  =>  resolved:false
 *     -> and a containment gate: `rev-parse --show-toplevel` must resolve to
 *        `root` ITSELF (compared through containedRealPath, case-insensitively
 *        on win32), otherwise the identity is refused as a misattribution.
 *
 * So there are exactly TWO independent ways to reach the symptom, and this
 * probe separates them instead of assuming either:
 *   (A) RESOLUTION:  no candidate git exists on this host  -> gitExe() === null
 *   (B) CONTAINMENT: git exists, but the toplevel/realpath comparison fails
 *                    (a short 8.3 name, a junction, a case or separator
 *                    difference between os.tmpdir() and what git prints)
 *
 * It prints the facts and exits 0 either way: the ANSWER is the data, not a
 * verdict. Run it on any host; run it in CI to compare hosts.
 *
 * Usage: node tooling/probes/v14-windows-identity-diag.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const CLI_DIST = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'onboarding.js');

const info = (label, value) => console.log(`${label.padEnd(34)} ${value}`);
const section = (t) => console.log(`\n=== ${t} ===`);

section('host');
info('platform', `${process.platform} ${process.arch}`);
info('node', process.version);
info('execPath', process.execPath);
const NODE_DIR = path.dirname(process.execPath);
info('NODE_DIR', NODE_DIR);
info('os.tmpdir()', os.tmpdir());
info('repo', REPO);

// The literal list mirrors `gitCandidates()` in apps/cli/src/onboarding.ts (not exported).
const WIN_CANDIDATES = [
  'C:\\Program Files\\Git\\cmd\\git.exe',
  'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
  'C:\\Windows\\System32\\git.exe',
  path.join(NODE_DIR, 'git.exe'),
];
const POSIX_CANDIDATES = ['/usr/bin/git', '/usr/local/bin/git', '/bin/git'];
const CANDIDATES = process.platform === 'win32' ? WIN_CANDIDATES : POSIX_CANDIDATES;

section('(A) RESOLUTION — does any candidate git exist?');
for (const c of CANDIDATES) info(fs.existsSync(c) ? 'EXISTS' : 'absent', c);
// The neighbouring path actions/checkout itself uses (from its own log lines),
// which is NOT in the candidate list. Whether it also has cmd\git.exe is the
// question this probe answers on the runner.
if (process.platform === 'win32') {
  for (const extra of [
    'C:\\Program Files\\Git\\bin\\git.exe',
    'C:\\Program Files\\Git\\mingw64\\bin\\git.exe',
    'C:\\Program Files\\Git\\cmd\\git.exe',
  ]) info(fs.existsSync(extra) ? 'EXISTS' : 'absent', extra);
}

section('product view');
if (!fs.existsSync(CLI_DIST)) {
  console.log(`FAIL: no built CLI at ${CLI_DIST} — run \`npm run build\` first`);
  process.exit(0);
}
const mod = await import(`file://${CLI_DIST.replace(/\\/g, '/')}`);
const { gitExe, gitWithinRoot, candidateIdentity, trustedDirs } = mod;
info('gitExe()', String(gitExe()));
info('trustedDirs()', JSON.stringify(trustedDirs()));

section('(B) CONTAINMENT — a real fixture repo, resolved by the product');
const FIXTURE = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-identity-diag-'));
try {
  const { spawnSync } = await import('node:child_process');
  const exe = gitExe();
  const git = (args, cwd = FIXTURE) => exe === null
    ? { status: null, stdout: '', stderr: 'gitExe() === null' }
    : spawnSync(exe, ['-C', cwd, ...args], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'diag']);
  git(['config', 'user.email', 'diag@local']);
  fs.writeFileSync(path.join(FIXTURE, 'a.txt'), 'hello\n');
  git(['add', '.']);
  git(['commit', '-m', 'fixture']);

  info('fixture', FIXTURE);
  info('fs.realpathSync(fixture)', (() => { try { return fs.realpathSync(FIXTURE); } catch (e) { return `THREW ${String(e.message)}`; } })());
  const top = git(['rev-parse', '--show-toplevel']);
  info('git rev-parse --show-toplevel', JSON.stringify((top.stdout ?? '').trim()));
  const topReal = (() => { try { return fs.realpathSync((top.stdout ?? '').trim()); } catch (e) { return `THREW ${String(e.message)}`; } })();
  info('realpath(git toplevel)', String(topReal));
  info('rev-parse HEAD', JSON.stringify((git(['rev-parse', 'HEAD']).stdout ?? '').trim()));

  // The product's own answers — the thing the failing tests consume.
  info('gitWithinRoot(HEAD)', JSON.stringify(gitWithinRoot(FIXTURE, ['rev-parse', 'HEAD'])));
  info('candidateIdentity()', JSON.stringify(candidateIdentity(FIXTURE)));

  section('VERDICT (data, not opinion)');
  const resolved = candidateIdentity(FIXTURE).resolved;
  if (resolved) {
    console.log('candidateIdentity RESOLVED here — this host does not show the symptom.');
  } else if (exe === null) {
    console.log('candidateIdentity UNRESOLVED because gitExe() === null:');
    console.log('  (A) RESOLUTION failure — no candidate git exists on this host.');
  } else {
    console.log('candidateIdentity UNRESOLVED although gitExe() found git:');
    console.log('  (B) CONTAINMENT failure — compare the two realpath lines above.');
  }
} finally {
  try { fs.rmSync(FIXTURE, { recursive: true, force: true }); } catch { /* OS temp */ }
}
process.exit(0);
