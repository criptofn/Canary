#!/usr/bin/env node
/**
 * M10 mutation battery — deterministic kill checks for the obligation ladder
 * (§10) and the intent guard (§11) at the candidate boundary.
 *
 * Same convention as the m7/m8/m9 batteries: mutate the BUILT dist bytes (a
 * gitignored artifact), run the ONE probe that owns these gates (real-git M10
 * obligations+intent probe), require IT to fail with the owning scenario's
 * FAIL line, restore and byte-compare. A branch whose removal breaks nothing
 * is a branch no check actually pins. Exit 0 only when every mutation was
 * caught. NO PROOF, NO DONE.
 *
 * 22 mutations: 1–2 pin the record-write freeze (snapshot + task); 3–8 pin
 * the guard arms (drop, re-seal, kind/requirement shrink, intentEvent bytes);
 * 9–12 pin the ladder (unmet branch, unproven branch, unproven's honest
 * status, obligations riding every bundle — incl. the FAIL arm); 13–15 pin
 * the obligation ENGINE in onboarding.js (regression evidence, tests-green,
 * attributable deletion); 16–19 pin the review-round gates (lying-index fold
 * into dirty, the suffix-surviving rename escape, pre-window signal capture,
 * the clean-at-birth isolate assert); 20–22 pin the M10.2 FROZEN task-
 * AUTHORITY gate (GLM re-audit, F4-GATE-1/2): removing it re-opens the
 * taskless bypass (S12 goes PASS), reading the LIVE task instead of the
 * frozen snapshot re-opens post-isolation self-minting (S12's GATE-1 leg),
 * and re-conditioning the gate on rec.intent re-opens the legacy-PASS
 * strip-the-snapshot bypass (S5).
 * Mutation 5/7 INVERT rather than delete —
 * a guard that shouts at innocence fails the positive control, which is the
 * same evidence that the comparison is load-bearing.
 *
 * Deliberately NOT mutated — no deterministic trigger in this layer:
 *  - the promote-side double lock (startHead:null + gate 1 code!==0): either
 *    lock alone produces the identical refusal, so no probe scenario can
 *    distinguish them; the single-lock removals ARE pinned (mutation 10 makes
 *    NOT PROVEN a PASS, which gate 1 then promotes — S2 catches it). Honest
 *    redundancy, same status as M8's identity sandwich.
 *  - the seal-gone event (no seal in current config after re-create): only
 *    reachable with a hand-edited config — pinned by the M10 contract tests.
 *  - malformed-intent record refusal: loadRecord validation is a record
 *    shape property; the contract tests pin it (dist mutation of loadRecord
 *    would break every hand-written fixture record equally — no clean signal).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const CAND = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'candidate.js');
const ONB = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'onboarding.js');
const AUTH = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'authorization.js');
const PROBE = path.join(REPO, 'tooling', 'probes', 'm10-obligations.mjs');

let failures = 0;
function report(verdict, msg) { console.log(`${verdict} ${msg}`); if (verdict === 'FAIL') failures++; }

const original = new Map([[CAND, fs.readFileSync(CAND)], [ONB, fs.readFileSync(ONB)], [AUTH, fs.readFileSync(AUTH)]]);
if (!fs.existsSync(PROBE)) { console.log(`FAIL precheck — missing ${PROBE}`); process.exit(1); }

const MUTS = [
  // --- the freeze at record-write (§11 premise: snapshot = isolation-time bytes) ---
  { id: 'the record freezes the intent snapshot at all (no snapshot = no §11 guard ever)', file: CAND,
    search: '        intent: {', replace: '        intentX: {', count: 1, own: 'S4a plan step' },
  { id: 'the snapshot freezes the LIVE task record, not null (task shrink must be visible)', file: CAND,
    search: 'task: readTaskRecord(root),', replace: 'task: null,', count: 1, own: 'S4b task kinds' },
  // --- the guard arms ---
  { id: 'the guard runs when a snapshot exists', file: CAND,
    search: 'if (rec.intent) {', replace: 'if (rec.intent && false) {', count: 1, own: 'S4a plan step' },
  { id: 'a dropped plan step is detected', file: CAND,
    search: 'if (!curScripts.has(s.script))', replace: 'if (false)', count: 1, own: 'S4a plan step' },
  { id: 'the digest comparison is the right direction (inverted = guard shouts at matched seals, breaks S1)', file: CAND,
    search: 'if (cfg.planAuthority.scriptDigests[script] !== digest)', replace: 'if (cfg.planAuthority.scriptDigests[script] === digest)', count: 1, own: 'S1 positive' },
  { id: 'a vanished task kind is detected (canonical owner)', file: AUTH,
    search: 'if (!live.kinds.includes(kind))', replace: 'if (false)', count: 1, own: 'S4b task kinds' },
  { id: 'requirement identity comparison is correct (inverted = honest scope blocked)', file: AUTH,
    search: 'if (i < 0)', replace: 'if (i >= 0)', count: 1, own: 'S4b task kinds' },
  { id: 'the blocked bundle carries the intentEvent (the WHY must be in bytes, not prose only)', file: CAND,
    search: '{ intentEvent: { snapshotAt: rec.intent.at, events } }', replace: '{ intentEventDropped: { snapshotAt: rec.intent.at, events } }', count: 1, own: 'S4a plan step' },
  // --- the ladder (order: fail > unmet > unproven > pass) ---
  { id: 'the unmet branch exists — an objectively violated obligation cannot pass', file: CAND,
    search: "const unmet = obligations.filter((x) => x.status === 'unmet');", replace: 'const unmet = [];', count: 1, own: 'S3 committed' },
  { id: 'the unproven branch exists — a green plan cannot launder a missing proof', file: CAND,
    search: "const unproven = obligations.filter((x) => x.status === 'unproven');", replace: 'const unproven = [];', count: 1, own: 'S2 green' },
  { id: "the unproven bundle's status is honest ('pass' would be the laundering lie)", file: CAND,
    search: "writeVerificationBundle(root, 'candidate', results, 'unproven', prov", replace: "writeVerificationBundle(root, 'candidate', results, 'pass', prov", count: 1, own: 'S2 green' },
  { id: 'obligations ride EVERY bundle (incl. the FAIL arm — M11 repair fuel)', file: CAND,
    search: 'extra: { ...extra, obligations: obList }', replace: 'extra: { ...extra }', count: 4, own: 'S1 positive' },
  // --- the obligation engine in onboarding.js ---
  { id: 'regression evidence reads the candidate diff (always-false: a proven bugfix goes NOT PROVEN)', file: ONB,
    search: 'const testTouched = sig.changes.some(isTestPath);', replace: 'const testTouched = false;', count: 1, own: 'S1 positive' },
  { id: 'tests-green is met when the plan has a tests step (inverted = breaks the positive control)', file: ONB,
    search: "add(has('tests')", replace: "add(!has('tests')", count: 1, own: 'S1 positive' },
  { id: 'committed test deletions ARE attributed to the coverage-loss obligation', file: ONB,
    search: 'deletedTestsAttributable: [...new Set(attrDel)].filter(isTestPath),', replace: 'deletedTestsAttributable: [],', count: 1, own: 'S3 committed' },
  // --- the review-round gates (adversary F2/F3, correctness #1/#4b, evidence) ---
  { id: 'the lying index (--assume-unchanged / skip-worktree) folds into dirty (adversary F2)', file: ONB,
    search: 'const sneaky = status === null ? false : flags !== null && /^(?:[a-z]|S) /m.test(flags);', replace: 'const sneaky = false;', count: 1, own: 'S8' },
  { id: 'a test renamed out of the test DIRECTORY is coverage loss even keeping the suffix (adversary F3)', file: ONB,
    search: 'isTestDirPath(e.paths[0]) && !isTestDirPath(e.paths[1])', replace: 'false', count: 1, own: 'S9' },
  { id: 'the ladder reads signals captured BEFORE the window, not re-read after it (correctness #4b)', file: CAND,
    search: 'obligationsFor(task?.kinds ?? [], sig,', replace: 'obligationsFor(task?.kinds ?? [], candidateDiffSignals(rec.root, rec.baseHead),', count: 1, own: 'S10' },
  { id: 'isolate asserts the worktree is provably CLEAN at birth, not just the right commit (correctness isolate post-check)', file: CAND,
    search: 'if (!cid.resolved || cid.head !== sha || cid.dirty) {', replace: 'if (!cid.resolved || cid.head !== sha) {', count: 1, own: 'S11' },
  // --- M10.2 (GLM re-audit F4-GATE-1/2): the FROZEN task-authority gate ---
  { id: 'the authority gate exists at all — remove it and the taskless bypass re-opens (S12 taskless goes PASS)', file: CAND,
    search: 'if (!frozenKinds.length || !canonicalTask(frozenTask)) {', replace: 'if (false) {', count: 1, own: 'S12' },
  { id: 'authority reads ONLY the frozen snapshot — read the live task instead and post-isolation registration mints it again (F4-GATE-1 re-opens)', file: CAND,
    search: 'const frozenTask = rec.intent?.task ?? null;', replace: 'const frozenTask = task ?? null;', count: 1, own: 'S12' },
  { id: 'a missing snapshot fails SAFE — condition the gate on rec.intent again and the legacy-PASS strip bypass (F4-GATE-2) re-opens', file: CAND,
    search: 'if (!frozenKinds.length || !canonicalTask(frozenTask)) {', replace: 'if (rec.intent && (!frozenKinds.length || !canonicalTask(frozenTask))) {', count: 1, own: 'S5' },
];

function runProbe(m) {
  const r = spawnSync(process.execPath, [PROBE], { cwd: REPO, encoding: 'utf8', timeout: 900_000, maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const ownerHit = new RegExp(`FAIL [^\\n]*${m.own}`).test(out);
  const failed = out.split(/\r?\n/).filter((l) => l.startsWith('FAIL')).slice(0, 3).join(' | ') || `no FAIL line (probe crash: ${out.split(/\r?\n/).slice(-3).join(' ⏎ ')})`;
  return { caught: r.status !== 0 && ownerHit, why: `probe exit ${r.status ?? r.error?.message}; failing checks: ${failed}` };
}

// Optional targeting (1-based into MUTS) for debugging a survivor: node m10-mutation-battery.mjs 3,7
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
  // Full anchor sweep, not a sample: every mutation's search string must sit at
  // its pinned count in the restored dist. A stuck residue (or a contaminated
  // startup snapshot) flips exactly one anchor — sampling 2 of 15 could miss it.
  for (const [idx, m] of MUTS.entries()) {
    const n = fs.readFileSync(m.file, 'utf8').split(m.search).length - 1;
    if (n !== m.count) report('FAIL', `post-battery sanity: mutation ${idx + 1} anchor "${m.search.slice(0, 48)}" occurs ${n}x in restored ${path.basename(m.file)}, battery pins ${m.count}x — residue or contaminated startup snapshot`);
  }
}

const total = (ONLY ? ONLY.size : MUTS.length);
console.log(`M10-MUTATION-BATTERY: ${killed}/${total} mutations caught — survivors: ${total - killed}`);
process.exit(failures === 0 && killed === total ? 0 : 1);
