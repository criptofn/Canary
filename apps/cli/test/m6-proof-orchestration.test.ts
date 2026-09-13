/**
 * M6 (spec M5) — PROOF ORCHESTRATION.
 *
 * "run whatever npm test exists" is not a proof obligation. A task kind buys
 * extra obligations; the sealed plan remains the floor NO declaration lifts —
 * the obligation engine is one-way: classification can only ADD work. Objective
 * violations (attributable test deletions) BLOCK; unprovable parts ride an
 * honest systemMessage and never fake a PASS. These contract tests run against
 * FAKE .git dirs (every git probe answers nothing => signals unresolvable =>
 * the UNPROVEN path); the real-git block/restore story lives in
 * tooling/probes/m6-proof-orchestration.mjs.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, describe, it } from 'node:test';
process.env.CANARY_TRUST_STORE = path.join(os.tmpdir(), `canary-trust-${process.pid}`); // 1.1 P0 isolation: sealed copies go to a per-process temp store, never the real user one

import {
  inferTaskKinds, parseNameStatus, parsePorcelain, delPaths, obligationsFor,
  readConfig, writeConfig, type CanaryConfig, type DiffSignals, type TaskKind,
} from '../src/onboarding.js';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const CLI = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');
assert.ok(fs.existsSync(CLI), `build first: ${CLI} missing`);

const FIXTURES = path.join(REPO, 'tooling', 'test-support', 'fixtures');
const fx = (f: string): string => `node "${path.join(FIXTURES, f)}"`;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-m6-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const sha256 = (s: string): string => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

function makeProject(name: string): string {
  const root = path.join(TMP, name);
  fs.mkdirSync(path.join(root, '.git'), { recursive: true }); // findRepoRoot only needs .git presence
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(
    { name, scripts: { test: fx('f-pass.js') } }, null, 2));
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  return root;
}

function canary(args: string[], cwd?: string, input?: string) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd, input, encoding: 'utf8', timeout: 120_000,
  });
}

const checkpoint = (root: string, extra: Record<string, unknown> = {}) => {
  const r = canary(['checkpoint'], root, JSON.stringify({ cwd: root, ...extra }));
  assert.equal(r.status, 0, `wire contract: checkpoint must exit 0 (got ${r.status})\n${r.output.join('')}`);
  const out = r.stdout ?? '';
  return out.trim() ? JSON.parse(out) : null; // '' = silent pass
};
const readState = (root: string): any =>
  JSON.parse(fs.readFileSync(path.join(root, '.canary', 'last-checkpoint.json'), 'utf8'));
const taskRecord = (root: string): any =>
  JSON.parse(fs.readFileSync(path.join(root, '.canary', 'task', 'current.json'), 'utf8'));

/** Inject any signal state — obligationsFor is pure over it. */
const sig = (over: Partial<DiffSignals> = {}): DiffSignals => ({
  resolved: true, touched: [], changes: [], deletedTestsAttributable: [], deletedTestsUnattributable: [],
  setupDirtProven: false, depTouched: false,
  ...over,
});
const kinds = (ks: string[]): TaskKind[] => ks as TaskKind[];
const ob = (list: ReturnType<typeof obligationsFor>, id: string) => list.find((x) => x.id === id);

describe('task-kind inference from prose (union — a mislabel adds work, never removes it)', () => {
  it('one phrase can raise several kinds at once', () => {
    assert.deepEqual(inferTaskKinds('refactor the renderer and speed up the ui').sort(), ['performance', 'refactor', 'ui']);
    assert.deepEqual(inferTaskKinds('fix the broken parser'), ['bugfix']);
    assert.deepEqual(inferTaskKinds('upgrade deps: npm update lodash'), ['dependency']);
  });
  it('prose matching nothing infers no kinds (the pre-M6 posture stays reachable)', () => {
    assert.deepEqual(inferTaskKinds('rename branch feature/x to feature/y'), []);
  });
  it('the whole word "defect" infers bugfix (review #7: a leading-space typo dropped the word)', () => {
    assert.deepEqual(inferTaskKinds('defect: parser dies'), ['bugfix']);
    assert.deepEqual(inferTaskKinds('fixed the defect'), ['bugfix']);
  });
});

