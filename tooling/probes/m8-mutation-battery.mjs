#!/usr/bin/env node
/**
 * M8 mutation battery — deterministic kill checks for the promotion gates.
 *
 * Same convention as m7-mutation-battery.mjs: mutate the BUILT dist bytes (a
 * gitignored artifact), run the ONE check that owns that gate (real-git M8
 * probe, or the owning node --test), require IT to fail, restore and
 * byte-compare. A gate whose removal breaks nothing is a gate no check
 * actually pins. Exit 0 only when every mutation was caught. NO PROOF, NO DONE.
 *
 * 10 mutations, each anchored to a compiled substring whose occurrence count
 * is asserted before mutating (anchor drift fails loudly, never silently
 * "passes" against bytes that were never changed). The `if (id.dirty)` anchor
 * is two-line because that text occurs twice in dist — pinning the sandwich
 * arm means pinning it TO `return refuse(`.
 *
 * Deliberately NOT mutated — no deterministic trigger in this layer, recorded
 * honestly rather than oversold:
 *  - the post-proof arm (pHead/pTree re-derivation): disabling it changes no
 *    observable behavior on healthy git — its EXISTENCE is exercised from the
 *    other side by mutation '--ff-only' (the non-ff merge must trip it).
 *  - the fail-closed `!rec || H === null` arm: unreachable unless verify
 *    returns PASS without an identity.
 *  - the tree-pin null arm and the two `!resolved` arms: each requires git to
 *    answer two back-to-back questions about the SAME repo inconsistently.
 *  - the identity-sandwich window itself: an edit-revert strictly INSIDE one
 *    plan run cannot be witnessed by a single-threaded sandwich; the fresh
 *    bundle's captured step outputs are the human-visible record (M19/persist).
 *  - refusal wording and short(): presentation, not authority.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
// In-place dist mutation must be RECOVERABLE: a killed battery leaves dist
// mutated and `tsc -b` will not repair it (see the guard's header for the measured
// incident this closes).
import { beginDistMutation, endDistMutation } from '../test-support/dist-mutation-guard.mjs';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const CAND = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'candidate.js');
const ONB = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'onboarding.js');
const M8TEST = path.join(REPO, 'apps', 'cli', 'dist', 'test', 'm8-promotion.test.js');
const PROBE = path.join(REPO, 'tooling', 'probes', 'm8-promotion.mjs');

let failures = 0;
function report(verdict, msg) { console.log(`${verdict} ${msg}`); if (verdict === 'FAIL') failures++; }

const original = new Map([[CAND, fs.readFileSync(CAND)], [ONB, fs.readFileSync(ONB)]]);
// Custody: a sidecar copy of every file this battery is about to mutate, so an
// interrupted run is discovered and repaired instead of silently trusted.
const custody = beginDistMutation([...original.keys()]);
for (const f of [M8TEST, PROBE]) {
  if (!fs.existsSync(f)) { console.log(`FAIL precheck — missing ${f} (run npm run build first)`); process.exit(1); }
}

const MUTS = [
  // --- probe-owned gates: only real git can reach (or break) them ---
  { id: 'gate 1 — live verify result is the sole authority', file: CAND,
    search: 'if (v.code !== 0)', replace: 'if (v.code < 0)', count: 1, // a FAIL (code 2) would fall through toward the merge
    probe: true, own: 'candidate changed after a PASS' },
  { id: 'sandwich — candidate HEAD moved during verification', file: CAND,
    search: 'postIdentity.head !== cid.head || postIdentity.tree !== cid.tree', replace: 'false', count: 1,
    probe: true, own: 'mid-plan commit attack' },
  { id: 'sandwich — dirty candidate cannot promote', file: CAND,
    search: 'cid.dirty !== false || !postIdentity.resolved || postIdentity.dirty !== false', replace: '!postIdentity.resolved', count: 1,
    probe: true, own: 'dirty candidate after a PASS' },
  { id: 'gate 4 — TRACKED-dirty base cannot be promoted into', file: CAND,
    search: "if (baseTrackedDirty.trim() !== '')", replace: "if (baseTrackedDirty.trim() === '__never__')", count: 1,
    probe: true, own: 'TRACKED-dirty trusted base' },
  { id: 'gate 5 — detached base refuses', file: CAND,
    search: 'if (branchRaw === null)', replace: 'if (false)', count: 1, // next line's .trim() on null proves the arm was load-bearing
    probe: true, own: 'detached trusted base' },
  { id: 'gate 6 — idempotent re-promote takes no second act', file: CAND,
    search: 'if (idb.head === H)', replace: 'if (false)', count: 1,
    probe: true, own: 're-promote is idempotent' },
  { id: 'apply is fast-forward-only (git call + spawn argv + recorded argv)', file: CAND,
    search: "'--ff-only'", replace: "'--no-ff'", count: 3, // merge commit ≠ H → post-proof must trip
    probe: true, own: 'fast-forwards the branch' },
  { id: 'gate 7 — git refuse status honored, no false ACCEPTED', file: CAND,
    search: 'if (m.status !== 0)', replace: 'if (false)', count: 1,
    probe: true, own: 'divergence' },
  // --- contract-owned gates ---
  { id: '--discard stays --remove-only under --promote too', file: CAND,
    search: "discard && mode !== 'remove'", replace: "discard && mode === 'nope'", count: 1,
    probe: false, own: 'misuse exits 3', testFile: M8TEST },
  { id: 'promotion bundles obey bounded evidence retention', file: ONB,
    search: '(setup|doctor|checkpoint|candidate|promotion)', replace: '(setup|doctor|checkpoint|candidate)', count: 1,
    probe: false, own: 'bounded evidence retention', testFile: M8TEST },
];

function runOwner(m) {
  if (m.probe) {
    const r = spawnSync(process.execPath, [PROBE], { cwd: REPO, encoding: 'utf8', timeout: 900_000, maxBuffer: 64 * 1024 * 1024 });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    const ownerHit = new RegExp(`FAIL [^\\n]*${m.own}`).test(out);
    const failed = out.split(/\r?\n/).filter((l) => l.startsWith('FAIL')).slice(0, 3).join(' | ') || `no FAIL line (probe crash: ${out.split(/\r?\n/).slice(-3).join(' ⏎ ')})`;
    return { caught: r.status !== 0 && ownerHit, why: `probe exit ${r.status ?? r.error?.message}; failing checks: ${failed}` };
  }
  const tf = m.testFile ?? M8TEST;
  const r = spawnSync(process.execPath, ['--test', `--test-name-pattern=${m.own}`, tf], { cwd: REPO, encoding: 'utf8', timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  return { caught: r.status !== 0 && /✖|not ok/.test(out), why: `test exit ${r.status ?? r.error?.message}` };
}

// Optional targeting (1-based into MUTS) for debugging a survivor: node m8-mutation-battery.mjs 3,7
const ONLY = process.argv[2] ? new Set(process.argv.slice(2).flatMap((a) => a.split(',')).map(Number)) : null;
let killed = 0;
try {
  for (const [idx, m] of MUTS.entries()) {
    if (ONLY && !ONLY.has(idx + 1)) continue;
    const src = original.get(m.file).toString('utf8');
    const n = src.split(m.search).length - 1;
    if (n !== m.count) { report('FAIL', `${m.id} — anchor drifted: "${m.search.slice(0, 48)}..." occurs ${n}x, battery pins ${m.count}x — update this battery in the same change as the gate`); continue; }
    fs.writeFileSync(m.file, src.split(m.search).join(m.replace));
    try {
      const { caught, why } = runOwner(m);
      if (caught) { killed++; report('PASS', `caught: ${m.id} (${why})`); }
      else report('FAIL', `SURVIVED: ${m.id} — its removal broke nothing (${why}) — the gate is NOT pinned`);
    } finally {
      fs.writeFileSync(m.file, original.get(m.file)); // restore immediately, even on a spawn crash
    }
  }
} finally {
  let clean = true;
  for (const [f, bytes] of original) {
    if (!fs.readFileSync(f).equals(bytes)) { fs.writeFileSync(f, bytes); clean = false; }
  }
  for (const [f, bytes] of original) if (!fs.readFileSync(f).equals(bytes)) { report('FAIL', `dist bytes NOT restored: ${f}`); clean = false; }
  if (clean) console.log('restore verified: every mutated dist file is byte-identical to its pre-battery bytes');
  // Release custody: verifies the bytes came back and clears the journal. If this
  // process is KILLED before here, the journal survives and the next run repairs.
  const unrecovered = endDistMutation(custody.entries);
  if (unrecovered.length) report('FAIL', `the dist guard could not restore: ${unrecovered.join(', ')}`);
}

const total = (ONLY ? ONLY.size : MUTS.length);
console.log(`M8-MUTATION-BATTERY: ${killed}/${total} mutations caught — survivors: ${total - killed}`);
process.exit(failures === 0 && killed === total ? 0 : 1);
