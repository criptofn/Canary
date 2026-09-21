#!/usr/bin/env node
/**
 * v1.4 investigation -- REGRESSION GUARD for the failure that was otherwise
 * seen only on GitHub Actions Windows:
 *   `isolate: the trusted base identity is unresolvable (broken .git?)`
 *
 * ESTABLISHED ON THE RUNNER (probe v14-windows-identity-diag.mjs, run
 * 35554826434, job 106196301622) -- the cause was NOT missing git:
 *   gitExe()                          C:\Program Files\Git\cmd\git.exe   (resolved!)
 *   os.tmpdir()/fixture               C:\Users\RUNNER~1\AppData\Local\Temp\...
 *   fs.realpathSync(fixture)          C:\Users\RUNNER~1\AppData\Local\Temp\...
 *   git rev-parse --show-toplevel     C:/Users/runneradmin/AppData/Local/Temp/...
 *   candidateIdentity()               {"resolved":false,...}
 *
 * ONE DIRECTORY, TWO SPELLINGS: the 8.3 SHORT name (`RUNNER~1`) and the LONG
 * name (`runneradmin`). `containedRealPath` (apps/cli/src/onboarding.ts)
 * compared `fs.realpathSync(root)` with `fs.realpathSync(gitToplevel)` as
 * STRINGS, so the containment gate in `gitWithinRoot` saw two different
 * directories, refused the identity, and every candidate path failed.
 *
 * WHY IT IS INVISIBLE ON A NORMAL MACHINE: a path component only HAS a
 * distinct 8.3 short name when its long name does not fit 8.3. `Johannes` is
 * exactly 8 characters, `Desktop` is 7, `canary` is 6 -- so on a developer
 * workstation the short and long forms are byte-identical and the comparison
 * passes. The runner's `runneradmin` (11) does not fit, so it becomes
 * `RUNNER~1`. A real user's temp or repo path can do the same.
 *
 * This probe builds BOTH spellings of one directory locally and asks the
 * product about each: no network, no CI.
 *
 * CLASSIFICATION: PRODUCT DEFECT (path canonicalisation). It failed CLOSED --
 * no containment property was ever violated -- but it produced a false refusal
 * on a legitimate Windows environment.
 *
 * CONTROL (how to see the guard work): against a build WITHOUT the fix, the
 * short spelling reports resolved:false and this probe exits 1. That was
 * measured: long -> resolved:true, short -> resolved:false, and
 * `fs.realpathSync.native(short)` -> the LONG path, identical to the long
 * spelling's realpath.
 *
 * Usage: node tooling/probes/v14-shortname-repro.mjs
 * Exit: 0 all checks passed; 3 this host cannot exercise the condition
 *       (explicit host-bound SKIP -- never a pass); 1 a check failed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI_DIST = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'onboarding.js');

const info = (label, value) => console.log(`${label.padEnd(30)} ${value}`);
let failures = 0;
const check = (name, ok, detail = '') => {
  if (ok) console.log(`PASS ${name}${detail ? ` - ${detail}` : ''}`);
  else { failures += 1; console.log(`FAIL ${name}${detail ? ` - ${detail}` : ''}`); }
};

if (!fs.existsSync(CLI_DIST)) {
  console.error(`FAIL: no built CLI at ${CLI_DIST} - run \`npm run build\` first`);
  process.exit(1);
}
const { gitExe, gitWithinRoot, candidateIdentity, containedRealPath } = await import(`file://${CLI_DIST.replace(/\\/g, '/')}`);

/** The 8.3 short spelling of an EXISTING path.
 *
 *  MEASURED: `cmd /c for %I in ("<path>") do @echo %~sI` cannot be driven from
 *  spawnSync -- cmd re-parses the command line and the quotes collapse, giving
 *  garbage like `C:\"C:\Users\..."` (this probe crashed on exactly that before
 *  the fix). The FileSystemObject's `ShortPath` is the documented, quote-safe
 *  way to ask Windows for a path's 8.3 form. */
function shortPathOf(p) {
  const script = `$f=(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${p.replace(/'/g, "''")}'); $f.ShortPath`;
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  const out = (r.stdout ?? '').trim();
  return out.length > 0 ? out : null;
}

if (process.platform !== 'win32') {
  console.log('SKIP: 8.3 short names are a Windows filesystem property; this host cannot exercise it.');
  process.exit(3);
}

