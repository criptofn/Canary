#!/usr/bin/env node
/**
 * master-pass-mutations — each optimization this pass introduced gets its
 * FAILURE MODE built into the shipped bytes, and the owning scenario MUST
 * catch it. Convention (repo law): mutate the built dist, owning probe/suite
 * must FAIL, restore, byte-compare, anchor-sweep. A mutation that survives
 * means the new code's failure is invisible — that is a defect in the PROOF,
 * reported loudly, not papered over.
 *
 * Mutations (one per changed mechanism):
 *   M1 stamp-reuse forced  (S4)  — re-seal would keep stale approval stamps
 *   M2 unattended refusal  (S1)  — non-TTY setup returns to writes+exit 2
 *   M3 split leak          (S3)  — every→some: an OPEN OBJECTIVE duty could be
 *                                 declared "TECHNICAL EVIDENCE: PROVEN"
 *   M4 compact strip       (S3)  — stdout stops naming the missing duties
 *   M5 status drift-blind  (S1)  — readOnlyProblems skips the sealed-authority check
 *   M6 tracked-config trust (S2) — configTracked memo poisoned to false: a git-
 *                                 committed (clonable) config reads as owned
 *   M7 env-merge escape    (B1)  — hardenedEnv merges the CALLER environment
 *                                 under the sanitized one: NODE_OPTIONS/npm_config_*
 *                                 poison reaches proof-authoritative children
 *   M8 pm trusts PATH      (B1)  — plan steps skip resolvePm; bare pm name is
 *                                 found on the caller's PATH → liar shim decides
 *   M9 git trusts PATH     (B1)  — gitExe fixed literal → bare 'git' on caller PATH
 *   M10 TTY gate removable (B3)  — accept no longer requires a terminal: a pipe
 *                                 that supplies the name self-accepts
 *   M11 stale binding gone (B3)  — freshness ignores candidateHead: acceptance
 *                                 rides onto unreviewed bytes
 *   M12 accept mints auth  (B3)  — cmdAccept's no-frozen-authority refusal gone:
 *                                 accept blesses a candidate nothing registered
 *   M13 authority duty cut (B3)  — the task-authority unshift disappears: a
 *                                 never-registered candidate PASSes (F4's root)
 *
 * NOT built as a mutation, by argument instead: the gitWithinRoot gate memo.
 * The memo caches only the toplevel-containment PRE-FILTER; every actual probe
 * still runs live and fail-closed, so no verdict observable through the CLI
 * can differ under any single-point forcing of the gate — forcing `true` makes
 * each probe run and answer from git itself; forcing `false` fails every probe
 * to null, which is the same null the live gate would produce for a real repo
 * after the toplevel vanishes mid-process. Documented in the final report
 * (item 42) rather than performed as theater.
 */
