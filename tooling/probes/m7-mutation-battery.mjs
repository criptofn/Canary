#!/usr/bin/env node
/**
 * M7 mutation battery — deterministic kill checks for the review-hardened gates.
 *
 * Convention from tooling/probes/audit-f1-f2-mutation.mjs: mutate the BUILT dist
 * bytes (a gitignored artifact), run the ONE check that owns that gate, require
 * it to FAIL, restore the bytes and byte-compare the restore. A gate whose
 * removal breaks nothing is a gate no check actually pins. Exit 0 only when
 * every mutation was caught. NO PROOF, NO DONE.
 *
 * 14 mutations, each anchored to a compiled substring whose occurrence count is
 * asserted before mutating (anchor drift fails the battery loudly instead of
 * silently "passing" against bytes that were never changed).
 *   - probe-owned gates: run the real-git M7 probe and require `FAIL <owner>`
 *     on its own line — the check that guards that gate must be the one that
 *     breaks, not just any nonzero exit.
 *   - contract-owned gates: run ONLY the owning node --test pattern and require
 *     a ✖ (a typo'd pattern that matches zero tests would exit 0 vacuously).
 *
 * Deliberately NOT mutated (no deterministic trigger in the current layers —
 * recorded honestly rather than oversold): the runPlanStep throw-catch, the
 * treeProbe===null and changed===null fail-closed arms, the worktree
 * post-check rollback paths, and the ls-tree maxBuffer guard. The Windows
 * reserved-stem mutation is skipped off win32 (its owning test is too).
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
const M7TEST = path.join(REPO, 'apps', 'cli', 'dist', 'test', 'm7-candidate-isolation.test.js');
const M3TEST = path.join(REPO, 'apps', 'cli', 'dist', 'test', 'm3-trust-classes.test.js');
const PROBE = path.join(REPO, 'tooling', 'probes', 'm7-candidate-isolation.mjs');

let failures = 0;
function report(verdict, msg) { console.log(`${verdict} ${msg}`); if (verdict === 'FAIL') failures++; }

const original = new Map([[CAND, fs.readFileSync(CAND)], [ONB, fs.readFileSync(ONB)]]);
// Custody: a sidecar copy of every file this battery is about to mutate, so an
// interrupted run is discovered and repaired instead of silently trusted.
const custody = beginDistMutation([...original.keys()]);
for (const f of [M7TEST, M3TEST, PROBE]) {
  if (!fs.existsSync(f)) { console.log(`FAIL precheck — missing ${f} (run npm run build first)`); process.exit(1); }
}

const MUTS = [
  // --- gates proven in the real-git probe (a fake-git layer cannot reach them) ---
  { id: 'pre/post lifecycle-hook gate', file: CAND,
    search: 'Object.hasOwn(scripts, `pre${s.script}`) || Object.hasOwn(scripts, `post${s.script}`)', replace: 'false', count: 1,
    probe: true, own: 'pretest hook' },
  { id: '.npmrc absent-from-base gate', file: CAND,
    search: 'if (baseNpmrc === null)', replace: 'if (baseNpmrc === 1)', count: 1, // null never equals a number: gate cannot fire
    probe: true, own: 'ABSENT from the base' },
  { id: '.npmrc changed-vs-base gate', file: CAND,
    search: "if (changed.trim() !== '')", replace: "if (changed.trim() === '__never__')", count: 1,
    probe: true, own: 'IDENTICAL to base passes' },
  { id: 'committed-gitlink gate', file: CAND,
    search: '/^160000/m', replace: '/^160000q/m', count: 1, // no ls-tree line can start "160000q"
    probe: true, own: 'gitlink blocks as submodule' },
  { id: 'empty-plan gate', file: CAND,
    search: 'cfg.plan.length === 0', replace: 'cfg.plan.length < 0', count: 1,
    probe: true, own: 'EMPTY on-disk plan' },
  { id: 'candidate registry-dir creation (--path elsewhere)', file: CAND,
    search: 'fs.mkdirSync(path.dirname(rp), { recursive: true });', replace: '/*MUT*/;', count: 1,
    probe: true, own: 'OUTSIDE the base: registers' }, // git worktree add itself creates candidates/ for default paths — only the outside-base record dir proves this mkdir
  { id: 'sealed-authority drift gate', file: CAND,
    search: 'if (drift)', replace: 'if (drift && false)', count: 1,
    probe: true, own: 'BLOCKS BEFORE EXECUTION' },
  { id: 'git-common-dir binding (IMPOSTOR)', file: CAND,
    search: '!samePath(baseCd, candCd)', replace: 'false', count: 1,
    probe: true, own: 'UNRELATED real repo' },
  { id: 'dirty-remove refusal', file: CAND,
    search: 'id.resolved && id.dirty && !discard', replace: 'id.resolved && id.dirty && discard', count: 1,
    probe: true, own: 'remove refuses a dirty candidate' },
  // --- gates the contract layer owns ---
  { id: 'baseRoot impersonation guard (verify + accept + remove)', file: CAND,
    search: '!samePath(rec.baseRoot, root)', replace: 'false', count: 3,
    probe: false, own: 'impersonation guard' },
  { id: 'candidate NAME_RE (registry keys are filenames)', file: CAND,
    search: '/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/', replace: '/^[\\s\\S]{0,64}$/', count: 1,
    probe: false, own: 'misuse exits 3' },
  { id: 'Windows reserved device-name gate', file: CAND, win32Only: true,
    search: '/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i', replace: '/^__never__$/i', count: 1,
    probe: false, own: 'Windows reserved device names' },
  { id: 'uninstall candidate-registry gate', file: ONB,
    search: "fs.readdirSync(path.join(root, CONFIG_DIR, 'candidates')).length > 0",
    replace: "fs.readdirSync(path.join(root, CONFIG_DIR, 'candidates')).length > Number.MAX_SAFE_INTEGER", count: 1,
    probe: false, own: 'uninstall refuses to delete' },
  { id: 'BUNDLE_RESERVED side-door filter', file: ONB,
    search: 'filter(([k]) => !BUNDLE_RESERVED.has(k))', replace: 'filter(([k]) => BUNDLE_RESERVED.has(k))', count: 1,
    probe: false, own: 'no side door', testFile: M3TEST },
];

