#!/usr/bin/env node
/**
 * DIST TRIPWIRE — is the compiled artifact MUTATED?
 *
 * WHY THIS EXISTS (v1.2, and it cost hours):
 *
 * `tooling/probes/master-pass-mutations.mjs` and its siblings work by MUTATING the compiled CLI
 * under `apps/cli/dist/src`, running the probe that owns each door, then restoring the bytes from a
 * sidecar copy. That is a legitimate technique. The hazard is what happens when one of those runs is
 * INTERRUPTED: the mutation survives in the artifact that every other probe and test consumes.
 *
 * MEASURED, this repository, 2026-09-14: `apps/cli/dist/src/candidate.js` was left containing
 *
 *     if (false) {
 *
 * where the non-TTY acceptance gate belongs — the exact disabled form the battery writes for its
 * "TTY gate removable" case. The SOURCE was correct the whole time. Against that artifact,
 * `pre10-acceptance` case C failed ("refusal names the boundary") while passing standalone on the
 * byte-identical tree, and the `master-pass` battery then aborted at its own `acceptance` baseline.
 * Several rounds were spent reading source code to explain behaviour the source never had.
 *
 * WHAT THIS PROBE IS: a cheap, deterministic precondition. It does NOT re-run the gates; it only
 * answers "may I trust the artifact in front of me?". Run it before believing a probe result, and it
 * is wired into the productization chain so a mutated artifact is caught before anything is inferred
 * from it.
 *
 * Usage: node tooling/probes/v12-dist-tripwire.mjs
 * Exit:  0 when the artifact is unmutated; 1 when a mutation marker is present (with the fix printed).
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const DIST_SRC = path.join(REPO, 'apps', 'cli', 'dist', 'src');

/**
 * The mutation shapes the batteries write, as literal source fragments. Kept deliberately small and
 * exact: this must not fire on ordinary code, because a tripwire that cries wolf gets ignored.
 *
 * `if (false) {` is the M10 "TTY gate removable" mutation. The others are the anchors declared in
 * master-pass-mutations.mjs that produce a permanently-disabled guard rather than a restored one.
 */
const MARKERS = [
  { text: 'if (false) {', what: 'a guard disabled with `if (false)` (master-pass M10: "the TTY gate removable")' },
  { text: 'const drift = null;', what: 'drift detection disabled (master-pass M5: "status becomes drift-blind")' },
  { text: 'const seen = false;', what: 'config-ownership memo poisoned (master-pass M6)' },
  { text: "gitExeCache = 'git';", what: 'git resolved as a bare name on PATH (master-pass M9)' },
];

if (!fs.existsSync(DIST_SRC)) {
  console.log(`SKIP  dist-tripwire  no compiled artifact at ${DIST_SRC} — build first (npm run build)`);
  process.exit(0);
}

const files = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) files.push(p);
  }
};
walk(DIST_SRC);

const hits = [];
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  for (const marker of MARKERS) {
    if (text.includes(marker.text)) {
      hits.push({ file: path.relative(REPO, file), marker: marker.text, what: marker.what });
    }
  }
}

if (hits.length === 0) {
  console.log(`PASS  dist-tripwire  ${files.length} compiled file(s) checked; no mutation marker present — the artifact matches a real build`);
  process.exit(0);
}

console.log(`FAIL  dist-tripwire  the compiled artifact is MUTATED; every probe result against it is untrustworthy.`);
for (const h of hits) {
  console.log(`      ${h.file} contains ${JSON.stringify(h.marker)} — ${h.what}`);
}
console.log('');
console.log('  This is almost always an INTERRUPTED mutation battery, not a product defect.');
console.log('  Repair: npx tsc -b apps/cli --force    (or remove apps/cli/dist and rebuild)');
console.log('  Then re-run whatever you were measuring. Do NOT read the previous result as a product finding.');
process.exit(1);
