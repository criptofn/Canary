#!/usr/bin/env node
/**
 * v1.4 — CAN STALE COMPILED BYTES SURVIVE INTO THE TESTED ARTIFACT?
 *
 * WHY THIS EXISTS (MEASURED, and it invalidated real measurements). `tsc -b`
 * reports exit 0 WITHOUT re-emitting a file whose output was changed after
 * compilation. MEASURED during the v1.4 Windows investigation: after the
 * mutation batteries rewrote `dist` and restored it, `dist/src/candidate.js`
 * did NOT contain a source change that was already committed, while
 * `npm run build` printed nothing and exited 0. One measurement of mine then
 * "passed" against reverted bytes and another failed against them. A build
 * command's exit code is NOT evidence that `dist` corresponds to the source —
 * this repository already learned that lesson once (the v1.2 dist tripwire) and
 * learned it again here, because the tripwire only looks for mutation-battery
 * MARKERS (`if (false) {` and friends). It cannot see a plain stale file.
 *
 * WHAT THIS PROBE DOES — the three steps the release process requires:
 *   1. force a fresh build and record the hash of EVERY emitted file;
 *   2. DELIBERATELY make `dist` stale (write a sentinel into a compiled file);
 *   3. run the release verification build path and prove the stale bytes cannot
 *      survive it — the sentinel is gone and the whole tree hashes back to the
 *      fresh baseline.
 *
 * A CONTROL step records what the INCREMENTAL path (`tsc -b`) does with the same
 * sentinel. That is reported, not asserted: it is evidence about the trap, and
 * the trap is the reason the release path uses `--force`.
 *
 * Deterministic, self-cleaning (it restores a forced build at the end), exit 0
 * only when the release path is proven to defeat staleness.
 *
 * Usage: node tooling/probes/v14-dist-freshness.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let failures = 0;
const check = (name, ok, detail = '') => {
  if (ok) console.log(`PASS ${name}${detail ? ` - ${detail}` : ''}`);
  else { failures += 1; console.log(`FAIL ${name}${detail ? ` - ${detail}` : ''}`); }
};
const info = (label, value) => console.log(`     ${label.padEnd(34)} ${value}`);

/** Every emitted .js/.d.ts under every `dist` directory, as repo-relative path -> sha256.
 *  Walks generically (any directory named `dist`, bounded depth) so a new package cannot be
 *  silently excluded from the freshness comparison. */
function hashDist() {
  const out = new Map();
  const hashFile = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  const walkTree = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walkTree(p); continue; }
      if (!/\.(?:js|d\.ts)$/.test(e.name)) continue;
      out.set(path.relative(REPO, p).replace(/\\/g, '/'), hashFile(p));
    }
  };
  const findDists = (dir, depth) => {
    if (depth > 3) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.name === 'dist') { walkTree(p); continue; }
      findDists(p, depth + 1);
    }
  };
  for (const top of ['apps', 'packages']) findDists(path.join(REPO, top), 0);
  return out;
}

const tsc = (args) => spawnSync(process.execPath, [path.join(REPO, 'node_modules', 'typescript', 'bin', 'tsc'), ...args], { cwd: REPO, encoding: 'utf8', timeout: 900_000, windowsHide: true });

console.log('=== 1. fresh build (the release path: tsc -b --force) ===');
const fresh = tsc(['-b', '--force']);
check('the forced build succeeds', fresh.status === 0, `exit ${fresh.status}`);
if (fresh.status !== 0) { console.log((fresh.stdout ?? '') + (fresh.stderr ?? '')); process.exit(1); }
const baseline = hashDist();
check('the build emitted compiled files', baseline.size > 50, `${baseline.size} file(s)`);

// Pick a real emitted file that corresponds to a real source file, so the
// sentinel is injected into something the tests genuinely execute.
const target = 'apps/cli/dist/src/candidate.js';
check('the probe picked a file that exists', baseline.has(target), target);
if (!baseline.has(target)) process.exit(1);

console.log('\n=== 2. deliberately make dist STALE ===');
const SENTINEL = '/* v14-dist-freshness SENTINEL: this file no longer matches its source */';
fs.appendFileSync(path.join(REPO, target), `\n${SENTINEL}\n`);
const staleHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO, target))).digest('hex');
check('the sentinel is present (dist is now stale)', fs.readFileSync(path.join(REPO, target), 'utf8').includes(SENTINEL));
info('stale hash differs from fresh', String(staleHash !== baseline.get(target)));

console.log('\n=== 3. can the stale bytes survive the RELEASE verification path? ===');
const forced = tsc(['-b', '--force']);
check('the release build path succeeds', forced.status === 0, `exit ${forced.status}`);
const nowText = fs.readFileSync(path.join(REPO, target), 'utf8');
check('the sentinel is GONE after the release build path', !nowText.includes(SENTINEL),
  'a stale compiled file cannot be tested after `tsc -b --force`');
const after = hashDist();
const drifted = [...baseline.entries()].filter(([f, h]) => after.get(f) !== h).map(([f]) => f);
check('every emitted file hashes back to the fresh baseline', drifted.length === 0,
  drifted.length === 0 ? `${after.size} file(s) identical` : `${drifted.length} drifted: ${drifted.slice(0, 5).join(', ')}`);

console.log('\n=== CONTROL: what the INCREMENTAL path does with the same sentinel ===');
console.log('     (reported, not asserted: this is the trap that makes --force necessary)');
fs.appendFileSync(path.join(REPO, target), `\n${SENTINEL}\n`);
const incremental = tsc(['-b']);
const survived = fs.readFileSync(path.join(REPO, target), 'utf8').includes(SENTINEL);
info('tsc -b exit', String(incremental.status));
info('sentinel survived `tsc -b`', survived ? 'YES - the trap is real on this project' : 'no - incremental rebuilt anyway');
if (survived) {
  console.log('     => `npm run build` can exit 0 while dist still holds bytes that do not match source.');
  console.log('     => that is why `npm test` now builds with --force and why verify:productization forces first.');
}

console.log('\n=== restore ===');
const restored = tsc(['-b', '--force']);
check('dist is left freshly built for whatever runs next', restored.status === 0 && !fs.readFileSync(path.join(REPO, target), 'utf8').includes(SENTINEL));

console.log('');
if (failures > 0) { console.log(`DIST-FRESHNESS: FAIL (${failures} check(s) failed)`); process.exit(1); }
console.log('DIST-FRESHNESS: PASS - stale compiled bytes cannot survive the release build path.');
process.exit(0);