function runOwner(m) {
  if (m.probe) {
    const r = spawnSync(process.execPath, [PROBE], { cwd: REPO, encoding: 'utf8', timeout: 900_000, maxBuffer: 64 * 1024 * 1024 });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    const ownerHit = new RegExp(`FAIL [^\\n]*${m.own}`).test(out);
    const failed = out.split(/\r?\n/).filter((l) => l.startsWith('FAIL')).slice(0, 3).join(' | ') || `no FAIL line (probe crash: ${out.split(/\r?\n/).slice(-3).join(' ⏎ ')})`;
    return { caught: r.status !== 0 && ownerHit, why: `probe exit ${r.status ?? r.error?.message}; failing checks: ${failed}` };
  }
  const tf = m.testFile ?? M7TEST;
  const r = spawnSync(process.execPath, ['--test', `--test-name-pattern=${m.own}`, tf], { cwd: REPO, encoding: 'utf8', timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  return { caught: r.status !== 0 && /✖|not ok/.test(out), why: `test exit ${r.status ?? r.error?.message}` };
}

// Optional targeting (1-based into MUTS) for debugging a survivor: node m7-mutation-battery.mjs 6,8
const ONLY = process.argv[2] ? new Set(process.argv.slice(2).flatMap((a) => a.split(',')).map(Number)) : null;
let killed = 0, skipped = 0;
try {
  for (const [idx, m] of MUTS.entries()) {
    if (ONLY && !ONLY.has(idx + 1)) continue;
    if (m.win32Only && process.platform !== 'win32') { skipped++; report('SKIP', `${m.id} — win32-only mutation and win32-only test (honest gap, not a pass)`); continue; }
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

const total = (ONLY ? ONLY.size : MUTS.length) - skipped;
console.log(`M7-MUTATION-BATTERY: ${killed}/${total} mutations caught (${skipped} skipped) — survivors: ${total - killed}`);
process.exit(failures === 0 && killed === total ? 0 : 1);