// A directory whose LAST component does not fit 8.3, so a distinct short name
// is guaranteed to exist (mirrors the runner's `runneradmin` -> `RUNNER~1`).
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-shortname-'));
const LONG_ROOT = path.join(BASE, 'a-long-directory-name');
fs.mkdirSync(LONG_ROOT, { recursive: true });

try {
  console.log('=== setup ===');
  info('gitExe()', String(gitExe()));
  if (gitExe() === null) { console.error('FAIL: git is not resolvable here - cannot run the guard'); process.exit(1); }
  const git = (args, cwd = LONG_ROOT) => spawnSync(gitExe(), ['-C', cwd, ...args], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'repro']); git(['config', 'user.email', 'repro@local']);
  fs.writeFileSync(path.join(LONG_ROOT, 'a.txt'), 'x\n');
  git(['add', '.']); git(['commit', '-m', 'fixture']);

  const SHORT_ROOT = shortPathOf(LONG_ROOT);
  info('LONG_ROOT', LONG_ROOT);
  info('SHORT_ROOT', String(SHORT_ROOT));
  if (SHORT_ROOT === null || SHORT_ROOT.toLowerCase() === LONG_ROOT.toLowerCase()) {
    console.log('\nSKIP: this filesystem/locale did not produce a distinct 8.3 short name for the');
    console.log('      fixture, so the condition cannot be exercised here. That is NOT a pass -');
    console.log('      it means this host cannot prove the guard either way.');
    process.exit(3);
  }

  console.log('\n=== the two spellings of ONE directory ===');
  info('fs.realpathSync(long)', fs.realpathSync(LONG_ROOT));
  info('fs.realpathSync(short)', fs.realpathSync(SHORT_ROOT));
  info('realpathSync.native(long)', fs.realpathSync.native(LONG_ROOT));
  info('realpathSync.native(short)', fs.realpathSync.native(SHORT_ROOT));
  info('git toplevel (via long)', (git(['rev-parse', '--show-toplevel']).stdout ?? '').trim());
  info('git toplevel (via short)', (git(['rev-parse', '--show-toplevel'], SHORT_ROOT).stdout ?? '').trim());

  console.log('\n=== the product, asked about each spelling ===');
  const longId = candidateIdentity(LONG_ROOT);
  const shortId = candidateIdentity(SHORT_ROOT);
  info('candidateIdentity(long)', JSON.stringify(longId));
  info('candidateIdentity(short)', JSON.stringify(shortId));
  info('gitWithinRoot(long, HEAD)', JSON.stringify(gitWithinRoot(LONG_ROOT, ['rev-parse', 'HEAD'])));
  info('gitWithinRoot(short, HEAD)', JSON.stringify(gitWithinRoot(SHORT_ROOT, ['rev-parse', 'HEAD'])));

  console.log('\n=== THE REGRESSION GUARD ===');
  check('the LONG spelling resolves (git and containment agree)', longId.resolved === true, JSON.stringify(longId));
  check('the SHORT spelling ALSO resolves - one directory, two spellings, one identity',
    shortId.resolved === true, JSON.stringify(shortId));
  check('both spellings produce the SAME head (not merely "both resolved")',
    longId.head !== null && longId.head === shortId.head, `long=${String(longId.head)} short=${String(shortId.head)}`);
  check('both spellings canonicalise to the SAME directory through realpathSync.native',
    fs.realpathSync.native(LONG_ROOT).toLowerCase() === fs.realpathSync.native(SHORT_ROOT).toLowerCase());
  check('containment is still enforced for either spelling',
    containedRealPath(LONG_ROOT, LONG_ROOT) !== null && containedRealPath(SHORT_ROOT, SHORT_ROOT) !== null);

  console.log('\n=== ROOT CAUSE (fixed) ===');
  console.log('containedRealPath compared `fs.realpathSync` STRINGS. On a host whose path has a');
  console.log('distinct 8.3 short name, the JS realpath keeps the SHORT spelling while git prints');
  console.log('the LONG one, so the containment gate concluded "not this repo" and refused an');
  console.log('identity that was never in doubt. git resolution was NOT involved: gitExe()');
  console.log('resolved fine on the runner. The fix canonicalises through');
  console.log('`fs.realpathSync.native`, which expands the short form.');
} finally {
  try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* OS temp */ }
}

console.log('');
if (failures > 0) { console.log(`SHORTNAME-REPRO: FAIL (${failures} check(s) failed)`); process.exit(1); }
console.log('SHORTNAME-REPRO: PASS - one directory, two spellings, one identity (the fix holds).');
process.exit(0);
