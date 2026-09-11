#!/usr/bin/env node
/**
 * DIAGNOSTIC + GATE: prove the dist-mutation guard repairs the hazard it exists
 * for, by SIMULATING the exact interruption that caused it.
 *
 * The hazard is not theoretical and is recorded in the guard's header: a killed
 * battery left `dist/src/candidate.js` holding a mutation, `tsc -b` reported the
 * project up to date, and the next battery run reported three phantom "anchor
 * drifted" failures plus a corrupt-dist sanity failure. Rebuilding gave 15/15.
 *
 * This probe reproduces that shape on a COPY of a real dist file — it never
 * mutates the live tree — and asserts:
 *   1. a fresh `beginDistMutation` recovers a journal left by an "interrupted"
 *      run, restoring bytes exactly;
 *   2. the journal is what makes the staleness DISCOVERABLE (`isMutationInFlight`);
 *   3. an unrecoverable journal (sidecar missing) is reported honestly and told
 *      to rebuild, instead of silently trusting the tree;
 *   4. `endDistMutation` restores and clears.
 *
 * It also checks the live tree is not currently mid-mutation, which is the fact a
 * caller must know before reading dist.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GUARD = path.join(REPO, 'tooling', 'test-support', 'dist-mutation-guard.mjs');
const { beginDistMutation, endDistMutation, isMutationInFlight, recoverInterruptedMutation } = await import(`file://${GUARD.replace(/\\/g, '/')}`);

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}\n     ${String(e?.message ?? e).split('\n').join('\n     ')}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// The guard's journal/sidecars live in the repo, so this probe must leave them
// exactly as it found them.
const DIR = path.join(REPO, '.canary-runs', 'dist-mutation-guard');
const preexisting = fs.existsSync(DIR);
assert(!preexisting || fs.readdirSync(DIR).length === 0,
  'a dist-mutation journal already exists — a battery was interrupted; run a battery (or `npx tsc -b --force`) before this probe');

// A temp "dist" file we may abuse freely, plus a pristine copy to compare to.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-dist-guard-'));
const target = path.join(TMP, 'candidate.js');
const pristineBytes = Buffer.from('const authority = [configPath(root), settings, recordPath(root, name)];\n');
fs.writeFileSync(target, pristineBytes);

check('a healthy tree is reportable as not-mid-mutation', () => {
  assert(!isMutationInFlight(), 'no journal should exist before any mutation');
  assert(recoverInterruptedMutation() === null, 'recovery on a clean tree must be a no-op');
});

check('an INTERRUPTED mutation is discovered and byte-exactly repaired', () => {
  // begin, then simulate a kill: overwrite the file and never call end.
  const custody = beginDistMutation([target]);
  assert(isMutationInFlight(), 'the journal must make an in-flight mutation discoverable');
  fs.writeFileSync(target, 'const authority = [configPath(root), settings];\n'); // the mutant
  assert(!fs.readFileSync(target).equals(pristineBytes), 'the mutant must be in place');

  // A later run (or the oracle) recovers. This is the exact step that did NOT
  // exist when the stale tree produced three phantom failures.
  const note = recoverInterruptedMutation();
  assert(typeof note === 'string' && /repaired/i.test(note), `recovery must report what it repaired, got: ${String(note)}`);
  assert(fs.readFileSync(target).equals(pristineBytes), 'bytes must be restored EXACTLY, not merely rewritten');
  assert(!isMutationInFlight(), 'the journal must be cleared once repaired');
  return custody;
});

check('a journal whose sidecar is gone is reported honestly, not silently trusted', () => {
  const custody = beginDistMutation([target]);
  fs.writeFileSync(target, 'const authority = [];\n');
  fs.rmSync(custody.entries[0].sidecar, { force: true }); // sidecar lost (e.g. scratch wiped)
  const note = recoverInterruptedMutation();
  assert(typeof note === 'string' && /tsc -b --force/.test(note),
    `an unrecoverable journal must tell the operator to rebuild, got: ${String(note)}`);
  fs.writeFileSync(target, pristineBytes); // put it back by hand for the next case
});

check('endDistMutation restores and clears on the normal path', () => {
  const custody = beginDistMutation([target]);
  fs.writeFileSync(target, 'const authority = [mutant];\n');
  const dirty = endDistMutation(custody.entries);
  assert(dirty.length === 0, `a clean restore must report no dirty files, got ${JSON.stringify(dirty)}`);
  assert(fs.readFileSync(target).equals(pristineBytes), 'endDistMutation must restore the pristine bytes');
  assert(!isMutationInFlight(), 'endDistMutation must clear the journal');
});

check('the live dist tree is not currently mid-mutation', () => {
  assert(!isMutationInFlight(),
    'a dist-mutation journal exists, so the live dist may be mutated — recover it (start any battery) or run `npx tsc -b --force` before trusting results');
});

fs.rmSync(TMP, { recursive: true, force: true });
try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* best effort */ }
console.log(`\n=== dist-mutation-guard: ${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} ===`);
process.exit(failures === 0 ? 0 : 1);
