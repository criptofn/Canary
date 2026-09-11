/**
 * In-place `dist` mutation is a real hazard, and this was MEASURED, not imagined.
 *
 * The mutation batteries (`m7`/`m8`/`m9`/`m10`, `master-pass`) work by editing the
 * BUILT `apps/cli/dist/**` bytes, running the owning probe, and restoring. That
 * is legitimate — dist is a gitignored artifact. The failure mode is not:
 *
 *   1. a battery is KILLED mid-mutation (a timeout, a CI cancel, a closed
 *      terminal). `finally` never runs, so `dist` keeps a MUTATED file;
 *   2. the mutated file has a fresh mtime and `.tsbuildinfo` already records the
 *      source as compiled, so **`tsc -b` considers the project up to date and
 *      does NOT repair it** — a subsequent `npm test` or probe then judges
 *      mutated product code and reports a defect that does not exist.
 *
 * That is not hypothetical: it happened in this repository. A killed
 * `m9-mutation-battery` left `candidate.js` holding mutation #4 (the authority
 * list minus `recordPath(root, name)`), and the NEXT battery run reported
 * `12/15 mutations caught` with three "anchor drifted: occurs 0x" lines and a
 * failing post-battery sanity check — all of it an artifact of the stale bytes.
 * Rebuilding correctly gave 15/15.
 *
 * WHAT THIS GUARD DOES ABOUT IT: it makes an in-flight mutation DISCOVERABLE and
 * RECOVERABLE rather than silent.
 *   - `beginDistMutation(files)` first RECOVERS any mutation a previous run left
 *     behind (from a byte-identical sidecar copy), then writes a journal naming
 *     every file it is about to touch.
 *   - `endDistMutation()` verifies the files are back and clears the journal.
 *   - `recoverInterruptedMutation()` can be called by anything that reads dist
 *     (the productization oracle does) so a stale tree is repaired before it is
 *     trusted.
 * A journal without a live owning process means "dist is not trustworthy" — the
 * one fact that was previously invisible.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = path.join(REPO, '.canary-runs', 'dist-mutation-guard');
const JOURNAL = path.join(DIR, 'journal.json');

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** True when a mutation run has not yet been closed out. */
export function isMutationInFlight() {
  return fs.existsSync(JOURNAL);
}

/**
 * Repair a `dist` left mutated by an interrupted battery.
 * Returns a human-readable note when it did something, else null. Never throws:
 * a guard that breaks the build is worse than the hazard it guards.
 */
export function recoverInterruptedMutation() {
  let journal;
  try {
    if (!fs.existsSync(JOURNAL)) return null;
    journal = JSON.parse(fs.readFileSync(JOURNAL, 'utf8'));
  } catch {
    try { fs.rmSync(JOURNAL, { force: true }); } catch { /* best effort */ }
    return 'a dist-mutation journal existed but was unreadable — removed it; run `npx tsc -b --force` if anything looks wrong';
  }
  if (!Array.isArray(journal?.entries)) return null;
  const repaired = [];
  const unrecoverable = [];
  for (const e of journal.entries) {
    try {
      const pristine = fs.readFileSync(e.sidecar);
      if (sha256(pristine) !== e.sha256) { unrecoverable.push(e.file); continue; }
      const now = fs.existsSync(e.file) ? fs.readFileSync(e.file) : null;
      if (now === null || sha256(now) !== e.sha256) {
        fs.writeFileSync(e.file, pristine);
        repaired.push(path.relative(REPO, e.file));
      }
    } catch {
      unrecoverable.push(e.file);
    }
  }
  for (const e of journal.entries) { try { fs.rmSync(e.sidecar, { force: true }); } catch { /* best effort */ } }
  try { fs.rmSync(JOURNAL, { force: true }); } catch { /* best effort */ }
  if (unrecoverable.length > 0) {
    return `an interrupted dist mutation could NOT be repaired for ${unrecoverable.join(', ')} (missing sidecar) — `
      + 'run `npx tsc -b --force` before trusting any result';
  }
  if (repaired.length === 0) return null;
  return `repaired ${repaired.length} file(s) left mutated by an interrupted battery: ${repaired.join(', ')} — `
    + 'the previous run was killed mid-mutation; results from before this repair are suspect';
}

/**
 * Take custody of the given `dist` files for an in-place mutation.
 * Recovers a previous interrupted run first, so a battery can never start from a
 * tree it cannot trust.
 */
export function beginDistMutation(files) {
  const recovered = recoverInterruptedMutation();
  if (recovered !== null) console.log(`NOTE: ${recovered}`);
  fs.mkdirSync(DIR, { recursive: true });
  const entries = files.map((file, i) => {
    const bytes = fs.readFileSync(file);
    const sidecar = path.join(DIR, `${i}-${path.basename(file)}.pristine`);
    fs.writeFileSync(sidecar, bytes);
    return { file, sidecar, sha256: sha256(bytes) };
  });
  fs.writeFileSync(JOURNAL, JSON.stringify({
    schema: 'canary-dist-mutation/1', pid: process.pid, at: new Date().toISOString(), entries,
  }, null, 2) + '\n');
  return { recovered, entries };
}

/**
 * Release custody: verify every file came back, then clear the journal.
 * Returns the list of files that did NOT come back (empty means clean).
 */
export function endDistMutation(entries) {
  const dirty = [];
  for (const e of entries ?? []) {
    try {
      const now = fs.readFileSync(e.file);
      if (sha256(now) !== e.sha256) {
        // The sidecar is the authority — restore rather than merely complain.
        fs.writeFileSync(e.file, fs.readFileSync(e.sidecar));
        if (sha256(fs.readFileSync(e.file)) !== e.sha256) dirty.push(e.file);
      }
    } catch { dirty.push(e.file); }
  }
  for (const e of entries ?? []) { try { fs.rmSync(e.sidecar, { force: true }); } catch { /* best effort */ } }
  try { fs.rmSync(JOURNAL, { force: true }); } catch { /* best effort */ }
  return dirty;
}

/** A one-line status for a caller that is about to read `dist`. */
export function distTrustStatus() {
  return isMutationInFlight()
    ? 'an in-place dist mutation is (or was) in flight — dist may not be the compiled source; recovery runs on the next battery start'
    : null;
}
