/**
 * 1.1 §22 — the ordinary path: `work` then `finish`.
 *
 * The expert primitives stay the trust boundary; this pins that the orchestration
 * over them is not a shortcut around any of them. Three outcomes, all observed:
 *   - `work` registers the intent and opens the candidate in one step;
 *   - `finish` REFUSES to promote while an objective duty is UNPROVEN, and the
 *     trusted base does not move by a single byte;
 *   - `finish` verifies and promotes the exact committed candidate once every
 *     objective duty holds — no human approval is asked for objective work.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, describe, it } from 'node:test';
import { materialDigest } from '../src/authorization.js';
process.env.CANARY_TRUST_STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-trust-')); // 1.1 P0 isolation

const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const CLI = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');
const FIXTURES = path.join(REPO, 'tooling', 'test-support', 'fixtures');
assert.ok(fs.existsSync(CLI), `build first: ${CLI} missing`);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-orchestrate-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const canary = (args: string[], cwd: string) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', timeout: 300_000 });
const git = (args: string[], cwd: string) => spawnSync('git', args, { cwd, encoding: 'utf8' });
const head = (dir: string): string => git(['rev-parse', 'HEAD'], dir).stdout.trim();

/** A committed, clean, wired fixture: `isolate` needs a resolvable base commit. */
function fixture(name: string): string {
  const root = path.join(TMP, name);
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'),
    JSON.stringify({ name, scripts: { test: `node "${path.join(FIXTURES, 'f-pass.js')}"` } }, null, 2));
  fs.writeFileSync(path.join(root, 'app.js'), 'export const tolerance = 0.1;\n');
  git(['init', '-b', 'main'], root);
  git(['config', 'user.email', 'orchestrate@canary.local'], root);
  git(['config', 'user.name', 'Orchestrate'], root);
  git(['add', '-A'], root);
  git(['commit', '-m', 'base'], root);
  return root;
}

const candidate = (root: string, name: string): string => path.join(root, '.canary', 'candidates', name);
const commitIn = (dir: string, message: string): void => {
  git(['add', '-A'], dir);
  assert.equal(git(['commit', '-m', message], dir).status, 0, 'the candidate commit must succeed');
};

describe('1.1 workflow: work registers and opens in one step', () => {
  it('opens the candidate with the intent frozen into its record', () => {
    const root = fixture('work-open');
    assert.equal(canary(['setup', '--yes'], root).status, 0);
    const w = canary(['work', 'fix', 'fix the tolerance bug'], root);
    assert.equal(w.status, 0, w.stdout + w.stderr);
    assert.match(w.stdout, /CONNECTED/);
    assert.match(w.stdout, /canary finish fix/);
    assert.ok(fs.existsSync(candidate(root, 'fix')), 'the candidate worktree must exist');
    const rec = JSON.parse(fs.readFileSync(path.join(root, '.canary', 'candidates', 'fix.json'), 'utf8')) as { intent?: { task?: unknown } };
    assert.ok(rec.intent?.task, 'the intent must be frozen at isolation');
  });

  it('refuses a call with no name or no intent, and opens nothing', () => {
    const root = fixture('work-usage');
    assert.equal(canary(['setup', '--yes'], root).status, 0);
    const w = canary(['work', 'fix'], root);
    assert.equal(w.status, 3);
    assert.match(w.stdout + w.stderr, /usage: canary work/);
  });

  it('REG-R1: forwards --kind and --requirement WITH their values (silent loss was a real bug)', () => {
    // Reported by an AI agent under test, then reproduced: `work` used to forward only
    // the flag TOKENS, so the VALUES were dropped and the intent absorbed them. The
    // failure direction is the bad one — the human asked for obligations and Canary
    // registered fewer, i.e. weaker verification than was authorized.
    //
    // v1.2 adds a second gate on the same command: an unbound requirement is refused BEFORE the
    // worker is handed anything. So the value-forwarding contract is asserted where it can still
    // be observed — the registration itself — and the refusal is asserted too, because a gate that
    // silently stopped registering requirements would otherwise pass this test for the wrong reason.
    const root = fixture('work-flags');
    assert.equal(canary(['setup', '--yes'], root).status, 0);

    const t = canary([
      'task', 'add the validation rules',
      '--kind', 'multi',
      '--requirement', 'reject whitespace',
      '--requirement', 'reject a missing at-sign',
    ], root);
    assert.equal(t.status, 0, t.stdout + t.stderr);

    // The registered task must carry the declared kind AND both requirements — the values, not
    // just the flag tokens.
    const rec = JSON.parse(fs.readFileSync(path.join(root, '.canary', 'task', 'current.json'), 'utf8')) as {
      kinds?: string[]; requirementCount?: number; requirementDigests?: string[];
    };
    assert.deepEqual(rec.kinds, ['multi'], `the declared kind was lost: ${JSON.stringify(rec)}`);
    assert.equal(rec.requirementCount, 2, `the requirements were lost: ${JSON.stringify(rec)}`);
    assert.equal(new Set(rec.requirementDigests).size, 2, 'both requirement VALUES were registered');

    // And neither requirement text leaked into the intent digest: the intent is the intent.
    const intentDigest = materialDigest('add the validation rules');
    assert.ok(!rec.requirementDigests!.includes(intentDigest), 'the intent must not be registered as a requirement');

    // The new gate, on the same registration: `work` refuses and opens nothing.
    const w = canary([
      'work', 'flagged', 'add the validation rules',
      '--kind', 'multi',
      '--requirement', 'reject whitespace',
      '--requirement', 'reject a missing at-sign',
    ], root);
    assert.equal(w.status, 2, `an unbound requirement must refuse the handoff: ${w.stdout}${w.stderr}`);
    assert.match(w.stdout + w.stderr, /REQUIREMENT UNBOUND/);
    assert.ok(!fs.existsSync(path.join(root, '.canary', 'candidates', 'flagged.json')),
      'the refusal must not have opened a candidate');
  });
});

