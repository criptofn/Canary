#!/usr/bin/env node
/**
 * M8 real-git promotion probe — NO PASS, NO APPLY end to end.
 *
 * Authority model (the whole point): `isolate --promote` RE-RUNS the complete
 * sealed-plan verification live and only then applies the exact commit that
 * just passed, via `git merge --ff-only` into a checked-out branch of the base.
 * Stored evidence bundles are never read back (M2 doctrine preserved) — so
 * stale-replay, evidence-for-A-used-for-B, and evidence-tampering attacks are
 * decision-inert by structure, and this probe PROVES that instead of asserting
 * it. Post-promotion proof: the base tree sha must equal the tree sha of the
 * commit that just passed the plan — what lands is content-addressed to the
 * bytes that were verified, not a claim about them.
 *
 * Proven here on real git: happy apply + idempotent re-apply; divergence
 * refusal (case O) with the base byte-identical; TRACKED-dirty base refusal
 * (untracked strays do NOT block — setup itself leaves one — while an
 * untracked COLLISION is refused by git's own ff-merge guard, proven too);
 * detached-base refusal; the mid-plan commit attack caught by the identity
 * sandwich (HEAD moved during verification) with honest recovery on re-run;
 * dirty-candidate refusal; forged stale PASS bundle and A-evidence-for-B both
 * inert; candidate-planted canary config / fake-git shim inert; malformed
 * record refusal; and candidate code WRITING into the base evidence dir
 * mid-plan changes no decision (the write itself is prevented by M9, not by
 * this layer — recorded honestly as a behavioral fact).
 * NOT mutated in the m8 battery / not probe-testable: an edit that lands and
 * reverts strictly INSIDE a single plan run (a single-threaded sandwich
 * cannot witness it; the fresh bundle's captured step outputs are the
 * human-visible record). NO PROOF, NO DONE.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const CLI = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}\n     ${String(e.message ?? e).split('\n').join('\n     ')}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertMatch(hay, re, msg) { assert(re.test(hay), `${msg}\n     expected /${re}/ in:\n     ${hay.split('\n').slice(0, 20).join('\n     ')}`); }
function assertEq(actual, expected, msg) { assert(actual === expected, `${msg}\n     expected: ${JSON.stringify(expected)}\n     actual:   ${JSON.stringify(actual)}`); }

assert(fs.existsSync(CLI), `missing built CLI (run npm run build): ${CLI}`);
{
  const gv = spawnSync('git', ['--version'], { encoding: 'utf8', timeout: 15_000 });
  assert(gv.status === 0, `git not runnable: ${gv.error?.message ?? gv.status}`);
  const m = /git version (\d+)\.(\d+)/.exec(gv.stdout);
  assert(m && Number(m[1]) * 100 + Number(m[2]) >= 230, `git too old for worktree plumbing used by promotion: ${gv.stdout.trim()}`);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-m8-probe-'));

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
  return root;
}
const candPath = (root, name) => path.join(root, '.canary', 'candidates', name);
function bundles(root, suffix) {
  const d = path.join(root, '.canary', 'evidence');
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((x) => x.endsWith(suffix)).sort()
    .map((x) => JSON.parse(fs.readFileSync(path.join(d, x, 'verification.json'), 'utf8')));
}
const latestPromotion = (root) => { const bs = bundles(root, '-promotion'); assert(bs.length > 0, 'no promotion bundle in base evidence'); return bs.at(-1); };
const promotionCount = (root) => bundles(root, '-promotion').length;
const acceptedPromotions = (root) => bundles(root, '-promotion').filter((b) => b.status === 'accepted').length;
function fingerprint(root) {
  // everything an apply act could touch in the base: the branch pointer, its
  // tree, and the TRACKED working state (setup leaves untracked strays by
  // design, so tracked-only is the honest "base content" fingerprint).
  return {
    head: git(root, 'rev-parse', 'HEAD'),
    tree: git(root, 'rev-parse', 'HEAD^{tree}'),
    tracked: git(root, 'status', '--porcelain', '--untracked-files=no'),
    full: git(root, 'status', '--porcelain'),
  };
}
function assertFpSame(a, b, msg) {
  assertEq(a.head, b.head, `${msg} — HEAD`); assertEq(a.tree, b.tree, `${msg} — tree`);
  assertEq(a.tracked, b.tracked, `${msg} — tracked state`); assertEq(a.full, b.full, `${msg} — full status`);
}
// worker: make an honest ADVANCEMENT commit inside a candidate (clean, ahead of base)
function advance(root, name, fname) {
  const c = candPath(root, name);
  fs.writeFileSync(path.join(c, fname ?? 'work.txt'), `worker work in ${name}\n`);
  git(c, 'add', '-A');
  git(c, 'commit', '-m', 'worker work');
  return git(c, 'rev-parse', 'HEAD');
}

try {
  // ================= C1: the happy act, on one repo =================
  const iso = makeRepo('happy');
  check('promote of a verified, advanced candidate fast-forwards the branch; post-proof binds tree identity; ACCEPTED', () => {
    assertEq(canary(['isolate', 'w1', iso], iso).status, 0);
    const H = git(iso, 'rev-parse', 'HEAD');
    const C = advance(iso, 'w1');
    const fp = fingerprint(iso);
    const r = canary(['isolate', '--promote', 'w1', iso], iso);
    assertEq(r.status, 0, `promote failed:\n${r.stdout}`);
    assertMatch(r.stdout, /CANDIDATE PASS/, 'the LIVE re-verification ran first');
    assertMatch(r.stdout, /PROMOTED "w1"/, 'promotion line');
    assertMatch(r.stdout, /main fast-forwarded/, 'names the branch and the act');
    assertMatch(r.stdout, /ACCEPTED/, 'post-promotion proof verdict');
    assertEq(git(iso, 'rev-parse', 'HEAD'), C, 'base branch did not land on the verified commit');
    assertEq(git(iso, 'rev-parse', 'HEAD^{tree}'), git(iso, 'rev-parse', `${C}^{tree}`), 'base tree is not the verified tree');
    assertEq(git(iso, 'status', '--porcelain', '--untracked-files=no'), '', 'apply left tracked base state dirty');
    assertEq(fs.readFileSync(path.join(iso, 'work.txt'), 'utf8').replace(/\r\n/g, '\n'), 'worker work in w1\n', 'applied bytes are not the worker\'s (newline-normalized: host core.autocrlf converts on checkout)');
    const b = latestPromotion(iso);
    assertEq(b.status, 'accepted', 'promotion bundle status');
    assertEq(b.trustClass, 'CANARY_OBSERVED', 'promotion bundle trust class');
    assertEq(b.source, 'promotion', 'bundle source');
    assertEq(b.promotion.branch, 'refs/heads/main', 'bundle names the branch');
    assertEq(b.promotion.from, H, 'bundle names where the branch was');
    assertEq(b.promotion.to, C, 'bundle names what was applied');
    assertEq(b.promotion.tree, git(iso, 'rev-parse', `${C}^{tree}`), 'bundle names the applied tree');
    assertEq(fp.tree !== b.promotion.tree, true, 'this promote was a real move, not a no-op');
    assertEq(b.candidateName, 'w1', 'bundle names the candidate');
    assertEq(b.steps.length, 1, 'the promotion bundle carries exactly the apply step');
    assertEq(b.steps[0].kind, 'promotion', 'apply step is plainly labeled');
    assertEq(b.steps[0].ok, true, 'apply step ok');
    assertEq(b.provenance.planDigest.length, 64, 'bundle binds the sealed plan digest');
    assert(fs.existsSync(path.join(iso, '.canary', 'candidates', 'w1.json')), 'record must survive promotion (cleanup is --remove)');
  });

  check('re-promote is idempotent and honest: ALREADY APPLIED, no second act, base untouched', () => {
    const C = git(iso, 'rev-parse', 'HEAD');
    const fp = fingerprint(iso);
    const n0 = promotionCount(iso);
    const r = canary(['isolate', '--promote', 'w1', iso], iso);
    assertEq(r.status, 0, `re-promote failed:\n${r.stdout}`);
    assertMatch(r.stdout, /ALREADY APPLIED/, 'idempotency wording');
    assertMatch(r.stdout, /ACCEPTED/, 'still says ACCEPTED because the identity proof holds');
    assertFpSame(fingerprint(iso), fp, 're-promote touched the base');
    assertEq(git(iso, 'rev-parse', 'HEAD'), C, 'branch moved on a no-op promote');
    assertEq(promotionCount(iso), n0 + 1, 'the no-op wrote no promotion evidence');
    const b = latestPromotion(iso);
    assertEq(b.promotion.from, C, 'idempotent bundle: from === to === applied commit');
    assertEq(b.promotion.to, C, 'idempotent bundle to');
    assertEq(b.promotion.idempotent, true, 'honestly flagged as a no-op act');
    assertEq(b.steps.length, 0, 'no apply step in an idempotent accept');
  });

  check('promote removes nothing and leaves the candidate honest in list (promotion != cleanup)', () => {
    assert(fs.existsSync(candPath(iso, 'w1')), 'promotion deleted the candidate worktree');
    assertEq(canary(['isolate', '--list', iso], iso).stdout.match(/w1\s+(\S+)/)[1], 'ADVANCED',
      'promoted candidate lists ADVANCED (its head is ahead of the record baseHead — cleanup is a human act)');
  });

  // ================= refusals: the base must end byte-identical =================
  check('divergence (case O): base moved past the candidate → REFUSED, base byte-identical, blocked promotion bundle', () => {
    const dv = makeRepo('diverge');
    assertEq(canary(['isolate', 'd1', dv], dv).status, 0);
    const C = advance(dv, 'd1');
    fs.appendFileSync(path.join(dv, 'marker.txt'), 'base edit\n'); // the human moves forward too
    git(dv, 'add', '-A'); git(dv, 'commit', '-m', 'human work');
    const B1 = git(dv, 'rev-parse', 'HEAD');
    const fp = fingerprint(dv);
    const r = canary(['isolate', '--promote', 'd1', dv], dv);
    assertEq(r.status, 2, `diverged promotion must refuse:\n${r.stdout}`);
    assertMatch(r.stdout, /REFUSED/, 'refusal verdict');
    assertMatch(r.stdout, /fast-forward/, 'names the mechanism that refused');
    assertMatch(r.stdout, /nothing was applied/, 'honest nothing-applied note');
    assert(!/PROMOTED/.test(r.stdout), 'said PROMOTED while refusing');
    assertFpSame(fingerprint(dv), fp, 'refusal touched the base');
    assert(git(dv, 'rev-parse', 'HEAD') === B1 && B1 !== C, 'branch moved anyway');
    assertEq(git(candPath(dv, 'd1'), 'rev-parse', 'HEAD'), C, 'candidate moved');
    const b = latestPromotion(dv);
    assertEq(b.status, 'blocked', 'refusal is evidence: a blocked promotion bundle');
    assertEq(b.promotion.to, C, 'the blocked bundle names what it refused to apply');
    assertEq(b.promotion.from, B1, 'and where the branch actually sat');
    assertEq(b.promotion.branch, 'refs/heads/main', 'and on which branch');
    // pin WHY it refused: git's own refusal is the reason — not the post-proof
    // "applied but unproven" arm (a refusal must never record applied:true for
    // a merge that never happened; mutation battery gate 7 caught this exactly)
    assertMatch(b.promotion.refusal, /git refused the fast-forward/, 'the refusal names git\'s refusal as the reason');
    assert(b.promotion.applied === undefined, 'a refused promotion must not claim applied:true');
  });

  check('TRACKED-dirty trusted base (concurrent user edit): REFUSED before any apply; the edit is byte-preserved', () => {
    const db = makeRepo('dirtybase');
    assertEq(canary(['isolate', 'b1', db], db).status, 0);
    advance(db, 'b1');
    fs.appendFileSync(path.join(db, 'marker.txt'), 'human mid-edit\n'); // TRACKED change
    const fp = fingerprint(db);
    const r = canary(['isolate', '--promote', 'b1', db], db);
    assertEq(r.status, 2, `dirty base must refuse promotion:\n${r.stdout}`);
    assertMatch(r.stdout, /REFUSED/, 'refusal');
    assertMatch(r.stdout, /UNCOMMITTED tracked changes/, 'reason names the dirty base');
    assertFpSame(fingerprint(db), fp, 'refusal touched the base');
    assertEq(fs.readFileSync(path.join(db, 'marker.txt'), 'utf8').endsWith('human mid-edit\n'), true, 'the user edit was consumed');
    assertEq(latestPromotion(db).status, 'blocked', 'dirty-base refusal is evidenced');
  });

  check('UNTRACKED base stray is NOT base-dirt (design: setup itself leaves strays) but an untracked COLLISION is refused by git itself', () => {
    const cb = makeRepo('collide');
    assertEq(canary(['isolate', 'c9', cb], cb).status, 0);
    advance(cb, 'c9'); // candidate COMMIT adds work.txt
    fs.writeFileSync(path.join(cb, 'work.txt'), 'mine, untracked\n'); // base keeps one with the same name
    const fp = fingerprint(cb);
    const r = canary(['isolate', '--promote', 'c9', cb], cb);
    assertEq(r.status, 2, `collision must refuse:\n${r.stdout}`);
    assertMatch(r.stdout, /REFUSED/, 'refusal verdict (the gate passed; GIT refused the merge)');
    assertMatch(r.stdout, /[Uu]ntracked.*overwritten|overwritten/, 'git collision message surfaced honestly');
    assertFpSame(fingerprint(cb), fp, 'collision refusal touched the base');
    assertEq(fs.readFileSync(path.join(cb, 'work.txt'), 'utf8'), 'mine, untracked\n', 'the human stray was not clobbered');
    assertEq(latestPromotion(cb).status, 'blocked', 'collision refusal evidenced');
  });

  check('detached trusted base: REFUSED — promotion fast-forwards a BRANCH, never a detached pointer', () => {
    const dt = makeRepo('detached');
    const H = git(dt, 'rev-parse', 'HEAD');
    assertEq(canary(['isolate', 't1', dt], dt).status, 0);
    advance(dt, 't1');
    git(dt, 'checkout', '--detach', H);
    const r = canary(['isolate', '--promote', 't1', dt], dt);
    assertEq(r.status, 2, `detached base must refuse:\n${r.stdout}`);
    assertMatch(r.stdout, /detached/, 'reason');
    assertEq(git(dt, 'rev-parse', 'HEAD'), H, 'detached HEAD was moved anyway');
    assertEq(latestPromotion(dt).status, 'blocked', 'detached refusal evidenced');
  });

  check('mid-plan commit attack: candidate HEAD moved during verification → REFUSED (sandwich), honest recovery on re-run', () => {
    const mp = makeRepo('midplan');
    assertEq(canary(['isolate', 's1', mp], mp).status, 0);
    const c = candPath(mp, 's1');
    fs.writeFileSync(path.join(c, 'marker.txt'), 'FAIL\n'); // committed red
    git(c, 'add', '-A'); git(c, 'commit', '-m', 'red');
    // the sealed step turns green AND commits while running — the sandwich must
    // notice the head moved between the identity read at verify start and the
    // identity read before apply: the bytes that passed are not a stable commit.
    fs.writeFileSync(path.join(c, 'checks', 'verify.js'),
      "const fs=require('node:fs');const {execSync}=require('node:child_process');\n" +
      "if(fs.readFileSync('marker.txt','utf8').includes('FAIL')){fs.writeFileSync('marker.txt','ok\\n');execSync('git add -A && git commit -m midplan-fix',{stdio:'ignore'});}\n" +
      'process.exit(0);\n');
    git(c, 'add', '-A'); git(c, 'commit', '-m', 'step commits mid-run');
    const fp = fingerprint(mp);
    const r1 = canary(['isolate', '--promote', 's1', mp], mp);
    assertEq(r1.status, 2, `mid-plan moved head must refuse:\n${r1.stdout}`);
    assertMatch(r1.stdout, /CANDIDATE PASS/, 'the live plan did go green');
    assertMatch(r1.stdout, /HEAD moved during verification/, 'the sandwich caught the mid-plan commit');
    assertFpSame(fingerprint(mp), fp, 'sandwich refusal touched the base');
    const b1 = latestPromotion(mp);
    assertEq(b1.status, 'blocked', 'sandwich refusal evidenced');
    assertMatch(b1.promotion.refusal, /moved during verification/, 'bundle records why');
    // honest recovery: the NEW head is stable and green; a re-run promotes it
    const H2 = git(c, 'rev-parse', 'HEAD');
    const r2 = canary(['isolate', '--promote', 's1', mp], mp);
    assertEq(r2.status, 0, `re-promote of the stable head failed:\n${r2.stdout}`);
    assertMatch(r2.stdout, /PROMOTED/, 'recovery promoted');
    assertEq(git(mp, 'rev-parse', 'HEAD'), H2, 'base landed on the stable commit');
  });

  check('candidate changed after a PASS verify: promote decides on LIVE bytes — a failing head refuses with no promotion bundle', () => {
    const cc = makeRepo('candchange');
    assertEq(canary(['isolate', 'k1', cc], cc).status, 0);
    advance(cc, 'k1', 'first.txt');
    assertEq(canary(['isolate', '--verify', 'k1', cc], cc).status, 0); // the "evidence" act: a real PASS bundle exists
    fs.writeFileSync(path.join(candPath(cc, 'k1'), 'marker.txt'), 'FAIL\n');
    git(candPath(cc, 'k1'), 'add', '-A'); git(candPath(cc, 'k1'), 'commit', '-m', 'break it after passing');
    const fp = fingerprint(cc);
    const r = canary(['isolate', '--promote', 'k1', cc], cc);
    assertEq(r.status, 2, `promotion over failing bytes must refuse:\n${r.stdout}`);
    assertMatch(r.stdout, /CANDIDATE FAIL/, 'the LIVE verify — not the stored PASS — decided');
    assertFpSame(fingerprint(cc), fp, 'failed-promotion touched the base');
    assertEq(promotionCount(cc), 0, 'a promotion that never reached its act wrote no promotion bundle');
  });

  check('dirty candidate after a PASS (uncommitted scratch): REFUSED — promotion applies committed bytes only', () => {
    const dc = makeRepo('dirtycand');
    assertEq(canary(['isolate', 'x1', dc], dc).status, 0);
    const C = advance(dc, 'x1');
    fs.writeFileSync(path.join(candPath(dc, 'x1'), 'scratch.txt'), 'not committed\n');
    const fp = fingerprint(dc);
    const r = canary(['isolate', '--promote', 'x1', dc], dc);
    assertEq(r.status, 2, `dirty candidate must refuse:\n${r.stdout}`);
    assertMatch(r.stdout, /CANDIDATE PASS/, 'the live plan passed on the committed bytes');
    assertMatch(r.stdout, /UNCOMMITTED changes/, 'the sandwich names the uncommitted work');
    assertFpSame(fingerprint(dc), fp, 'dirty-candidate refusal moved the base');
    assertEq(git(dc, 'rev-parse', 'HEAD') !== C, true, 'nothing was applied');
    assertEq(latestPromotion(dc).status, 'blocked', 'refusal evidenced');
  });

  check('stale evidence replay: forged PASS candidate bundle cannot carry a broken tree; live bytes rule', () => {
    const rp = makeRepo('replay');
    assertEq(canary(['isolate', 'r1', rp], rp).status, 0);
    const c = candPath(rp, 'r1');
    fs.writeFileSync(path.join(c, 'marker.txt'), 'FAIL\n'); // broken, uncommitted
    const d = path.join(rp, '.canary', 'evidence', '2020-01-01T00-00-00-000Z-candidate');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'verification.json'), JSON.stringify({
      schema: 'canary-verification/1', source: 'candidate', status: 'pass', trustClass: 'CANARY_OBSERVED',
      candidateName: 'r1', steps: [{ ok: true }],
    }));
    const fp = fingerprint(rp);
    const r = canary(['isolate', '--promote', 'r1', rp], rp);
    assertEq(r.status, 2, `forged PASS must not promote:\n${r.stdout}`);
    assertMatch(r.stdout, /CANDIDATE FAIL/, 'the live plan ran the broken bytes and failed');
    assertFpSame(fingerprint(rp), fp, 'replay touched the base');
    assertEq(promotionCount(rp), 0, 'replay never reached the act, so no promotion bundle');
    assert(fs.readFileSync(path.join(d, 'verification.json'), 'utf8').includes('"pass"'), 'the forged bundle must survive untouched — inert data, not authority');
  });

  check('evidence from A used for B: B gets its OWN live verdict (broken B refuses despite fresh A PASS)', () => {
    const ab = makeRepo('ab');
    assertEq(canary(['isolate', 'a1', ab], ab).status, 0);
    assertEq(canary(['isolate', 'b2', ab], ab).status, 0);
    advance(ab, 'a1');
    assertEq(canary(['isolate', '--verify', 'a1', ab], ab).status, 0); // fresh, real PASS for A
    fs.writeFileSync(path.join(candPath(ab, 'b2'), 'marker.txt'), 'FAIL\n');
    git(candPath(ab, 'b2'), 'add', '-A'); git(candPath(ab, 'b2'), 'commit', '-m', 'B is broken');
    const fp = fingerprint(ab);
    const r = canary(['isolate', '--promote', 'b2', ab], ab);
    assertEq(r.status, 2, `A's PASS must not promote B:\n${r.stdout}`);
    assertMatch(r.stdout, /CANDIDATE FAIL/, 'B failed its own live verify');
    assertFpSame(fingerprint(ab), fp, 'A-for-B touched the base');
    assertEq(promotionCount(ab), 0, 'no promotion bundle — the act never began for B');
    // and A's own promotion still works on A's merits, independently
    assertEq(canary(['isolate', '--promote', 'a1', ab], ab).status, 0);
    assertEq(acceptedPromotions(ab), 1, 'exactly one accepted promotion in this repo: A on A\'s merits');
  });

  check('candidate-tampered authority (its own canary config + fake git shim) is INERT for promotion', () => {
    const ct = makeRepo('canarytamper');
    assertEq(canary(['isolate', 'm1', ct], ct).status, 0);
    const c = candPath(ct, 'm1');
    // candidate plants a competing canary config with an "always pass" plan…
    fs.mkdirSync(path.join(c, '.canary'), { recursive: true });
    fs.writeFileSync(path.join(c, '.canary', 'canary.local.json'), JSON.stringify(
      { pm: 'npm', plan: [{ script: 'nothingthatmatters' }], scripts: {} }, null, 2));
    // …and a git shim next to its node binaries.
    fs.mkdirSync(path.join(c, 'node_modules', '.bin'), { recursive: true });
    fs.writeFileSync(path.join(c, 'node_modules', '.bin', 'git'), '#!/bin/sh\necho pwned\n');
    advance(ct, 'm1');
    const r = canary(['isolate', '--promote', 'm1', ct], ct);
    assertEq(r.status, 0, `planted configs must not steer promotion:\n${r.stdout}`);
    assertMatch(r.stdout, /ACCEPTED/, 'real plan ran, real proof held');
    assert(!/pwned/.test(r.stdout), 'the fake git shim was EXECUTED — promote resolves git like the rest of Canary, from the environment, not the candidate');
    const b = latestPromotion(ct);
    assertEq(b.steps.length, 1, 'the promotion bundle carries the single apply step');
    assertEq(b.steps[0].kind, 'promotion', 'apply step, not a plan step');
    const vbs = bundles(ct, '-candidate');
    assertEq(vbs.at(-1).steps.length, 1, 'the live verify ran exactly the ONE sealed BASE plan step, not the planted plan');
    assertMatch(vbs.at(-1).steps[0].argv.join(' '), /run test/, 'the sealed script ran (npm run test)');
    assert(!vbs.at(-1).steps[0].argv.join(' ').includes('nothingthatmatters'), 'the PLANTED plan executed — the base seal is not the authority');
    assert(fs.existsSync(path.join(c, '.canary', 'canary.local.json')), 'planted config left in place (ignored, not removed — cleanup is not promotion\'s job)');
  });

  check('malformed record (baseHead tampered to garbage): honest refusal via the delegated live verify', () => {
    const mr = makeRepo('malformed');
    assertEq(canary(['isolate', 'n1', mr], mr).status, 0);
    advance(mr, 'n1');
    const recP = path.join(mr, '.canary', 'candidates', 'n1.json');
    const recJ = JSON.parse(fs.readFileSync(recP, 'utf8'));
    recJ.baseHead = 'zzzz'; // hand-edit: the only way a candidate process could even try
    fs.writeFileSync(recP, JSON.stringify(recJ, null, 2));
    const fp = fingerprint(mr);
    const r = canary(['isolate', '--promote', 'n1', mr], mr);
    assertEq(r.status, 2, `malformed record must refuse:\n${r.stdout}`);
    assertMatch(r.stdout, /malformed/, 'honest reason (delegated — promote carries no separate record gate)');
    assertFpSame(fingerprint(mr), fp, 'malformed-record refusal touched the base');
    assertEq(promotionCount(mr), 0, 'refusal before the act wrote no promotion bundle');
  });

  // M9 CLOSED the pre-M9 residual this scenario used to pin as INERT. The
  // same-UID fact is unchanged (a running step CAN still write the base
  // evidence dir — no containment pretense); what changed is that the write
  // is no longer invisible: the whole-tree evidence fingerprint at the
  // window edge turns the identical act into a §9 mandate, on verify and on
  // promote's gate-1 re-verify alike. Prevention was never the claim;
  // detection is, and it holds.
  check('M9-CLOSED: a step writing into the base evidence dir mid-window forces the §9 mandate, not a verdict', () => {
    const tw = makeRepo('tamperwrite');
    assertEq(canary(['isolate', 'p1', tw], tw).status, 0);
    const c = candPath(tw, 'p1');
    // sealed script TEXT stays untouched (the drift gate holds); the candidate
    // edits the TEST FILE it runs — its own bytes — to write a stray file
    // into the base evidence dir, exactly the old scenario's bytes.
    fs.writeFileSync(path.join(c, 'checks', 'verify.js'),
      "const fs=require('node:fs');\n" +
      "try{fs.writeFileSync('../../../.canary/evidence/CANDIDATE-FOILED-EVIDENCE.txt','I wrote into base evidence\\n');}catch(e){}\n" +
      'process.exit(0);\n');
    git(c, 'add', '-A'); git(c, 'commit', '-m', 'test file writes a stray into base evidence');
    const fp = fingerprint(tw);
    const r = canary(['isolate', '--promote', 'p1', tw], tw);
    assertEq(r.status, 2, `in-window base-evidence writing must force the mandate:\n${r.stdout}`);
    assertMatch(r.stdout, /CANARY BLOCKED COMPLETION/, 'the §9 mandate on the promote re-verify — gate 1 is the sole authority');
    assert(!/ACCEPTED|PROMOTED/.test(r.stdout), 'no promotion verdict over a moved evidence tree');
    assertFpSame(fingerprint(tw), fp, 'the mandated promote left the tracked base bytes untouched');
    const last = bundles(tw, '-candidate').at(-1);
    assertEq(last.status, 'blocked', 'zero-step mandate bundle, never a laundered pass');
    assertEq(last.steps.length, 0, 'nothing counts once authority is proven moved');
    assert(!!last.authorityEvent, 'authorityEvent in the bundle (when + before/after tokens)');
    assertEq(bundles(tw, '-promotion').length, 0, 'no promotion bundle — the act never reached an apply');
    // the write itself LANDED (same-UID ceiling, stated not hidden) — it
    // simply can no longer ride a verdict:
    assert(fs.existsSync(path.join(tw, '.canary', 'evidence', 'CANDIDATE-FOILED-EVIDENCE.txt')),
      'behavioral FACT: prevention is still impossible; detection is what closed the residual');
  });

  // end-state hygiene: no repo that was refused ever holds an ACCEPTED
  // promotion bundle — the verdict lines above could lie, these bytes cannot.
  check('cross-case hygiene: refused repos hold zero accepted promotion bundles; attempted repos land exactly once', () => {
    // tamperwrite joined this list when M9 closed the evidence-write
    // residual: its mandate means the promotion act never lands at all.
    const zero = ['diverge', 'dirtybase', 'collide', 'detached', 'candchange', 'dirtycand', 'replay', 'malformed', 'tamperwrite'];
    for (const name of zero) {
      const root = path.join(TMP, name);
      assertEq(acceptedPromotions(root), 0, `${name}: accepted-bundle count wrong`);
    }
    assertEq(acceptedPromotions(path.join(TMP, 'midplan')), 1, 'midplan: refused once, then promoted its stable head exactly once');
    assertEq(acceptedPromotions(iso), 2, 'happy repo: apply + idempotent re-apply, both accepted');
  });
} finally {
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 4 });
}

console.log(failures === 0 ? 'M8 promotion: ALL PASS' : `M8 promotion: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
