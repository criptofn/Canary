#!/usr/bin/env node
/**
 * M9 mutation battery — deterministic kill checks for the authority guard.
 *
 * Same convention as the m7/m8 batteries: mutate the BUILT dist bytes (a
 * gitignored artifact), run the ONE probe that owns that gate (real-git M9
 * authority probe), require IT to fail with the owning scenario's FAIL line,
 * restore and byte-compare. A guard whose removal breaks nothing is a guard
 * no check actually pins. Exit 0 only when every mutation was caught.
 * NO PROOF, NO DONE.
 *
 * 15 mutations, each anchored to a compiled substring whose occurrence count
 * is asserted before mutating — anchor drift fails loudly. Both window arms
 * read through the one inWindowDrift(), so the evidence mutation pins plant,
 * edit AND wipe on both edges at once; mutations 11–15 pin the review
 * hardening: the verifier-code tree (F1), the quarantine refusal (F2), the
 * stamp (F2), the post-window seal recheck (F3) and the base-HEAD token (F4).
 *
 * Deliberately NOT mutated — no deterministic trigger in this layer, recorded
 * honestly rather than oversold:
 *  - the THROW-arm checks (`threwDrift`, `threwSeal`): reaching them requires
 *    a sealed plan whose step is refused by stepArgv AFTER an earlier step
 *    mutated authority — a refused script name can never be sealed via setup,
 *    so the arms are defensive redundancy over the same authorityDrift /
 *    sealViolation calls that mutations 1/6/9/14 already pin.
 *  - the CLI_ENTRY list item: hand-tampering it would mutate the RUNNING
 *    dist mid-test and destroy the subject. Its mechanism is no longer
 *    unpinned, though — mutation 11 removes the dist/src tree fingerprint
 *    that covers the whole import graph (main.js, candidate.js included),
 *    and the probe's verifier-code scenario proves it on a sibling file.
 *  - change-and-revert strictly inside one window: a single-threaded
 *    sandwich cannot witness it (same honest ceiling as M8's identity
 *    sandwich; M19 persistence narrows the human-visible gap).
 *  - shortState() and the UNREADABLE token plumbing: display/fail-closed
 *    construction; the authority is the comparison itself, pinned via the
 *    settingsdrop ABSENT-token scenario (dropping settings from the list is
 *    mutation 7).
 *  - promote-side enforcement: gate 1 (`v.code !== 0`) is the m8 battery's
 *    subject, and the §9 mandate rides the same VerifyOutcome it pins.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const CAND = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'candidate.js');
const PROBE = path.join(REPO, 'tooling', 'probes', 'm9-authority.mjs');

let failures = 0;
function report(verdict, msg) { console.log(`${verdict} ${msg}`); if (verdict === 'FAIL') failures++; }

const original = new Map([[CAND, fs.readFileSync(CAND)]]);
if (!fs.existsSync(PROBE)) { console.log(`FAIL precheck — missing ${PROBE} (run npm run build first)`); process.exit(1); }

const AUTH_LIST = 'const authority = [configPath(root), settings, recordPath(root, name), path.join(root, CONFIG_DIR, TASK_FILE), CLI_ENTRY]';
const MUTS = [
  // --- detection itself ---
  { id: 'success-arm drift check is load-bearing (any in-window write forces the mandate)', file: CAND,
    search: 'if (authDrift.length)', replace: 'if (false && authDrift.length)', count: 1, own: 'mode=config' },
  { id: 'config bytes are in the fingerprint set', file: CAND,
    search: 'const authority = [configPath(root), settings,', replace: 'const authority = [settings,', count: 1, own: 'mode=config' },
  { id: 'harness settings bytes are in the fingerprint set', file: CAND,
    search: 'const authority = [configPath(root), settings, recordPath(root, name)', replace: 'const authority = [configPath(root), recordPath(root, name)', count: 1, own: 'mode=settings' },
  { id: 'registry record bytes are in the fingerprint set', file: CAND,
    search: 'settings, recordPath(root, name), path.join(root, CONFIG_DIR, TASK_FILE)', replace: 'settings, path.join(root, CONFIG_DIR, TASK_FILE)', count: 1, own: 'mode=record' },
  { id: 'task-intent bytes are in the fingerprint set', file: CAND,
    search: 'recordPath(root, name), path.join(root, CONFIG_DIR, TASK_FILE), CLI_ENTRY]', replace: 'recordPath(root, name), CLI_ENTRY]', count: 1, own: 'mode=task' },
  { id: 'evidence store is in the fingerprint set (tree, both window edges)', file: CAND,
    search: '...treeDrift(preEvidence, evidenceDir).map', replace: '...[].map', count: 1, own: 'mode=evidence' },
  // --- containment pre-gate ---
  { id: 'containment pre-gate runs when setup promised the settings file', file: CAND,
    search: 'if (cfg.touched.some((t) => samePath(t.path, settings)))', replace: 'if (false)', count: 1, own: 'stripped harness' },
  { id: 'pre-gate fires on MISSING entry, not on presence (inverted = guard shouts at innocence)', file: CAND,
    search: 'if (!doc || !hasCanaryEntry(doc, new Set(cfg.hookCommands)))', replace: 'if (doc && hasCanaryEntry(doc, new Set(cfg.hookCommands)))', count: 1, own: 'positive control' },
  // --- the verdict cannot be laundered ---
  { id: 'the mandate exits 2 (code 0 = a modified verifier scoring itself green)', file: CAND,
    search: "'evidence')}`);\n        return { code: 2, startHead: null, rec };",
    replace: "'evidence')}`);\n        return { code: 0, startHead: null, rec };", count: 1, own: 'mode=config' },
  { id: 'mandate bundle status is blocked, never pass', file: CAND,
    search: "const dir = writeVerificationBundle(root, 'candidate', [], 'blocked', prov, {",
    replace: "const dir = writeVerificationBundle(root, 'candidate', [], 'pass', prov, {", count: 1, own: 'mode=record' },
  // --- review hardening F1–F4 ---
  { id: 'the verifier code tree (dist/src) is in the fingerprint set', file: CAND,
    search: '...treeDrift(preCli, cliDir).map', replace: '...[].map', count: 1, own: 'verifier code' },
  { id: 'a live quarantine marker short-circuits judging (refusal, not verdict)', file: CAND,
    search: 'const q = quarantineInfo(path.join(root, CONFIG_DIR, QUARANTINE_FILE));',
    replace: 'const q = null;', count: 1, own: 'quarantine refusal' },
  { id: 'a during/after-execution mandate stamps the quarantine marker', file: CAND,
    search: 'stampQuarantine(path.join(root, CONFIG_DIR, QUARANTINE_FILE), when, changes);',
    replace: ';', count: 1, own: 'quarantine refusal' },
  { id: 'the sealed-plan checks re-run at the post-window edge (step 1 cannot rewrite step 2)', file: CAND,
    search: "const postSeal = sealViolation('after execution');",
    replace: 'const postSeal = null;', count: 1, own: 'post-window' },
  { id: 'the base HEAD ref is a sandwich token (a sealed step cannot move the base branch unseen)', file: CAND,
    search: '...(postHead !== preHead ?', replace: '...(false ?', count: 1, own: 'base HEAD' },
];

function runProbe(m) {
  const r = spawnSync(process.execPath, [PROBE], { cwd: REPO, encoding: 'utf8', timeout: 900_000, maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const ownerHit = new RegExp(`FAIL [^\\n]*${m.own}`).test(out);
  const failed = out.split(/\r?\n/).filter((l) => l.startsWith('FAIL')).slice(0, 3).join(' | ') || `no FAIL line (probe crash: ${out.split(/\r?\n/).slice(-3).join(' ⏎ ')})`;
  return { caught: r.status !== 0 && ownerHit, why: `probe exit ${r.status ?? r.error?.message}; failing checks: ${failed}` };
}

// Optional targeting (1-based into MUTS) for debugging a survivor: node m9-mutation-battery.mjs 3,7
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
      const { caught, why } = runProbe(m);
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
  const sanity = fs.readFileSync(CAND, 'utf8');
  if (!sanity.includes(AUTH_LIST)) { report('FAIL', 'post-battery sanity: the authority fingerprint list is not intact in dist'); }
}

const total = (ONLY ? ONLY.size : MUTS.length);
console.log(`M9-MUTATION-BATTERY: ${killed}/${total} mutations caught — survivors: ${total - killed}`);
process.exit(failures === 0 && killed === total ? 0 : 1);