describe('v1.3: work never hands a worker a task that nothing could judge', () => {
  it('refuses the handoff, opens nothing and spends nothing, when the task freezes no authority', () => {
    const root = fixture('work-unjudgeable');
    assert.equal(canary(['setup', '--yes'], root).status, 0);
    const before = head(root);
    // An intent that matches no kind pattern. MEASURED at v1.2: this exited 0, opened a candidate and
    // printed `next: ... canary finish`, and the correct fix that followed was then refused with
    // `task-authority UNPROVEN` — after the whole session. The refusal belongs BEFORE the handoff.
    const w = canary(['work', 'fix', 'Reject empty names in greeting()'], root);
    assert.equal(w.status, 2, `an unjudgeable task must refuse the handoff:\n${w.stdout}${w.stderr}`);
    assert.match(w.stdout + w.stderr, /CANNOT BE JUDGED/);
    assert.match(w.stdout + w.stderr, /--kind/, 'the refusal must name the one thing the human must supply');
    assert.match(w.stdout + w.stderr, /NOT started/, 'it must say plainly that nothing was launched');
    assert.ok(!fs.existsSync(path.join(root, '.canary', 'candidates', 'fix.json')),
      'the refusal must not have opened a candidate');
    assert.ok(!fs.existsSync(candidate(root, 'fix')), 'and no worktree may exist');
    assert.equal(head(root), before, 'and the trusted base must not move');
  });

  it('the SAME intent is accepted once a kind is declared — the refusal names the real difference', () => {
    const root = fixture('work-judgeable');
    assert.equal(canary(['setup', '--yes'], root).status, 0);
    const w = canary(['work', 'fix', 'Reject empty names in greeting()', '--kind', 'bugfix'], root);
    assert.equal(w.status, 0, `declaring a kind must open the candidate:\n${w.stdout}${w.stderr}`);
    const rec = JSON.parse(fs.readFileSync(path.join(root, '.canary', 'candidates', 'fix.json'), 'utf8')) as { intent?: { task?: { kinds?: string[] } } };
    assert.deepEqual(rec.intent?.task?.kinds, ['bugfix'], 'the declared kind is what the candidate freezes');
  });
});

describe('1.1 workflow: finish cannot promote what was not proven', () => {
  it('an UNPROVEN objective duty blocks promotion and leaves the base untouched', () => {
    const root = fixture('finish-blocked');
    assert.equal(canary(['setup', '--yes'], root).status, 0);
    const before = head(root);
    assert.equal(canary(['work', 'fix', 'fix the tolerance bug'], root).status, 0);

    const cand = candidate(root, 'fix');
    fs.appendFileSync(path.join(cand, 'app.js'), '// a change with no regression test\n');
    commitIn(cand, 'change without evidence');

    const f = canary(['finish', 'fix'], root);
    assert.equal(f.status, 2, `finish must refuse:\n${f.stdout}`);
    assert.match(f.stdout, /NOT PROVEN/);
    assert.match(f.stdout, /regression-evidence/);
    assert.equal(head(root), before, 'a NOT PROVEN candidate must never move the base');
  });

  it('an unknown candidate is refused and the base is untouched', () => {
    const root = fixture('finish-unknown');
    assert.equal(canary(['setup', '--yes'], root).status, 0);
    const before = head(root);
    const f = canary(['finish', 'nope'], root);
    assert.equal(f.status, 2);
    assert.equal(head(root), before);
  });
});

describe('1.1 workflow: finish promotes the exact committed candidate once the duties hold', () => {
  it('objective work completes with no human approval', () => {
    const root = fixture('finish-proven');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'finish-proven', scripts: { test: 'node --test regression.test.js' } }));
    fs.writeFileSync(path.join(root, 'regression.test.js'), 'import assert from "node:assert/strict";\nassert.equal(1, 1);\n');
    commitIn(root, 'declare the regression runner');
    assert.equal(canary(['setup', '--yes'], root).status, 0);
    const before = head(root);
    assert.equal(canary(['work', 'fix', 'fix the tolerance bug'], root).status, 0);

    const cand = candidate(root, 'fix');
    fs.writeFileSync(path.join(cand, 'app.js'), 'export const tolerance = 0.2; // the fix\n');
    // the duty the blocked case named: a test that came with the change
    fs.writeFileSync(path.join(cand, 'regression.test.js'), 'import assert from "node:assert/strict";\nimport { tolerance } from "./app.js";\nassert.equal(tolerance, 0.2);\n');
    commitIn(cand, 'the fix, with its regression test');

    const f = canary(['finish', 'fix'], root);
    assert.equal(f.status, 0, `finish must promote:\n${f.stdout}\n${f.stderr}`);
    assert.match(f.stdout, /promoted/i);
    assert.notEqual(head(root), before, 'an eligible candidate must be promoted');
    // the promoted bytes are the candidate's
    assert.match(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), /the fix/);
    assert.ok(fs.existsSync(path.join(root, 'regression.test.js')), 'the evidence travels with the change');
  });
});
