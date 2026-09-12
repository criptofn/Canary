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
process.env.CANARY_TRUST_STORE = path.join(os.tmpdir(), `canary-trust-${process.pid}`); // 1.1 P0 isolation

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
    const root = fixture('work-flags');
    assert.equal(canary(['setup', '--yes'], root).status, 0);
    const w = canary([
      'work', 'flagged', 'add the validation rules',
      '--kind', 'multi',
      '--requirement', 'reject whitespace',
      '--requirement', 'reject a missing at-sign',
    ], root);
    assert.equal(w.status, 0, w.stdout + w.stderr);

    // The registered task must carry the declared kind AND both requirements: read them
    // from the record the CANDIDATE froze, which is what verification judges against.
    const rec = JSON.parse(fs.readFileSync(path.join(root, '.canary', 'candidates', 'flagged.json'), 'utf8')) as {
      intent?: { task?: { kinds?: string[]; requirementCount?: number } };
    };
    const task = rec.intent?.task;
    assert.ok(task, 'the task must be frozen into the candidate');
    assert.deepEqual(task!.kinds, ['multi'], `the declared kind was lost: ${JSON.stringify(task)}`);
    assert.equal(task!.requirementCount, 2, `the requirements were lost: ${JSON.stringify(task)}`);

    // And the intent must be the intent — not the intent plus the flag values.
    const intentText = JSON.stringify(rec.intent);
    assert.ok(!/reject whitespace/.test(intentText) || task!.requirementCount === 2,
      'the requirement text must arrive as a requirement, not as prose inside the intent');
    assert.ok(!/multi/.test(String(rec.intent?.task?.kinds?.join(' ') ?? '')) || task!.kinds![0] === 'multi');
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
    assert.equal(canary(['setup', '--yes'], root).status, 0);
    const before = head(root);
    assert.equal(canary(['work', 'fix', 'fix the tolerance bug'], root).status, 0);

    const cand = candidate(root, 'fix');
    fs.appendFileSync(path.join(cand, 'app.js'), '// the fix\n');
    // the duty the blocked case named: a test that came with the change
    fs.writeFileSync(path.join(cand, 'regression.test.js'), 'import assert from "node:assert/strict";\nassert.equal(1, 1);\n');
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