import { spawnSync } from 'node:child_process';
// In-place dist mutation must be RECOVERABLE: a killed battery leaves dist mutated
// and the build tool will not repair it (see the guard's header for the measured
// incident this closes).
import { beginDistMutation, endDistMutation } from '../test-support/dist-mutation-guard.mjs';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const CLI_FILES = {
  onboarding: path.join(REPO, 'apps/cli/dist/src/onboarding.js'),
  candidate: path.join(REPO, 'apps/cli/dist/src/candidate.js'),
};
const OWNERS = {
  onboarding: ['--test', 'apps/cli/dist/test/onboarding.test.js'],
  subjectivity: ['tooling/probes/master-pass-subjectivity.mjs'],
  status: ['tooling/probes/lazy-connect-status.mjs'],
  env: ['tooling/probes/pre10-env-authority.mjs'],
  acceptance: ['tooling/probes/pre10-acceptance.mjs'],
};
const MUTATIONS = [
  // Single-digest tautologies were tried first and SURVIVED: the reuse guard is
  // a conjunction, so forcing one arm true still leaves the other arms to catch
  // a script change. The real failure mode is the whole guard deciding nothing:
  // mutate the ternary's else-branch to reuse anyway.
  { id: 'M1', file: 'onboarding', from: '? prevCfg : null;', to: '? prevCfg : prevCfg;', owner: 'onboarding', what: 'S4 stamp-reuse fires whenever ANY prior config exists, digests be damned (drifted seals keep their original approval stamps)' },
  { id: 'M2', file: 'onboarding', from: 'if (!opts.yes && !interactive) {', to: 'if (!opts.yes && !interactive) { return 2;', owner: 'onboarding', what: 'S1 reverted: unattended setup demands --yes again after writing everything' },
  { id: 'M3', file: 'candidate', from: "unproven.every((x) => x.mode === 'non-objective')", to: "unproven.some((x) => x.mode === 'non-objective')", owner: 'subjectivity', what: 'S3 split verdict leaks onto objectives-open candidates (any non-objective unproven claims TECHNICAL EVIDENCE: PROVEN)' },
  { id: 'M4', file: 'candidate', from: 'for (const x of unproven)', to: 'for (const x of [])', owner: 'subjectivity', what: 'S3 compact stdout drops the UNPROVEN duty list entirely (PART III failure UX gutted)' },
  // RE-PINNED (v1.1): M5, M8 and M9's original anchors were refactored away by
  // later commits — including the pre10-env-authority fix that introduced the
  // named `gitCandidates()` helper. The battery's own rule is "update this
  // battery in the same change as the gate", so the anchors follow the code and
  // each mutation keeps its ORIGINAL failure mode, not its original text.
  { id: 'M5', file: 'onboarding', from: 'const drift = planAuthorityDrift(root, cfg);', to: 'const drift = null;', owner: 'status', what: 'S1 status becomes drift-blind (sealed authority changes go unreported)' },
  { id: 'M6', file: 'onboarding', from: 'const seen = configTrackedMemo.get(root);', to: 'const seen = false;', owner: 'status', what: 'S2 memo poisons config ownership: a git-committed config reads as this machine\'s own' },
  // Pre-1.0 blocker closure: each mutant re-opens exactly one door the GLM audit
  // found. pre10-env-authority owns the execution-authority trio,
  // pre10-acceptance the human-acceptance quartet, M13's root duty belongs to the
  // subjectivity battery (its G case is the no-authority law).
  { id: 'M7', file: 'onboarding', from: 'const hardenedEnv = (fixture) => sanitizedEnv({ ws: { root: os.tmpdir(), fixture }, nodeDir: NODE_DIR });', to: 'const hardenedEnv = (fixture) => ({ ...process.env, ...sanitizedEnv({ ws: { root: os.tmpdir(), fixture }, nodeDir: NODE_DIR }) });', owner: 'env', what: 'B1 merge escape: caller NODE_OPTIONS/npm_config_* poison reaches proof-authoritative children (deny-by-omission becomes allow-by-inheritance)' },
  // M8 re-pinned onto the real step-execution resolution: keep the exact command
  // (spawnArgv stays the full argv) but stop resolving the program through the
  // trusted dirs, so `exec.file` becomes the bare name and a caller-PATH shim can
  // decide the verdict. That is the same door the original anchor mutated.
  { id: 'M8', file: 'onboarding', from: 'const resolved = resolveProgram(program, step.adapter);', to: "const resolved = { spawnArgv: argv, file: program, via: 'trusted-path' };", owner: 'env', what: 'B1 pm door: the step program is no longer resolved through the trusted dirs — a bare name on the caller PATH decides PASS and promotion' },
  // M9 re-pinned onto the current gitExe(): the helper is named now, the door is
  // the same — resolve git as a bare name on PATH instead of the fixed literals.
  { id: 'M9', file: 'onboarding', from: 'gitExeCache = gitCandidates().find((c) => fs.existsSync(c)) ?? null;', to: "gitExeCache = 'git';", owner: 'env', what: 'B1 git door: bare git resolves on the caller PATH — attacker git forges base/evidence at promotion' },
  { id: 'M10', file: 'candidate', from: 'if (!process.stdin.isTTY || !process.stdout.isTTY) {', to: 'if (false) {', owner: 'acceptance', what: 'B3 terminal gate gone: an agent pipe that merely supplies the name self-accepts its own work' },
  { id: 'M11', file: 'candidate', from: "typeof context !== 'string' && acc.subjectDigest === subjectDigest(context.subject)", to: 'true', owner: 'acceptance', what: 'B3 freshness gutted: acceptance rides onto commits made AFTER the human signed' },
  { id: 'M12', file: 'candidate', from: 'if (!frozen || !frozen.kinds.length)', to: 'if (!frozen)', owner: 'acceptance', what: 'B3 accept mints authority: an empty frozen kind set can be accepted' },
  { id: 'M13', file: 'candidate', from: 'if (!frozenKinds.length || !canonicalTask(frozenTask))', to: 'if (false)', owner: 'subjectivity', what: 'B3/F4 root: task-authority duty dropped — a never-registered candidate reaches PASS and promotion' },
];

