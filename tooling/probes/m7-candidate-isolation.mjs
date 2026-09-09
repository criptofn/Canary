#!/usr/bin/env node
/**
 * M7 real-git end-to-end probe. The contract tests (m7-candidate-isolation.test.ts)
 * pin the refusal surface under FAKE git — here the git is real, so this is where
 * the §7 guarantees actually get proven: a worktree is created and bound to the
 * exact base commit; worker edits never touch the base; PASS runs the sealed plan
 * INSIDE the candidate with evidence landing OUTSIDE it; FAIL and every BLOCK leave
 * the base byte-identical; every pre-execution block — script swap (drift), pre/post
 * lifecycle hook, candidate-side .npmrc (absent-from-base AND changed-vs-base),
 * committed gitlink, empty plan — is proven with a zero-step blocked bundle, and
 * the swap additionally by marker-absence plus a positive control proving the
 * marker is live; dirty/lost/impersonating/unregistered states all recover honestly;
 * spaces+Unicode --path and OUTSIDE-base --path both work end to end; removal
 * refuses dirty without --discard and clean-removes without one.
 * NO PROOF, NO DONE: this probe is the M7 positive path.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const CLI = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');
const MARKER_FIXTURE = path.join(REPO, 'tooling', 'test-support', 'fixtures', 'm7-ran-marker.js');
const SWAP_RAN = path.join(os.tmpdir(), 'canary-m7-swap-ran.txt');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}\n     ${String(e.message ?? e).split('\n').join('\n     ')}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertMatch(hay, re, msg) { assert(re.test(hay), `${msg}\n     expected /${re}/ in:\n     ${hay.split('\n').slice(0, 20).join('\n     ')}`); }
function assertEq(actual, expected, msg) { assert(actual === expected, `${msg}\n     expected: ${JSON.stringify(expected)}\n     actual:   ${JSON.stringify(actual)}`); }

// prechecks — the probe tests the BUILT CLI and real git, not wishes
assert(fs.existsSync(CLI), `missing built CLI (run npm run build): ${CLI}`);
{
  const gv = spawnSync('git', ['--version'], { encoding: 'utf8', timeout: 15_000 });
  assert(gv.status === 0, `git not runnable: ${gv.error?.message ?? gv.status}`);
  const m = /git version (\d+)\.(\d+)/.exec(gv.stdout);
  assert(m && Number(m[1]) * 100 + Number(m[2]) >= 230, `git too old for worktree --end-of-options plumbing: ${gv.stdout.trim()}`);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-m7-probe-'));

function git(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 60_000 });
  assert(r.status === 0, `git ${args.join(' ')} (in ${dir}) failed: ${r.stderr?.trim() || r.stdout?.trim() || r.error?.message}`);
  return r.stdout.trim();
}
function canary(args, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', timeout: 120_000 });
}
function makeRepo(name) {
  const root = path.join(TMP, name);
  fs.mkdirSync(path.join(root, 'checks'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  // the sealed test script resolves RELATIVE to its cwd — so a PASS only means
  // "ran inside this checkout" if the candidate's own files made it green.
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(
    { name, private: true, scripts: { test: 'node checks/verify.js' } }, null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'checks', 'verify.js'),
    "const fs = require('node:fs');\nprocess.exit(fs.readFileSync('marker.txt', 'utf8').includes('FAIL') ? 1 : 0);\n");
  fs.writeFileSync(path.join(root, 'marker.txt'), 'ok\n');
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'probe@canary.local');
  git(root, 'config', 'user.name', 'Canary Probe');
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'initial');
  const s = canary(['setup', '--yes', root], root);
  assert(s.status === 0, `setup failed: ${s.stdout}\n${s.stderr}`);
  // M10.1 (GLM F4 close): §10 at the candidate boundary no longer PROVES
  // completion without task-obligation authority — a taskless record with the
  // intent snapshot is NOT PROVEN (tooling/probes/m10-f4-bypass-repro.mjs
  // owns that law). Every candidate this probe passes is behavior-preserving
  // work under a sealed test plan, so REFACTOR is its honest description —
  // and registration adds only obligations this fixture already METS
  // (tests-green via the sealed 'test' step, coverage-loss via a resolvable
  // diff without deletions). It lifts no floor: block scenarios die before
  // the ladder and cannot be masked by a declaration.
  const t = canary(['task', 'behavior-preserving probe change', '--kind', 'refactor'], root);
  assert(t.status === 0, `task registration failed: ${t.stdout}\n${t.stderr}`);
  return root;
}
const candPath = (root, name, custom) => custom ?? path.join(root, '.canary', 'candidates', name);
const readRec = (root, name) => JSON.parse(fs.readFileSync(path.join(root, '.canary', 'candidates', `${name}.json`), 'utf8'));
const latestBundle = (root) => {
  const d = path.join(root, '.canary', 'evidence');
  const dirs = fs.readdirSync(d).filter((x) => x.endsWith('-candidate')).sort();
  assert(dirs.length > 0, 'no candidate bundle in base evidence');
  return JSON.parse(fs.readFileSync(path.join(d, dirs.at(-1), 'verification.json'), 'utf8'));
};
const baseStatus = (root) => git(root, 'status', '--porcelain');
const worktreePaths = (root) => git(root, 'worktree', 'list', '--porcelain').split(/\r?\n/)
  .filter((l) => l.startsWith('worktree ')).map((l) => l.slice('worktree '.length).trim());

try {
  // ================= the main story, on one repo =================
  const iso = makeRepo('iso');
  const H = git(iso, 'rev-parse', 'HEAD');
  const T = git(iso, 'rev-parse', 'HEAD^{tree}');
  const pristine = baseStatus(iso); // setup's own untracked .claude edit — isolate must not add to this
  const cand = candPath(iso, 'w1');

  check('isolate creates a detached worktree of the EXACT base commit; registry records it; base stays status-clean', () => {
    const r = canary(['isolate', 'w1', iso], iso);
    assertEq(r.status, 0, `isolate failed:\n${r.stdout}`);
    assertMatch(r.stdout, /isolated "w1"/, 'isolated line');
    assertEq(git(cand, 'rev-parse', 'HEAD'), H, 'candidate HEAD is not the base commit');
    assert(git(cand, 'status', '--porcelain') === '', 'fresh candidate worktree is not clean');
    const rec = readRec(iso, 'w1');
    assertEq(rec.baseHead, H, 'record baseHead'); assertEq(rec.baseTree, T, 'record baseTree');
    assertEq(rec.baseRef, 'HEAD', 'record baseRef'); assertEq(rec.root, cand, 'record root');
    assertEq(rec.baseRoot, path.resolve(iso), 'record baseRoot');
    assert(worktreePaths(iso).some((p) => path.resolve(p) === path.resolve(cand)), 'git does not list the new worktree');
    assertEq(baseStatus(iso), pristine, 'isolation dirtied the base worktree (self-ignore failure?)');
  });

  check('verify PASS: sealed plan ran INSIDE the candidate; evidence landed in the BASE; nothing applied', () => {
    const r = canary(['isolate', '--verify', 'w1', iso], iso);
    assertEq(r.status, 0, `verify failed:\n${r.stdout}`);
    assertMatch(r.stdout, /CANDIDATE PASS/, 'pass verdict');
    assertMatch(r.stdout, /ELIGIBLE for promotion.*nothing applied/, 'eligible-not-applied wording');
    const b = latestBundle(iso);
    assertEq(b.status, 'pass', 'bundle status');
    assertEq(b.source, 'candidate', 'bundle source');
    assertEq(b.trustClass, 'CANARY_OBSERVED', 'trust class');
    assertEq(b.steps.length, 1, 'plan step count');
    assertEq(b.steps[0].ok, true, 'step ok');
    assertEq(path.resolve(b.steps[0].cwd), path.resolve(cand), 'STEP RAN OUTSIDE THE CANDIDATE');
    assertEq(path.resolve(b.cwd), path.resolve(cand), 'bundle cwd must name the candidate');
    assertEq(b.candidate.head, H, 'bundle candidate identity');
    assertEq(b.candidate.dirty, false, 'clean candidate must read clean');
    assertEq(b.candidateName, 'w1', 'candidateName'); assertEq(b.candidateRoot, cand, 'candidateRoot');
    assertEq(b.isolatedFrom.head, H, 'isolatedFrom.head'); assertEq(b.isolatedFrom.tree, T, 'isolatedFrom.tree');
    const cfg = JSON.parse(fs.readFileSync(path.join(iso, '.canary', 'canary.local.json'), 'utf8'));
    assertEq(b.provenance.planDigest, cfg.planAuthority.planDigest, 'bundle plan digest must equal the SEAL digest');
    assertEq(b.provenance.baseline.head, H, 'provenance baseline');
    assertEq(git(iso, 'rev-parse', 'HEAD'), H, 'base HEAD moved — a PASS must apply nothing');
    assertEq(baseStatus(iso), pristine, 'verify dirtied the base beyond isolation state');
    assert(!fs.existsSync(path.join(cand, '.canary')), 'evidence must never land inside the candidate tree');
  });

  check('a committed failing change in the candidate FAILS verification; base byte-identical', () => {
    fs.writeFileSync(path.join(cand, 'marker.txt'), 'FAIL\n');
    git(cand, 'add', '-A'); git(cand, 'commit', '-m', 'break it');
    const r = canary(['isolate', '--verify', 'w1', iso], iso);
    assertEq(r.status, 2, `failing verify must exit 2:\n${r.stdout}`);
    assertMatch(r.stdout, /CANDIDATE FAIL/, 'fail verdict');
    assertMatch(r.stdout, /trusted base was not touched/, 'fail wording');
    const b = latestBundle(iso);
    assertEq(b.status, 'fail', 'bundle status');
    assertEq(b.steps[0].ok, false, 'failing step recorded failing');
    assertEq(git(iso, 'rev-parse', 'HEAD'), H, 'base HEAD moved on FAIL');
    assertEq(baseStatus(iso), pristine, 'FAIL touched the base worktree');
  });

  check('worker repairs inside the candidate; verification PASSes again (fail → repair → PASS loop)', () => {
    fs.writeFileSync(path.join(cand, 'marker.txt'), 'ok\n');
    git(cand, 'add', '-A'); git(cand, 'commit', '-m', 'fix it');
    const r = canary(['isolate', '--verify', 'w1', iso], iso);
    assertEq(r.status, 0, `repaired verify failed:\n${r.stdout}`);
    assertMatch(r.stdout, /CANDIDATE PASS/, 'repaired pass');
    assertEq(baseStatus(iso), pristine, 'repair cycle touched the base');
  });

  check('swapping the sealed script BLOCKS BEFORE EXECUTION — the replacement never ran', () => {
    fs.rmSync(SWAP_RAN, { force: true });
    const pkgPath = path.join(cand, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    // exits 0 — a swapped-in hollow green check; argv carries the probe-scoped
    // marker path (this text never executes — the drift gate blocks first,
    // which is exactly what the marker-absence assertion below proves).
    pkg.scripts.test = `node "${MARKER_FIXTURE}" "${SWAP_RAN}"`;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    const r = canary(['isolate', '--verify', 'w1', iso], iso);
    assertEq(r.status, 2, `drifted candidate must block:\n${r.stdout}`);
    assertMatch(r.stdout, /BLOCKED/, 'blocked verdict');
    assertMatch(r.stdout, /changed since setup sealed it/, 'drift reason');
    assert(!fs.existsSync(SWAP_RAN), 'THE SWAPPED SCRIPT EXECUTED — the seal gate leaked');
    const b = latestBundle(iso);
    assertEq(b.status, 'blocked', 'bundle status');
    assertEq(b.steps.length, 0, 'a block is not an execution');
    // positive control: the marker fixture DOES write when run — proving the
    // absence above is evidence, not a dead check.
    const pc = spawnSync(process.execPath, [MARKER_FIXTURE, SWAP_RAN], { timeout: 30_000 });
    assertEq(pc.status, 0, 'positive control: fixture did not exit 0');
    assert(fs.existsSync(SWAP_RAN), 'positive control: marker fixture wrote nothing');
    fs.rmSync(SWAP_RAN, { force: true });
    // the NEXT ACTION Canary itself suggests restores authority — dogfood it
    git(cand, 'checkout', '--', 'package.json');
    const r2 = canary(['isolate', '--verify', 'w1', iso], iso);
    assertEq(r2.status, 0, `restore-then-verify failed:\n${r2.stdout}`);
    assertMatch(r2.stdout, /CANDIDATE PASS/, 'block is not a grudge — restored authority passes');
  });

  check('committed advancement is visible: list says ADVANCED, PASS names the commit count', () => {
    fs.writeFileSync(path.join(cand, 'docs.txt'), 'worker notes\n');
    git(cand, 'add', '-A'); git(cand, 'commit', '-m', 'docs');
    const l = canary(['isolate', '--list', iso], iso);
    assertEq(l.status, 0, l.stdout);
    assertMatch(l.stdout, /w1\s+ADVANCED/, `list status:\n${l.stdout}`);
    const r = canary(['isolate', '--verify', 'w1', iso], iso);
    assertEq(r.status, 0, r.stdout);
    assertMatch(r.stdout, /\(3 commit\(s\) beyond the isolated base\)/, 'advance count (break + fix + docs)');
    assertEq(baseStatus(iso), pristine, 'advancing base status');
  });

  check('worker-added pretest hook around a sealed step BLOCKS before execution — hooks live outside the seal', () => {
    const pkgPath = path.join(cand, 'package.json');
    const before = fs.readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(before);
    pkg.scripts.pretest = 'echo PRETEST-MUST-NEVER-RUN'; // the sealed "test" TEXT is untouched — drift cannot see a sibling key
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    const r = canary(['isolate', '--verify', 'w1', iso], iso);
    assertEq(r.status, 2, `lifecycle-hooked candidate must block:\n${r.stdout}`);
    assertMatch(r.stdout, /lifecycle hook/, 'names the lifecycle gate');
    assertMatch(r.stdout, /pretest/, 'names the offending hook');
    assert(!/PRETEST-MUST-NEVER-RUN/.test(r.stdout), 'the plan output shows the lifecycle hook actually ran');
    const b = latestBundle(iso);
    assertEq(b.status, 'blocked', 'lifecycle bundle blocked');
    assertEq(b.steps.length, 0, 'a lifecycle block is not an execution — neither the hook nor the sealed step ran');
    fs.writeFileSync(pkgPath, before); // byte-exact restore: authority is the seal, not Canary's memory
    const r2 = canary(['isolate', '--verify', 'w1', iso], iso);
    assertEq(r2.status, 0, `after removing the hook, verify must pass again:\n${r2.stdout}`);
  });

  check('candidate-side .npmrc ABSENT from the base BLOCKS (flags outside the seal)', () => {
    const npmrc = path.join(cand, '.npmrc');
    fs.writeFileSync(npmrc, 'registry=https://registry.invalid\n'); // untracked — git diff alone would never see it
    const r = canary(['isolate', '--verify', 'w1', iso], iso);
    assertEq(r.status, 2, `candidate .npmrc must block:\n${r.stdout}`);
    assertMatch(r.stdout, /\.npmrc exists in the candidate but not in the isolated base/, 'absence-from-base reason');
    const b = latestBundle(iso);
    assertEq(b.status, 'blocked', 'npmrc bundle blocked');
    assertEq(b.steps.length, 0, 'an npmrc block ran nothing — its flags never reached a package manager');
    fs.rmSync(npmrc);
    const r2 = canary(['isolate', '--verify', 'w1', iso], iso);
    assertEq(r2.status, 0, `after deleting it, verify must pass again:\n${r2.stdout}`);
  });

  check('dirty base: honest note, candidate holds the COMMITTED base only, stray work untouched; duplicate name refused', () => {
    const db = makeRepo('dbase');
    fs.writeFileSync(path.join(db, 'stray.txt'), 'human work in progress\n'); // never committed
    const r = canary(['isolate', 'w4', db], db);
    assertEq(r.status, 0, r.stdout);
    assertMatch(r.stdout, /base tree is dirty.*not in it/, 'dirty-base note');
    const c4 = candPath(db, 'w4');
    assert(!fs.existsSync(path.join(c4, 'stray.txt')), 'uncommitted base work leaked into the candidate');
    assert(fs.existsSync(path.join(db, 'stray.txt')), 'isolation destroyed/absorbed the base\'s stray work');
    assertMatch(baseStatus(db), /\?\? stray\.txt/, 'base stray still shows (untouched)');
    const dup = canary(['isolate', 'w4', db], db);
    assertEq(dup.status, 2, 'duplicate name must refuse');
    assertMatch(dup.stdout, /already registered/, 'duplicate wording');
    fs.rmSync(path.join(db, 'stray.txt'));
  });

  check('spaces and Unicode in --path work for create and verify (argv plumbing, no shell round-trip)', () => {
    const uni = makeRepo('uni');
    const pristineU = baseStatus(uni);
    const custom = '.canary/candidates/ünï c1 ✓'; // spaces + non-ASCII; kept off CJK to dodge console code-page noise only
    const r = canary(['isolate', 'u1', '--path', custom, uni], uni);
    assertEq(r.status, 0, `unicode --path isolate failed:\n${r.stdout}`);
    const cpath = candPath(uni, null, path.resolve(uni, custom));
    assert(fs.existsSync(cpath), 'unicode candidate dir missing');
    assertEq(git(cpath, 'rev-parse', 'HEAD'), git(uni, 'rev-parse', 'HEAD'), 'unicode candidate not bound to base commit');
    const v = canary(['isolate', '--verify', 'u1', uni], uni);
    assertEq(v.status, 0, `unicode candidate verify failed:\n${v.stdout}`);
    assertMatch(v.stdout, /CANDIDATE PASS/, 'unicode pass');
    assertEq(baseStatus(uni), pristineU, 'unicode isolation/verify dirtied the base');
  });

  check('remove refuses a dirty candidate without --discard; --discard removes exactly worktree + record', () => {
    const uni = path.join(TMP, 'uni');
    const cpath = candPath(uni, null, path.resolve(uni, '.canary/candidates/ünï c1 ✓'));
    fs.writeFileSync(path.join(cpath, 'scratch.txt'), 'uncommitted worker scratch\n');
    const head = git(uni, 'rev-parse', 'HEAD');
    const r = canary(['isolate', '--remove', 'u1', uni], uni);
    assertEq(r.status, 2, `dirty remove must refuse:\n${r.stdout}`);
    assertMatch(r.stdout, /uncommitted work.*--discard/s, 'refusal wording');
    assert(fs.existsSync(path.join(uni, '.canary', 'candidates', 'u1.json')), 'refusal must keep the record');
    assert(fs.existsSync(cpath), 'refusal must keep the worktree');
    const d = canary(['isolate', '--remove', 'u1', '--discard', uni], uni);
    assertEq(d.status, 0, `discard remove failed:\n${d.stdout}`);
    assertMatch(d.stdout, /REMOVED "u1"/, 'removed wording');
    assert(!fs.existsSync(path.join(uni, '.canary', 'candidates', 'u1.json')), 'record survives');
    assert(!fs.existsSync(cpath), 'worktree dir survives');
    assert(!worktreePaths(uni).some((p) => path.resolve(p) === path.resolve(cpath)), 'git still lists the removed worktree');
    assertEq(git(uni, 'rev-parse', 'HEAD'), head, 'base HEAD moved during cleanup');
  });

  check('vanished candidate (crash/deleted dir): list LOST, verify blocks honestly, remove prunes the stale registration', () => {
    const r0 = canary(['isolate', 'wlost', iso], iso);
    assertEq(r0.status, 0, r0.stdout);
    const gone = candPath(iso, 'wlost');
    fs.rmSync(gone, { recursive: true, force: true }); // simulate the interrupted/deleted session
    const l = canary(['isolate', '--list', iso], iso);
    assertMatch(l.stdout, /wlost\s+LOST/, `list must say LOST:\n${l.stdout}`);
    const v = canary(['isolate', '--verify', 'wlost', iso], iso);
    assertEq(v.status, 2, 'LOST verify must block');
    assertMatch(v.stdout, /BLOCKED/, 'LOST blocked');
    assertMatch(v.stdout, /not a resolvable git tree/, 'LOST reason');
    const b = latestBundle(iso);
    assertEq(b.status, 'blocked', 'LOST bundle blocked');
    assertEq(b.steps.length, 0, 'LOST ran nothing');
    const rm = canary(['isolate', '--remove', 'wlost', iso], iso);
    assertEq(rm.status, 0, `prune remove failed:\n${rm.stdout}`);
    assertMatch(rm.stdout, /pruned stale registration/, 'honest prune wording');
    assert(!fs.existsSync(path.join(iso, '.canary', 'candidates', 'wlost.json')), 'stale record survives prune');
    assert(!worktreePaths(iso).some((p) => path.resolve(p) === path.resolve(gone)), 'git still lists the pruned worktree');
  });

  check('a forged record pointing at an UNRELATED real repo is caught by git-common-dir binding; that repo is untouched', () => {
    const other = path.join(TMP, 'elsewhere');
    fs.mkdirSync(other);
    git(other, 'init', '-b', 'main'); git(other, 'config', 'user.email', 'x@y.z'); git(other, 'config', 'user.name', 'x');
    fs.writeFileSync(path.join(other, 'a.txt'), 'someone else\'s repo\n');
    git(other, 'add', '-A'); git(other, 'commit', '-m', 'theirs');
    const otherHeadBefore = git(other, 'rev-parse', 'HEAD');
    const otherStatusBefore = baseStatus(other);
    fs.writeFileSync(path.join(iso, '.canary', 'candidates', 'forged.json'), JSON.stringify({
      schema: 'canary-candidate/1', name: 'forged', root: other, baseRoot: path.resolve(iso),
      baseRef: 'HEAD', baseHead: 'a'.repeat(40), baseTree: null, createdAt: new Date().toISOString(),
    }, null, 2));
    const l = canary(['isolate', '--list', iso], iso);
    assertMatch(l.stdout, /forged\s+IMPOSTOR/, `list must say IMPOSTOR:\n${l.stdout}`);
    const v = canary(['isolate', '--verify', 'forged', iso], iso);
    assertEq(v.status, 2, 'impostor must block');
    assertMatch(v.stdout, /does not share this repo's git store/, 'impostor reason');
    const b = latestBundle(iso);
    assertEq(b.status, 'blocked', 'impostor bundle blocked');
    assertEq(b.steps.length, 0, 'impostor ran nothing — not the plan, not the victim repo\'s scripts');
    assertEq(git(other, 'rev-parse', 'HEAD'), otherHeadBefore, 'the victim repo HEAD moved');
    assertEq(baseStatus(other), otherStatusBefore, 'the victim repo worktree changed');
    assert(!fs.existsSync(path.join(other, '.canary')), 'a bundle must not land in the victim repo');
    fs.rmSync(path.join(iso, '.canary', 'candidates', 'forged.json'));
  });

  check('unregistered worktrees are reported and NEVER touched (user work, not Canary\'s)', () => {
    const manual = path.join(iso, '.canary', 'candidates', 'manual');
    git(iso, 'worktree', 'add', '--detach', manual, H); // plain git, no registry
    const l = canary(['isolate', '--list', iso], iso);
    assertEq(l.status, 0, l.stdout);
    assertMatch(l.stdout, /UNREGISTERED/, 'unregistered line');
    assert(!/^w1\b.*UNREGISTERED/m.test(l.stdout), 'a registered candidate must never ALSO be listed UNREGISTERED (core.quotepath regression)');
    assertMatch(l.stdout, /manual.*left alone/, `report-only wording:\n${l.stdout}`);
    const rm = canary(['isolate', '--remove', 'manual', iso], iso);
    assertEq(rm.status, 2, 'removing an unregistered name must refuse');
    assertMatch(rm.stdout, /no candidate "manual" registered/, 'refuse wording');
    assert(fs.existsSync(manual), 'Canary touched a worktree it never created');
    assert(worktreePaths(iso).some((p) => path.resolve(p) === path.resolve(manual)), 'git lost the user worktree');
    git(iso, 'worktree', 'remove', '--force', manual); // probe cleans up its own prop
  });

  check('a COMMITTED gitlink blocks as submodule even with NO .gitmodules — the old existence gate was blind to this', () => {
    const gl = makeRepo('glint');
    assertEq(canary(['isolate', 'g1', gl], gl).status, 0);
    const c = candPath(gl, 'g1');
    git(c, 'update-index', '--add', '--cacheinfo', `160000,${'f'.repeat(40)},sub`); // dangling sha: git commits it unchecked, offline
    git(c, 'commit', '-m', 'gitlink only, no .gitmodules');
    assert(!fs.existsSync(path.join(c, '.gitmodules')), 'this IS the bypass: gitlink without .gitmodules hides from any existence check');
    const r = canary(['isolate', '--verify', 'g1', gl], gl);
    assertEq(r.status, 2, `gitlink candidate must block:\n${r.stdout}`);
    assertMatch(r.stdout, /git submodules/, 'gitlink reason');
    const b = latestBundle(gl);
    assertEq(b.status, 'blocked', 'gitlink bundle blocked');
    assertEq(b.steps.length, 0, 'a submodule block ran nothing');
    git(c, 'rm', '-r', '--cached', 'sub');
    git(c, 'commit', '-m', 'drop the gitlink');
    const r2 = canary(['isolate', '--verify', 'g1', gl], gl);
    assertEq(r2.status, 0, `after dropping the gitlink, verify must pass:\n${r2.stdout}`);
    assertMatch(r2.stdout, /CANDIDATE PASS/, 'the gitlink gate holds no grudge');
    const rm = canary(['isolate', '--remove', 'g1', gl], gl); // CLEAN tree, no --discard: the plain remove branch
    assertEq(rm.status, 0, `clean remove failed:\n${rm.stdout}`);
    assert(!fs.existsSync(path.join(gl, '.canary', 'candidates', 'g1.json')), 'record survives clean remove');
  });

  check('.npmrc IDENTICAL to base passes; CHANGED in the candidate blocks; checkout restores', () => {
    const np = makeRepo('np');
    fs.writeFileSync(path.join(np, '.npmrc'), 'save-exact=true\n');
    git(np, 'add', '.npmrc'); git(np, 'commit', '-m', 'npmrc lives in the base'); // setup's seal covers plan scripts, not this
    assertEq(canary(['isolate', 'n1', np], np).status, 0);
    const c = candPath(np, 'n1');
    const v0 = canary(['isolate', '--verify', 'n1', np], np);
    assertEq(v0.status, 0, `base-inherited identical .npmrc must pass:\n${v0.stdout}`);
    fs.writeFileSync(path.join(c, '.npmrc'), 'registry=https://registry.invalid\n');
    const r = canary(['isolate', '--verify', 'n1', np], np);
    assertEq(r.status, 2, `changed .npmrc must block:\n${r.stdout}`);
    assertMatch(r.stdout, /\.npmrc changed in the candidate vs the isolated base/, 'change-vs-base reason');
    assertMatch(r.stdout, /checkout -- \.npmrc/, 'next action offers the exact restore');
    const b = latestBundle(np);
    assertEq(b.status, 'blocked', 'npmrc-change bundle blocked');
    assertEq(b.steps.length, 0, 'changed-npmrc block ran nothing');
    git(c, 'checkout', '--', '.npmrc');
    const v1 = canary(['isolate', '--verify', 'n1', np], np);
    assertEq(v1.status, 0, `restored .npmrc must pass again:\n${v1.stdout}`);
  });

  check('EMPTY on-disk plan blocks honestly — no plan, no fake green (pre-M5-shaped hand edit)', () => {
    const ep = makeRepo('eplan');
    const cfgPath = path.join(ep, '.canary', 'canary.local.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.plan = []; delete cfg.planAuthority;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
    assertEq(canary(['isolate', 'e1', ep], ep).status, 0, 'an empty plan may still be isolated — the block belongs to verification');
    const r = canary(['isolate', '--verify', 'e1', ep], ep);
    assertEq(r.status, 2, `empty plan must block verify:\n${r.stdout}`);
    assertMatch(r.stdout, /verification plan is empty/, 'empty-plan reason');
    const b = latestBundle(ep);
    assertEq(b.status, 'blocked', 'empty-plan bundle blocked');
    assertEq(b.steps.length, 0, 'empty plan ran nothing (there was nothing to run)');
  });

  check('--path OUTSIDE the base: registers, verifies, and CLEAN-removes (record dir created on demand)', () => {
    const xd = makeRepo('xdir');
    const target = path.join(TMP, 'xdir-outside'); // sibling of the base, never under it
    const r0 = canary(['isolate', 'x1', '--path', target, xd], xd);
    assertEq(r0.status, 0, `outside-base isolate failed:\n${r0.stdout}`);
    assertEq(readRec(xd, 'x1').root, path.resolve(target), 'record root points at the custom path');
    const v = canary(['isolate', '--verify', 'x1', xd], xd);
    assertEq(v.status, 0, `outside-base verify failed:\n${v.stdout}`);
    assertMatch(v.stdout, /CANDIDATE PASS/, 'outside-base pass');
    const b = latestBundle(xd);
    assertEq(path.resolve(b.steps[0].cwd), path.resolve(target), 'the step ran in the OUTSIDE-base candidate');
    assertEq(path.resolve(b.cwd), path.resolve(target), 'bundle cwd names the outside-base candidate');
    assert(!fs.existsSync(path.join(target, '.canary')), 'evidence must land in the BASE even for an outside candidate');
    const rm = canary(['isolate', '--remove', 'x1', xd], xd);
    assertEq(rm.status, 0, `clean outside-base remove failed:\n${rm.stdout}`);
    assertMatch(rm.stdout, /REMOVED "x1"/, 'remove wording (tree was resolved — no prune note)');
    assert(!fs.existsSync(target), 'worktree dir survives clean remove');
    assert(!fs.existsSync(path.join(xd, '.canary', 'candidates', 'x1.json')), 'record survives remove');
  });

  check('whole story end-state: base identity unchanged, registry holds only w1, no stray evidence in candidates', () => {
    assertEq(git(iso, 'rev-parse', 'HEAD'), H, 'base HEAD at end of story');
    assertEq(baseStatus(iso), pristine, 'base worktree at end of story');
    const regs = fs.readdirSync(path.join(iso, '.canary', 'candidates')).filter((f) => f.endsWith('.json'));
    assertEq(regs.join(','), 'w1.json', 'registry contents');
    assertEq(fs.existsSync(path.join(cand, '.canary')), false, 'candidate never grew its own .canary');
  });
} finally {
  fs.rmSync(SWAP_RAN, { force: true });
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 4 });
}

console.log(failures === 0
  ? 'M7 candidate-isolation: ALL PASS'
  : `M7 candidate-isolation: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