describe('git output parsers (-z raw bytes: no quoting to outsmart, never crash, never invent paths)', () => {
  it('name-status -z: NUL-separated; renames consume both paths; unknown codes degrade to mod', () => {
    assert.deepEqual(parseNameStatus('R100\0tests/old.test.ts\0tests/new.test.ts\0Q\0suspicious path\0'), [
      { st: 'ren', paths: ['tests/old.test.ts', 'tests/new.test.ts'] },
      { st: 'mod', paths: ['suspicious path'] },
    ]);
    assert.deepEqual(parseNameStatus('D\0test/a.test.js\0'), [{ st: 'del', paths: ['test/a.test.js'] }]);
    // the review-#1 gate evasion: git C-quotes (wraps in `"`) non-ASCII paths in
    // LINE mode and the quotes silently defeated isTestPath; -z hands RAW bytes.
    assert.deepEqual(parseNameStatus('D\0tests/ünï.test.js\0'), [{ st: 'del', paths: ['tests/ünï.test.js'] }]);
    assert.deepEqual(parseNameStatus('D\0tests/x".test.js\0'), [{ st: 'del', paths: ['tests/x".test.js'] }]);
    assert.deepEqual(parseNameStatus(''), []);
    // truncated rename: no new-side token -> dropped, never a half-invented pair
    assert.deepEqual(parseNameStatus('R100\0only'), []);
  });
  it('porcelain -z: ??=add, staged/working D=del, R/C take a SECOND NUL token as the new name', () => {
    assert.deepEqual(parsePorcelain('?? new.txt\0 D worktree-del.txt\0D  staged-del.txt\0A  staged-add.txt\0R  old.ts\0new.ts\0 M mod.txt\0'), [
      { st: 'add', paths: ['new.txt'] },
      { st: 'del', paths: ['worktree-del.txt'] },
      { st: 'del', paths: ['staged-del.txt'] },
      { st: 'add', paths: ['staged-add.txt'] },
      { st: 'ren', paths: ['old.ts', 'new.ts'] },
      { st: 'mod', paths: ['mod.txt'] },
    ]);
    // a filename that LITERALLY contains ' -> ' cannot mis-split in -z mode
    assert.deepEqual(parsePorcelain('R  we  ->  are.txt\0moved.txt\0'), [
      { st: 'ren', paths: ['we  ->  are.txt', 'moved.txt'] },
    ]);
    assert.deepEqual(parsePorcelain(''), []);
  });
  it('delPaths: deletes count; a rename AWAY from a test path is coverage loss; a rename that stays a test is not (review #5)', () => {
    assert.deepEqual(delPaths(parseNameStatus('D\0tests/x.spec.ts\0')), ['tests/x.spec.ts']);
    assert.deepEqual(delPaths(parseNameStatus('R100\0tests/old.test.js\0docs/old.md\0')), ['tests/old.test.js']);
    assert.deepEqual(delPaths(parseNameStatus('R100\0tests/a.test.js\0tests/b.test.js\0')), []);
  });
});