/**
 * An owner's verdict, with the repo's host-bound SKIP convention understood.
 *
 * Exit 3 means "everything THIS host could run passed, with explicit SKIP lines"
 * (`tooling/verify-productization.mjs`, htg-inline-interpreter-corpus.mjs). The
 * two acceptance owners use it where the host has no drivable real pty, so:
 *   - as a BASELINE, 3 is legitimate: the owner is as green as the host permits;
 *   - as a MUTANT result, 3 is NOT a catch: nothing actually failed, so a
 *     mutation that leaves the owner at 3 survived. Only a real FAIL (exit 1/2)
 *     counts as caught. Treating "not 0" as caught would let a mutation pass by
 *     making the owner skip, which is exactly the kind of silent green this
 *     battery exists to prevent.
 */
function runOwner(owner) {
  const r = spawnSync(process.execPath, OWNERS[owner], { cwd: REPO, encoding: 'utf8', timeout: 900_000, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, green: r.status === 0 || r.status === 3 };
}
let failures = 0;
const originals = new Map();
for (const [k, p] of Object.entries(CLI_FILES)) originals.set(k, fs.readFileSync(p));
// Custody: a sidecar copy of every file this battery will mutate, so an interrupted
// run is discovered and repaired instead of silently trusted.
const custody = beginDistMutation([...CLI_FILES].map(([, p]) => p).filter((p, i, a) => a.indexOf(p) === i));

console.log('=== master-pass-mutations: baseline owner runs ===');
for (const owner of new Set(MUTATIONS.map((m) => m.owner))) {
  const { status, green } = runOwner(owner);
  console.log(`${green ? 'PASS' : 'FAIL'} baseline owner=${owner} (exit ${status}${status === 3 ? ' = host-bound SKIP: ran everything this host could' : ''})`);
  if (!green) { failures++; console.log('  baseline must be green before mutating — aborting'); process.exit(1); }
}

for (const m of MUTATIONS) {
  const p = CLI_FILES[m.file];
  const src = originals.get(m.file).toString('utf8');
  const n = src.split(m.from).length - 1;
  if (n !== 1) { failures++; console.log(`FAIL ${m.id}: anchor not unique (${n}x): ${m.from}`); continue; }
  fs.writeFileSync(p, src.replace(m.from, m.to));
  try {
    const { status, green } = runOwner(m.owner);
    if (green) { failures++; console.log(`FAIL ${m.id} SURVIVED: ${m.what}\n     owner=${m.owner} still green (exit ${status}) under this mutation — the proof has a hole`); }
    else console.log(`PASS ${m.id} caught by ${m.owner} (exit ${status}): ${m.what}`);
  } finally {
    fs.writeFileSync(p, originals.get(m.file));
    const back = fs.readFileSync(p).equals(originals.get(m.file));
    if (!back) { failures++; console.log(`FAIL ${m.id}: restore byte-mismatch on ${m.file}`); }
    // anchor sweep: every mutation target must still exist exactly once
    for (const q of MUTATIONS) {
      if (q.file !== m.file) continue;
      const c = fs.readFileSync(CLI_FILES[q.file], 'utf8').split(q.from).length - 1;
      if (c !== 1) { failures++; console.log(`FAIL ${m.id} anchor-sweep: ${q.id} anchor count ${c} after restore`); }
    }
  }
}
// Release custody: verifies every mutated file came back byte-identically and
// clears the journal. If this process is KILLED before here, the journal
// survives, and the next battery start (or the oracle) repairs the tree.
const unrecovered = endDistMutation(custody.entries);
if (unrecovered.length > 0) {
  failures++;
  console.log(`FAIL: the dist guard could not restore: ${unrecovered.join(', ')} — run \`npx tsc -b --force\``);
}
console.log(`\n=== master-pass-mutations: ${failures === 0 ? `ALL ${MUTATIONS.length} CAUGHT` : failures + ' PROBLEM(S)'} ===`);
process.exit(failures === 0 ? 0 : 1);
