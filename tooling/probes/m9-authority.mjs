#!/usr/bin/env node
/**
 * M9 real-git authority-guard probe — directive §9: the worker candidate must
 * never control its verifier. The candidate's SEALED plan step is a fixture
 * that reaches out of the worktree and mutates BASE authority while
 * Canary is watching (config / harness settings / registry record / task
 * intent / settings deletion / evidence plant / evidence edit / evidence
 * wipe / the verifier's own dist bytes / a still-queued step's sealed text /
 * the base HEAD ref). This probe proves, on real git, that:
 *   - any in-window write flips the verdict to the §9 mandate (exit 2, three
 *     mandated lines, blocked zero-step bundle carrying authorityEvent) — the
 *     PASS path is structurally never reached; the fingerprint set covers the
 *     base authority bytes, the WHOLE evidence tree, the VERIFIER'S OWN CODE
 *     TREE (dist/src — S11), and the base HEAD ref token (S13);
 *   - the seal checks run at BOTH window edges: a step rewriting a later
 *     step's script text EXECUTES (npm re-reads package.json per spawn) but
 *     the post-window recheck turns the would-be PASS into an
 *     after-execution mandate (S12);
 *   - §9.5: a during/after-execution mandate QUARANTINES the base — verify
 *     and promote refuse to judge at all (before any gate, no new bundle)
 *     until a human re-seal (setup) clears it; a byte-idempotent tampering
 *     can no longer re-baseline into innocence (S10), while the
 *     before-execution pre-gate stays grudgeless (S7);
 *   - the containment pre-gate catches a harness entry stripped BEFORE the
 *     window ('before execution'), and restoring the bytes recovers PASS;
 *   - `isolate --promote` cannot launder a tampering verify: the mandate text
 *     appears in promote's own output, promotion refuses with exit 2, writes
 *     no promotion bundle, and the base stays byte-identical;
 *   - untouched authority still verifies PASS (positive control — the guard
 *     must not shout when nothing moved).
 * Honest ceilings, proven AS ceilings: change-and-revert strictly inside one
 * window is invisible (same limit as M8's identity sandwich); S13 witnesses
 * the base ref moving but does NOT stop it (detection, not prevention);
 * same-UID code can delete the quarantine marker by hand — what it cannot
 * do is the AUTOMATED re-run laundering (S10); @canary-rn workspace imports
 * resolve outside dist/src — the dep-tree slice stays the stated ceiling.
 * NO PROOF, NO DONE.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const CLI = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');
// absolute + quoted: setup's smoke runs this at the BASE root, the sealed
// plan runs it inside the candidate — the fixture itself decides what is safe
// where (see its candidate-location guard); quoting survives spaces.
// argv[2] carries the MAIN repo's dist path for the 'verifier' mode (S11).
const FIXTURE = `node "${path.join(REPO, 'tooling', 'test-support', 'fixtures', 'm9-touch-authority.mjs')}" "${path.join(REPO, 'apps', 'cli', 'dist')}"`;

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}\n     ${String(e.message ?? e).split('\n').join('\n     ')}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertMatch(hay, re, msg) { assert(re.test(hay), `${msg}\n     expected /${re}/ in:\n     ${hay.split('\n').slice(0, 20).join('\n     ')}`); }
function assertEq(actual, expected, msg) { assert(actual === expected, `${msg}\n     expected: ${JSON.stringify(expected)}\n     actual:   ${JSON.stringify(actual)}`); }

assert(fs.existsSync(CLI), `missing built CLI (run npm run build): ${CLI}`);
assert(fs.existsSync(path.join(REPO, 'tooling', 'test-support', 'fixtures', 'm9-touch-authority.mjs')), 'missing m9 fixture');
{
  const gv = spawnSync('git', ['--version'], { encoding: 'utf8', timeout: 15_000 });
  assert(gv.status === 0, `git not runnable: ${gv.error?.message ?? gv.status}`);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-m9-probe-'));
const mandate = /CANARY BLOCKED COMPLETION — Verification authority was modified by the candidate\./;
const mandate3 = /Do not allow candidate-modified Canary to judge its own mutation\./;
const quarantineRe = /CANARY QUARANTINED/;
const qp = (root) => path.join(root, '.canary', 'authority-quarantine.json');

function git(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 60_000 });
  assert(r.status === 0, `git ${args.join(' ')} failed: ${r.stderr?.trim() || r.stdout?.trim() || r.error?.message}`);
  return r.stdout.trim();
}
function canary(args, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', timeout: 120_000 });
}
function makeRepo(name, extra = {}) {
  const root = path.join(TMP, name);
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  for (const [f, content] of Object.entries(extra.files ?? {})) fs.writeFileSync(path.join(root, f), content);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(
    { name, private: true, scripts: { test: FIXTURE, ...(extra.scripts ?? {}) } }, null, 2) + '\n');
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
// isolate + commit the mode file INSIDE the candidate (a committed
// advancement; the fixture replays under any later live re-verify)
function isolateWithMode(root, name, mode) {
  assertEq(canary(['isolate', name, root], root).status, 0, `isolate ${name} failed`);
  fs.writeFileSync(path.join(candPath(root, name), '.m9mode'), mode + '\n');
  git(candPath(root, name), 'add', '-A');
  git(candPath(root, name), 'commit', '-m', `mode ${mode}`);
  return candPath(root, name);
}
function bundles(root, suffix) {
  const d = path.join(root, '.canary', 'evidence');
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((x) => x.endsWith(suffix)).sort()
    .map((x) => JSON.parse(fs.readFileSync(path.join(d, x, 'verification.json'), 'utf8')));
}
const latestCandidate = (root) => { const bs = bundles(root, '-candidate'); assert(bs.length > 0, 'no candidate bundle'); return bs.at(-1); };
function verifyExpectingMandate(root, name, ownFile, whenRe) {
  const r = canary(['isolate', '--verify', name, root], root);
  assertEq(r.status, 2, `${ownFile}: authority write must exit 2 — got ${r.status}:\n${r.stdout}`);
  assertMatch(r.stdout, mandate, `${ownFile}: mandated line 1`);
  assertMatch(r.stdout, mandate3, `${ownFile}: mandated line 3`);
  assert(!/CANDIDATE PASS/.test(r.stdout), `${ownFile}: mutated bytes must not judge a PASS`);
  const b = latestCandidate(root);
  assertEq(b.status, 'blocked', `${ownFile}: bundle status`);
  assertEq(b.steps.length, 0, `${ownFile}: mandate bundle carries zero steps`);
  assertEq(b.trustClass, 'CANARY_OBSERVED', `${ownFile}: M3 class intact on the §9 path`);
  const ev = b.authorityEvent;
  assert(ev && typeof ev === 'object', `${ownFile}: bundle carries authorityEvent`);
  assertMatch(ev.when, whenRe, `${ownFile}: authorityEvent.when`);
  assert(ev.changes.some((c) => c.file.replace(/\\/g, '/').includes(ownFile) && c.before !== c.after),
    `${ownFile}: authorityEvent names the drifted file: ${JSON.stringify(ev.changes)}`);
  return { r, b };
}

try {
  // ============ S1: positive control — the guard must NOT shout ============
  const ok = makeRepo('control');
  check('positive control: untouched authority verifies CANDIDATE PASS, zero §9 lines', () => {
    isolateWithMode(ok, 'g1', 'none');
    const r = canary(['isolate', '--verify', 'g1', ok], ok);
    assertEq(r.status, 0, `clean verify failed:\n${r.stdout}`);
    assertMatch(r.stdout, /CANDIDATE PASS/, 'the sealed fixture ran green');
    assert(!mandate.test(r.stdout), 'positive control tripped the guard');
    const b = latestCandidate(ok);
    assertEq(b.status, 'pass', 'pass bundle');
    assertEq(b.authorityEvent, undefined, 'no authorityEvent on a clean pass');
  });

  // ============ S2-S9: in-window writes, one per authority byte/tree ============
  for (const [mode, ownFile] of [['config', 'canary.local.json'], ['settings', 'settings.json'],
    ['settingsdrop', 'settings.json'], ['record', 'candidates/g2.json'], ['task', 'task/current.json'],
    ['evidenceplant', 'evidence/0-forged-pass-candidate/verification.json'],
    ['evidenceedit', '-setup/verification.json'], ['evidencedel', '-setup/verification.json']]) {
    const root = makeRepo(`drift-${mode}`);
    check(`during-execution drift via sealed step: mode=${mode} flips PASS into the §9 mandate`, () => {
      isolateWithMode(root, 'g2', mode);
      const { b } = verifyExpectingMandate(root, 'g2', ownFile, /during execution/);
      const ch = b.authorityEvent.changes.find((x) => x.file.replace(/\\/g, '/').includes(ownFile));
      assert(ch, 'owning change present');
      if (mode === 'settingsdrop' || mode === 'evidencedel') assertEq(ch.after, 'ABSENT', `a deleted authority ${mode === 'evidencedel' ? 'bundle file' : 'file'} is honestly ABSENT`);
      else if (mode === 'task' || mode === 'evidenceplant') assertEq(ch.before, 'ABSENT', 'created mid-window was absent before');
      else assert(ch.before.startsWith('sha256:') && ch.after.startsWith('sha256:'), `both edges hold sha tokens: ${JSON.stringify(ch)}`);
      if (mode === 'evidencedel') {
        assert(b.authorityEvent.changes.length > 1, 'a whole-dir wipe reports EVERY lost file, not just one');
        assert(b.authorityEvent.changes.every((c) => c.after === 'ABSENT'), 'wipe drift is all-ABSENT on the after edge');
      }
      if (mode === 'evidenceplant') {
        // the payoff assertion: a parseable, CANARY_OBSERVED-styled PASS
        // bundle sits in the evidence dir while the verdict is the mandate —
        // planted bytes authorize nothing (forged PASS never reached output)
        const forged = JSON.parse(fs.readFileSync(path.join(root, '.canary', 'evidence', '0-forged-pass-candidate', 'verification.json'), 'utf8'));
        assertEq(forged.status, 'pass', 'the forgery really says PASS');
        assertEq(forged.trustClass, 'CANARY_OBSERVED', 'the forgery really impersonates the trusted class');
        assertEq(b.status, 'blocked', '…and it still could not outvote the guard');
      }
      // the guard judges, it does not heal: tampered bytes stay on disk as a
      // human-visible fact (a restore is a deliberate act — S7 proves the
      // restoration path; deleting the evidence would hide the mutation).
      assert(fs.existsSync(qp(root)), `mode=${mode}: a during-execution mandate quarantines the base (§9.5)`);
    });
  }

  // ============ S7: containment pre-gate — stripped OUTSIDE the window ============
  const pre = makeRepo('pregate');
  check('stripped harness entry before execution → §9 (containment pre-gate); restore recovers PASS', () => {
    isolateWithMode(pre, 'g3', 'none');
    const settings = path.join(pre, '.claude', 'settings.json');
    const saved = fs.readFileSync(settings);
    fs.rmSync(settings);
    const r = canary(['isolate', '--verify', 'g3', pre], pre);
    assertEq(r.status, 2, `pre-gate must refuse:\n${r.stdout}`);
    assertMatch(r.stdout, mandate, 'mandated line 1');
    assertMatch(r.stdout, /before execution/, 'the pre-gate names WHEN');
    assertMatch(r.stdout, /unreadable/, 'missing settings is honest, never absent-and-fine');
    const b = latestCandidate(pre);
    assertEq(b.status, 'blocked', 'pre-gate block evidenced');
    assertEq(b.authorityEvent.when, 'before execution', 'authorityEvent when');
    assertEq(b.steps.length, 0, 'nothing ran — the step list proves it');
    assert(!fs.existsSync(qp(pre)), '§9.5: a before-execution mandate is GRUDGELESS — no quarantine marker; its restore path is writing the promised bytes back');
    // recovery is a state property, not a grudge:
    fs.writeFileSync(settings, saved);
    const r2 = canary(['isolate', '--verify', 'g3', pre], pre);
    assertEq(r2.status, 0, `restore must recover PASS:\n${r2.stdout}`);
    assertMatch(r2.stdout, /CANDIDATE PASS/, 'positive control again after restore');
  });

  // ============ S8: promotion cannot launder a tampering verify ============
  const pr = makeRepo('promote-launder');
  check('isolate --promote over tampering authority: §9 text in promote output, exit 2, no PROMOTED, base byte-identical', () => {
    isolateWithMode(pr, 'g4', 'config'); // the COMMITTED advancement IS the tampering step
    const fp = () => ({ head: git(pr, 'rev-parse', 'HEAD'), tracked: git(pr, 'status', '--porcelain', '--untracked-files=no') });
    const before = fp();
    const r = canary(['isolate', '--promote', 'g4', pr], pr);
    assertEq(r.status, 2, `promotion over tampering authority must refuse:\n${r.stdout}`);
    assertMatch(r.stdout, mandate, 'the §9 mandate is visible IN PROMOTE output (no laundering the verdict into a bare refusal)');
    assert(!/PROMOTED|ALREADY APPLIED|ACCEPTED/.test(r.stdout), 'success wording must not appear');
    assertEq(git(pr, 'rev-parse', 'HEAD'), before.head, 'branch moved despite the mandate');
    assertEq(git(pr, 'status', '--porcelain', '--untracked-files=no'), before.tracked, 'tracked base state changed');
    assertEq(bundles(pr, '-promotion').length, 0, 'gate 1 refused — no promotion act, no promotion bundle');
    assertEq(latestCandidate(pr).authorityEvent.when, 'during execution', 'the live re-verify witnessed the write');
    assert(fs.existsSync(qp(pr)), 'the promote-window mandate stamped the quarantine marker');
    // and the launder attempt cannot simply be RETRIED: the next promote is
    // refused before judging, writing no bundle at all (the marker is evidence)
    const nCand = bundles(pr, '-candidate').length;
    const r2 = canary(['isolate', '--promote', 'g4', pr], pr);
    assertEq(r2.status, 2, `quarantined promote must refuse outright:\n${r2.stdout}`);
    assertMatch(r2.stdout, quarantineRe, 'the refusal names the quarantine');
    assert(!mandate.test(r2.stdout), 'a refusal is not a fresh mandate — nothing was judged');
    assertEq(bundles(pr, '-candidate').length, nCand, 'refusal-before-judging writes no new bundle');
    // the HUMAN re-seal is the clearing act — and the next window is judged
    // on its own facts: the committed tampering replays and re-fires
    assertEq(canary(['setup', '--yes', pr], pr).status, 0, 'setup must still run on a quarantined base (it IS the recovery)');
    assert(!fs.existsSync(qp(pr)), 'writeConfig landing cleared the marker');
    const r3 = canary(['isolate', '--promote', 'g4', pr], pr);
    assertEq(r3.status, 2, `post-clear promote must mandate again:\n${r3.stdout}`);
    assertMatch(r3.stdout, mandate, 'quarantine does not forgive — the tampering is caught fresh');
    assert(fs.existsSync(qp(pr)), '…and the marker stands again for the next automated retry');
    assertEq(bundles(pr, '-promotion').length, 0, 'still never promoted');
  });

  // ============ S10: §9.5 — the quarantine refusal pins a second window ============
  const lw = makeRepo('second-window');
  check('S10: §9.5 quarantine refusal — a byte-idempotent tampering cannot re-baseline into a PASS', () => {
    isolateWithMode(lw, 'g5', 'config');
    verifyExpectingMandate(lw, 'g5', 'canary.local.json', /during execution/); // r1: caught INSIDE the window
    const mark = JSON.parse(fs.readFileSync(qp(lw), 'utf8'));
    assertEq(mark.schema, 'canary-authority-quarantine/1', 'marker schema');
    assertEq(mark.when, 'during execution', 'marker names the catch');
    assert(Array.isArray(mark.changes) && mark.changes.length >= 1, 'marker records the changes');
    // THE laundering vector: re-verify WITHOUT restoring bytes. The mutation
    // is idempotent (same mutated bytes written again), so an unfixed second
    // window would snapshot the mutated config as its baseline and PASS.
    const n = bundles(lw, '-candidate').length;
    const r2 = canary(['isolate', '--verify', 'g5', lw], lw);
    assertEq(r2.status, 2, `quarantined verify must refuse:\n${r2.stdout}`);
    assertMatch(r2.stdout, quarantineRe, 'the refusal names the quarantine');
    assert(!mandate.test(r2.stdout), 'a refusal is not a fresh mandate — nothing was judged');
    assert(!/CANDIDATE PASS/.test(r2.stdout), 'the second window CANNOT re-baseline into innocence');
    assertEq(bundles(lw, '-candidate').length, n, 'refusal-before-judging writes zero new bundles — the marker is the evidence');
    const rp = canary(['isolate', '--promote', 'g5', lw], lw);
    assertEq(rp.status, 2, 'promote inherits the refusal (gate 1)');
    assertMatch(rp.stdout, quarantineRe, 'promote output names the quarantine');
    assert(!/PROMOTED|ALREADY APPLIED|ACCEPTED/.test(rp.stdout), 'no promotion success wording through a quarantined base');
    assertEq(bundles(lw, '-promotion').length, 0, 'no promotion bundle');
  });

  // ============ S11: F1 — the verifier's own code tree is authority ============
  const DIST_AUTH = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'authority.js');
  const vc = makeRepo('verifier-code');
  check('S11: verifier code tree fingerprint — a step editing dist/src/authority.js is caught (verifier code)', () => {
    const saved = fs.readFileSync(DIST_AUTH);
    try {
      isolateWithMode(vc, 'g6', 'verifier');
      const { r, b } = verifyExpectingMandate(vc, 'g6', 'src/authority.js', /during execution/);
      assertMatch(r.stdout, quarantineRe, 'a verdict-window tampering quarantines in the same breath');
      const ch = b.authorityEvent.changes.find((x) => x.file.replace(/\\/g, '/').endsWith('src/authority.js'));
      assert(ch, 'the change names the verifier file');
      assert(ch.before.startsWith('sha256:') && ch.after.startsWith('sha256:') && ch.before !== ch.after,
        `both edges hold distinct sha tokens: ${JSON.stringify(ch)}`);
      assert(fs.existsSync(qp(vc)), 'verifier-byte tampering quarantines too — the next spawn would RUN them');
    } finally {
      fs.writeFileSync(DIST_AUTH, saved); // restore BEFORE any later scenario spawns the CLI
    }
    assert(fs.readFileSync(DIST_AUTH).equals(saved), 'the verifier bytes are byte-identical after S11 — the tamper left no residue in the shared dist');
  });

  // ============ S12: F3 — the post-window seal recheck ============
  const sw = makeRepo('swap-exec', {
    scripts: { build: 'node build-ok.js' },
    files: { 'build-ok.js': 'console.log("BUILD-OK");\n' },
  });
  check('S12: post-window seal recheck — step 1 rewriting step 2\'s sealed text EXECUTES but never PASSes (post-window)', () => {
    const cand = isolateWithMode(sw, 'g7', 'swap');
    const r = canary(['isolate', '--verify', 'g7', sw], sw);
    assertEq(r.status, 2, `swapped-text execution must end in the mandate:\n${r.stdout}`);
    assertMatch(r.stdout, mandate, 'mandated line 1');
    assertMatch(r.stdout, /✓ build/, 'the operator saw the tampered step claim green BEFORE the post-window flip');
    assert(!/CANDIDATE PASS/.test(r.stdout), 'green on unsealed words is never a PASS');
    assert(fs.existsSync(path.join(cand, 'swap-ran.txt')), 'the swapped text REALLY executed — detection is after the fact, stated');
    const b = latestCandidate(sw);
    assertEq(b.status, 'blocked', 'mandate bundle');
    assertEq(b.steps.length, 0, 'the verdict bundle stays zero-step');
    assertEq(b.authorityEvent.when, 'after execution', 'the check that caught it ran at the post-window edge');
    const ch = b.authorityEvent.changes[0];
    assertEq(b.authorityEvent.changes.length, 1, 'exactly the seal violation is named');
    assert(ch.file.replace(/\\/g, '/').endsWith('.canary/candidates/g7/package.json'), `the candidate's package.json is named: ${ch.file}`);
    assertEq(ch.before, 'sealed at setup — held when the window opened', 'the prior state is the promise, not bytes');
    assertMatch(ch.after, /drifted after execution/);
    assertMatch(ch.after, /script "build" changed since setup sealed it/, 'the drift detail names the rewritten script');
    assert(fs.existsSync(qp(sw)), 'a post-window catch quarantines — the mutated plan surface cannot re-baseline');
  });

  // ============ S13: F4 — the base HEAD ref is a sandwich token ============
  const br = makeRepo('base-refmove');
  check('S13: base HEAD token — a sealed step moving the base branch is witnessed; promote never reads the moved ref as applied (base HEAD)', () => {
    const headOrig = git(br, 'rev-parse', 'HEAD');
    isolateWithMode(br, 'g8', 'basemove');
    const { b } = verifyExpectingMandate(br, 'g8', 'base HEAD', /during execution/);
    const ch = b.authorityEvent.changes.find((x) => x.file.includes('base HEAD ref'));
    assert(ch, `the mandate names the ref: ${JSON.stringify(b.authorityEvent.changes)}`);
    assert(/^[0-9a-f]{40,64}$/.test(ch.before) && /^[0-9a-f]{40,64}$/.test(ch.after), `both edges are sha tokens: ${JSON.stringify(ch)}`);
    assertEq(ch.before, headOrig, 'the before token is the sealed HEAD');
    // detection, not prevention — stated as ceiling and PROVEN so: the ref really moved
    assert(git(br, 'rev-parse', 'HEAD') !== headOrig, 'the guard witnessed the move; it did not (cannot) stop it');
    assertEq(git(br, 'rev-parse', 'HEAD'), ch.after, 'the after token is the live HEAD');
    const rp = canary(['isolate', '--promote', 'g8', br], br);
    assertEq(rp.status, 2, 'promote refuses through quarantine');
    assertMatch(rp.stdout, quarantineRe, 'the refusal names the quarantine — never an ALREADY APPLIED reading of the moved ref');
    assert(!/PROMOTED|ALREADY APPLIED|ACCEPTED/.test(rp.stdout), 'gate 6 cannot rubber-stamp an attacker-moved base branch');
    assertEq(bundles(br, '-promotion').length, 0, 'no promotion bundle');
  });

  // ============ hygiene end-state ============
  check('cross-case hygiene: every drift repo ends on a blocked mandate bundle; only the control repo passes', () => {
    for (const m of ['config', 'settings', 'settingsdrop', 'record', 'task', 'evidenceplant', 'evidenceedit', 'evidencedel']) {
      const b = latestCandidate(path.join(TMP, `drift-${m}`));
      assertEq(b.status, 'blocked', `drift-${m}: last candidate verdict must be the mandate`);
      assert(b.authorityEvent, `drift-${m}: authorityEvent recorded`);
    }
    assertEq(latestCandidate(pre).status, 'pass', 'pregate repo recovered to pass (restore)');
    assertEq(latestCandidate(pr).status, 'blocked', 'launder attempt ended blocked');
    for (const [repo, when] of [['second-window', 'during execution'], ['verifier-code', 'during execution'],
      ['swap-exec', 'after execution'], ['base-refmove', 'during execution']]) {
      const b = latestCandidate(path.join(TMP, repo));
      assertEq(b.status, 'blocked', `${repo}: last candidate verdict must be the mandate`);
      assertEq(b.authorityEvent.when, when, `${repo}: authorityEvent when`);
      assert(fs.existsSync(qp(path.join(TMP, repo))), `${repo}: a during/after catch leaves the base quarantined for the next run`);
    }
  });
} finally {
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 4 });
}

console.log(failures === 0 ? 'M9 authority: ALL PASS' : `M9 authority: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