describe('obligationsFor — the one-way obligation engine', () => {
  it('bugfix: a test filename change alone remains UNPROVEN, just like no test change', () => {
    const met = obligationsFor(kinds(['bugfix']), sig({ changes: ['src/auth.ts', 'test/auth.test.ts'] }), new Set(['tests']), 0);
    assert.equal(ob(met, 'regression-evidence')?.status, 'unproven');
    const gap = obligationsFor(kinds(['bugfix']), sig(), new Set(['tests']), 0);
    assert.equal(ob(gap, 'regression-evidence')?.status, 'unproven');
    assert.match(ob(gap, 'regression-evidence')!.note, /regression evidence UNPROVEN/);
    assert.match(ob(gap, 'regression-evidence')!.note, /Add a test that reproduces/);
  });
  it('a pure test-file DELETION is never regression evidence (review #4)', () => {
    // touched knows about the vanished file; changes deliberately does not.
    const delOnly = obligationsFor(kinds(['bugfix']), sig({
      touched: ['src/parser.ts', 'tests/old.test.js'], changes: ['src/parser.ts'],
      deletedTestsUnattributable: ['tests/old.test.js'], setupDirtProven: true,
    }), new Set(['tests']), 0);
    assert.equal(ob(delOnly, 'regression-evidence')?.status, 'unproven');
  });
  it('refactor: needs tests-green AND a coverage-loss answer; no-tests plan says so honestly', () => {
    const good = obligationsFor(kinds(['refactor']), sig(), new Set(['tests']), 0);
    assert.equal(ob(good, 'tests-green')?.status, 'met');
    assert.equal(ob(good, 'coverage-loss')?.status, 'met');
    const noTests = obligationsFor(kinds(['refactor']), sig(), new Set(['build']), 0);
    assert.equal(ob(noTests, 'tests-green')?.status, 'unproven');
    assert.match(ob(noTests, 'tests-green')!.note, /no tests step/);
    const noDiff = obligationsFor(kinds(['refactor']), sig({ resolved: false }), new Set(['tests']), 0);
    assert.equal(ob(noDiff, 'coverage-loss')?.status, 'unproven');
    assert.match(ob(noDiff, 'coverage-loss')!.note, /diff unresolvable/);
  });
  it('attributable test deletion is UNMET (the block signal); unattributable is UNPROVEN only', () => {
    const blocked = obligationsFor([], sig({ deletedTestsAttributable: ['test/flow.test.js'] }), new Set(['tests']), 0);
    const c = ob(blocked, 'coverage-loss')!;
    assert.equal(c.status, 'unmet');
    assert.equal(c.mode, 'objective');
    assert.match(c.note, /test\/flow.test.js/);
    const note = obligationsFor([], sig({ deletedTestsUnattributable: ['test/flow.test.js'] }), new Set(['tests']), 0);
    assert.equal(ob(note, 'coverage-loss')?.status, undefined); // never pretends a verdict...
    const u = ob(note, 'coverage-loss-unattributable')!;
    assert.equal(u.status, 'unproven');
    assert.match(u.note, /cannot be attributed to this session/);
  });
  it('unattributable note: "already dirty at setup" ONLY when the stamp proved it (review #6)', () => {
    const proven = obligationsFor([], sig({ deletedTestsUnattributable: ['test/flow.test.js'], setupDirtProven: true }), new Set(['tests']), 0);
    assert.match(ob(proven, 'coverage-loss-unattributable')!.note, /the repo was already dirty at setup/);
    // an UNKNOWN baseline (never stamped / unresolved) must not claim proven dirt
    const n = ob(obligationsFor([], sig({ deletedTestsUnattributable: ['test/flow.test.js'] }), new Set(['tests']), 0), 'coverage-loss-unattributable')!.note;
    assert.match(n, /cannot establish the repo's state at setup/);
    assert.ok(!n.includes('already dirty'), 'UNKNOWN is never phrased as proven dirt');
  });
  it('path rendering: 8-path cap and odd-path collapse (candidate text never rides the note)', () => {
    const many = Array.from({ length: 9 }, (_, i) => `test/t${i}.test.js`);
    const list = obligationsFor([], sig({ deletedTestsAttributable: many }), new Set(['tests']), 0);
    assert.match(ob(list, 'coverage-loss')!.note, /\(\+1 more\)/);
    const odd = obligationsFor([], sig({ deletedTestsAttributable: ['test/`rm -rf`.test.ts', '"test/quoted ok.test.ts"'] }), new Set(['tests']), 0);
    const note = ob(odd, 'coverage-loss')!.note;
    assert.ok(note.includes('<odd path>'), note);
    assert.ok(!note.includes('rm'), 'shell-hostile fragments never reach the reason string');
    assert.ok(note.includes('test/quoted ok.test.ts'), 'git-quoted names survive de-quoting');
  });
  it('dependencies: implied by diff even without any declaration — and always non-objective', () => {
    const implied = obligationsFor([], sig({ depTouched: true }), new Set(['tests']), 0);
    const d = ob(implied, 'dependency-change')!;
    assert.equal(d.status, 'unproven');
    assert.equal(d.mode, 'non-objective');
    assert.match(d.note, /trusted baseline\/candidate comparison/);
    const unresolved = obligationsFor(kinds(['dependency']), sig({ depTouched: true, resolved: false }), new Set(['tests']), 0);
    assert.match(ob(unresolved, 'dependency-change')!.note, /dependency change observed .*unresolvable baseline/);
    // blocker 2: a DECLARED dependency task whose diff shows no dependency
    // file must not claim a change it cannot see — and must name its real
    // completion path (a HUMAN accept), never a dead end.
    const declared = obligationsFor(kinds(['dependency']), sig(), new Set(['tests']), 0);
    assert.match(ob(declared, 'dependency-change')!.note, /touches no dependency file/);
    assert.match(ob(declared, 'dependency-change')!.note, /canary accept <candidate>/);
  });
  it('performance/UI: met ONLY through a human-sealed bench/e2e step; else UNPROVEN with the honest exit', () => {
    const met = obligationsFor(kinds(['performance', 'ui']), sig(), new Set(['tests', 'bench', 'e2e']), 0);
    assert.equal(ob(met, 'performance-proof')?.status, 'met');
    assert.equal(ob(met, 'ui-proof')?.status, 'met');
    const bare = obligationsFor(kinds(['performance', 'ui']), sig(), new Set(['tests']), 0);
    assert.equal(ob(bare, 'performance-proof')?.status, 'unproven');
    assert.match(ob(bare, 'performance-proof')!.note, /canary setup/); // the re-seal path, spelled out
    assert.match(ob(bare, 'ui-proof')!.note, /not pretend-deterministic/);
  });
  it('multi-part: counted requirements and the one-concise-question variant', () => {
    const counted = obligationsFor(kinds(['multi']), sig(), new Set(['tests']), 3);
    assert.match(ob(counted, 'per-requirement')!.note, /3 registered requirement\(s\)/);
    assert.equal(ob(counted, 'per-requirement')?.status, 'unproven');
    const asked = obligationsFor(kinds(['multi']), sig(), new Set(['tests']), 0);
    assert.match(ob(asked, 'per-requirement')!.note, /ask the human ONCE/);
  });
  it('a fully-covered refactor with a green sealed plan yields ONLY met obligations (silent path exists)', () => {
    const all = obligationsFor(kinds(['refactor']), sig(), new Set(['tests']), 0);
    assert.ok(all.length >= 2);
    assert.ok(all.every((x) => x.status === 'met'), JSON.stringify(all));
  });
  it('kinds never declared still get the diff-implied floor: no kinds + clean signals = no obligations beyond tests-green', () => {
    const floor = obligationsFor([], sig(), new Set(['tests']), 0);
    assert.deepEqual(floor.map((x) => x.id), ['tests-green']);
  });
});

describe('canary task — an AGENT_REPORTED hint with zero authority', () => {
  it('setup + register: digest-only storage, inferred kinds, explicit zero-authority line', () => {
    const root = makeProject('task-register');
    assert.equal(canary(['setup', '--yes', root]).status, 0);
    const r = canary(['task', 'upgrade the lodash dependency to v5'], root);
    assert.equal(r.status, 0, r.output.join(''));
    assert.match(r.stdout, /task registered: dependency/);
    assert.match(r.stdout, /zero authority/);
    const rec = taskRecord(root);
    assert.equal(rec.schema, 'canary-task/2');
    assert.deepEqual(rec.kinds, ['dependency']);
    assert.equal(rec.trustClass, 'AGENT_REPORTED');
    assert.match(rec.authority, /only ADD proof obligations/);
    // prose is digested, never stored — the record cannot smuggle agent text
    assert.equal(JSON.stringify(rec).includes('lodash'), false);
    assert.equal(rec.taskDigest, sha256('upgrade the lodash dependency to v5'));
  });
  it('--kind ADDS to inference and never removes it; --requirement forces multi; hostile input is usage, not a crash', () => {
    const root = makeProject('task-flags');
    assert.equal(canary(['setup', '--yes', root]).status, 0);
    assert.equal(canary(['task', 'touch the parser', '--kind', 'bugfix', '--requirement', 'a', '--requirement', 'b'], root).status, 0);
    let rec = taskRecord(root);
    assert.deepEqual(rec.kinds, ['bugfix', 'multi']);
    assert.equal(rec.requirementCount, 2);
    // blocker 3 laundering gate: an agent-picked --kind must not drop an
    // inferred material kind — "fix the crash AND make it pretty" with
    // --kind bugfix still carries the ui duty.
    assert.equal(canary(['task', 'fix the crash and make the dialog prettier', '--kind', 'bugfix'], root).status, 0);
    assert.deepEqual(taskRecord(root).kinds, ['bugfix', 'ui']);
    assert.equal(canary(['task', 'x', '--kind=bogus'], root).status, 3);
    assert.equal(canary(['task'], root).status, 3); // bare usage
    assert.match(canary(['task'], root).stdout, /usage: canary task/);
  });
  it('registering a task against no setup / no git says so; nothing is written', () => {
    const bare = path.join(TMP, 'task-nosetup');
    fs.mkdirSync(path.join(bare, '.git'), { recursive: true });
    assert.equal(canary(['task', 'whatever'], bare).status, 2); // no config yet
    assert.equal(fs.existsSync(path.join(bare, '.canary', 'task', 'current.json')), false);
  });
});

describe('checkpoint/doctor integration — the sealed plan passes, obligations decide the tone', () => {
  it('no task record, no prose, fake git: byte-identical pre-M6 silence (additive)', () => {
    const root = makeProject('ck-silent');
    assert.equal(canary(['setup', '--yes', root]).status, 0);
    assert.equal(checkpoint(root), null);
    assert.equal(readState(root).status, 'pass');
  });
  it('registered bugfix with no test change: an open OBJECTIVE obligation now FAILS CLOSED (block), not a note', () => {
    const root = makeProject('ck-bugfix');
    assert.equal(canary(['setup', '--yes', root]).status, 0);
    assert.equal(canary(['task', 'fix the broken parser'], root).status, 0);
    const out = checkpoint(root);
    // THE INVARIANT THIS PINS: "every objective requirement must have a frozen proof obligation or
    // remain NOT PROVEN. Missing or ambiguous proof must fail closed, never degrade to PASS." Before
    // the reliability work this rode an informational systemMessage and the agent finished anyway.
    assert.equal(out?.decision, 'block', 'an open objective obligation must block, not merely inform');
    assert.match(String(out?.reason), /NOT PROVEN/);
    assert.match(String(out?.reason), /regression evidence|FAILS without|no test file was added|does not discriminate/i);
    assert.equal(readState(root).status, 'unproven'); // state, not a bundle: the plan DID pass
  });
  it('hook-stdin task prose infers kinds even without a registration', () => {
    const root = makeProject('ck-stdin');
    assert.equal(canary(['setup', '--yes', root]).status, 0);
    const out = checkpoint(root, { task: 'refactor the module and add e2e coverage' });
    const text = `${String(out?.reason ?? '')} ${String(out?.systemMessage ?? '')}`;
    assert.match(text, /UNPROVEN|NOT PROVEN/);
    assert.match(text, /no tests step|diff unresolvable|behavior preservation|coverage|FAILS without/i);
  });
  it('a malformed/hand-planted record degrades to the no-record posture, hostile kinds filtered', () => {
    const root = makeProject('ck-malformed');
    assert.equal(canary(['setup', '--yes', root]).status, 0);
    const p = path.join(root, '.canary', 'task', 'current.json');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '{"kinds":["total-nonsense","<script>x</script>"],"requirementCount":"12"}');
    assert.equal(checkpoint(root), null, 'filtered kinds = [] and a non-integer count = 0 -> pre-M6 silence');
    fs.writeFileSync(p, 'not json at all');
    assert.equal(checkpoint(root), null, 'unreadable record is no record');
    fs.writeFileSync(p, JSON.stringify({ kinds: ['bugfix'], requirementCount: 99999 }));
    const out = checkpoint(root);
    assert.equal(out, null, 'oversized identity is rejected entirely, never clamped into authority');
  });
  it('fake git makes diff signals unresolvable: a registered refactor is NOT PROVEN and fails closed', () => {
    const root = makeProject('ck-refactor');
    assert.equal(canary(['setup', '--yes', root]).status, 0);
    assert.equal(canary(['task', 'refactor the auth module'], root).status, 0);
    // fake .git => collectDiffSignals cannot answer; resolved=false must hold there
    const cfg = readConfig(root) as CanaryConfig;
    assert.equal(cfg.baseline?.resolved, false, 'fake git must not resolve an identity');
    const out = checkpoint(root);
    const text = `${String(out?.reason ?? '')} ${String(out?.systemMessage ?? '')}`;
    assert.match(text, /coverage cannot be ruled out|diff unresolvable/);
    // An objective obligation whose premise cannot be established is NOT a pass: it blocks, and the
    // loop guard turns the second attempt into an honest "a human should look".
    assert.equal(out?.decision, 'block');
    assert.match(String(out?.reason), /NOT PROVEN/);
  });
  it('doctor refuses READY while an obligation is open (NOT PROVEN), and names it in verbose mode', () => {
    const root = makeProject('doctor-obligations');
    assert.equal(canary(['setup', '--yes', root]).status, 0);
    assert.equal(canary(['task', 'fix the crash'], root).status, 0);
    const r = canary(['doctor', root]);
    // FAIL CLOSED: this used to print READY and merely note the open obligations — the READY that
    // the benchmark then recorded as a false green.
    assert.equal(r.status, 2, 'an open obligation must not be a zero-exit READY');
    assert.match(r.stdout, /NOT PROVEN/);
    assert.doesNotMatch(r.stdout, /^READY —/m);
    assert.match(r.stdout, /NO PROOF, NO DONE/);
    assert.match(r.stdout, /UNPROVEN \[regression-evidence\]/);
  });
  it('config rewrite keeps the seal: obligations never execute anything unsealed', () => {
    const root = makeProject('no-exec');
    assert.equal(canary(['setup', '--yes', root]).status, 0);
    const cfg = readConfig(root) as CanaryConfig;
    assert.equal(canary(['task', 'benchmark the tokenizer', '--requirement', 'p1'], root).status, 0);
    const out = checkpoint(root);
    // v1.2: an unbound requirement is now an OBJECTIVE duty, so the hook must carry it — and it is
    // OPERATOR-ONLY, so the hook must NOT order the worker to keep working on it. Blocking with the old
    // note ("bind each digest … and re-run canary setup", an operator act) is what made a model burn 39
    // turns and 537,583 tokens on this host; the measured repair is to state the duty plainly as not the
    // worker's to close. Both halves are asserted, because "the duty got quieter" would be the bug this
    // test exists to catch.
    const text = `${String(out?.reason ?? '')} ${String(out?.systemMessage ?? '')}`;
    assert.match(text, /performance obligation|repeatable benchmark|NO sealed proof/);
    assert.match(text, /1 registered requirement/);
    assert.match(text, /NOT PROVEN/, 'the completion must still be reported as not proven');
    assert.match(text, /NONE of them is yours to close/, 'and must not read as an instruction to the worker');
    assert.notEqual(out?.decision, 'block', 'an operator-only duty must not trap the worker in a repair loop');
    // nothing ran beyond the sealed plan: obligations are evaluation, not execution
    const b = JSON.parse(fs.readFileSync(path.join(root, '.canary', 'evidence',
      fs.readdirSync(path.join(root, '.canary', 'evidence')).filter((d) => d.endsWith('-checkpoint')).sort().at(-1)!,
      'verification.json'), 'utf8'));
    assert.deepEqual(b.steps.map((s: any) => s.argv), cfg.plan.map(() => ['npm', 'run', 'test']));
  });
});
