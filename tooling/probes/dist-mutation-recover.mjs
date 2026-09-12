#!/usr/bin/env node
/**
 * RECOVER AN INTERRUPTED dist MUTATION — the sanctioned path, as a runnable probe.
 *
 * WHY: the heavy mutation batteries (`master-pass-mutations`, `p0-trust-boundary-mutations`) mutate
 * files in `dist/` IN PLACE and restore them at the end. If one is killed mid-run — which happened
 * here, by cancelling an oracle run — the journal and its sidecars survive, `tsc -b` may consider the
 * tree up to date, and every later probe silently reads MUTATED bytes. That is the exact hazard
 * `tooling/test-support/dist-mutation-guard.mjs` exists for, and its own message says to run a battery
 * or `tsc -b --force` before trusting dist.
 *
 * This probe is the third, explicit option: call the guard's recovery API, which restores the
 * recorded bytes EXACTLY from the sidecars and clears the journal, then report what it did. It never
 * deletes a journal it cannot explain.
 *
 * Usage: node tooling/probes/dist-mutation-recover.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GUARD = path.join(REPO, 'tooling', 'test-support', 'dist-mutation-guard.mjs');
const { isMutationInFlight, recoverInterruptedMutation } = await import(`file://${GUARD.replace(/\\/g, '/')}`);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failures += 1; console.log(`FAIL ${name}\n     ${String(e?.message ?? e).split('\n').join('\n     ')}`); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

const before = isMutationInFlight();
console.log(before
  ? 'a dist-mutation journal exists — a battery was interrupted; recovering from its sidecars'
  : 'no dist-mutation journal: the tree is not mid-mutation (nothing to recover)');

const note = recoverInterruptedMutation();
console.log(`recovery note: ${note === null ? '(none needed)' : note}`);

check('1. after recovery the tree is not reported as mid-mutation', () => {
  assert(!isMutationInFlight(), 'the journal is still present — recovery did not complete');
});

check('2. the outcome is HONEST: either repaired, or told to rebuild', () => {
  if (before) {
    assert(typeof note === 'string' && /repaired|tsc -b --force/i.test(note),
      `an interrupted mutation must report a repair or name the rebuild, got: ${String(note)}`);
  } else {
    assert(note === null, `nothing to recover should be a no-op, got: ${String(note)}`);
  }
});

console.log(`\n=== dist mutation recovery: ${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} ===`);
if (before) console.log('next: re-run the battery (or `npx tsc -b --force`) before trusting dist results');
process.exit(failures === 0 ? 0 : 1);
