/**
 * 1.1 §23 — the fast path, WIRED. The decision logic has its own unit tests; this
 * pins the end-to-end behaviour that matters:
 *
 *   - setup SEALS the project's `canary.paths` declaration;
 *   - `doctor --fast` leaves out exactly the declared checks the change missed,
 *     says so loudly, and carries the skips in the JSON envelope;
 *   - WITHOUT `--fast` the full plan runs — the fast path is opt-in;
 *   - a change INSIDE a declaration runs that check as usual.
 *
 * A skip is never a pass, so this also pins that the skip is visible in both the
 * human output and the machine envelope.
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
const PASS = path.join(REPO, 'tooling', 'test-support', 'fixtures', 'f-pass.js');
assert.ok(fs.existsSync(CLI), `build first: ${CLI} missing`);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-fastpath-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const canary = (args: string[], cwd: string) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', timeout: 300_000 });
const git = (args: string[], cwd: string) => spawnSync('git', args, { cwd, encoding: 'utf8' });
const commit = (dir: string, message: string): void => {
  git(['add', '-A'], dir);
  assert.equal(git(['commit', '-m', message], dir).status, 0, 'the fixture commit must succeed');
};

/** A wired fixture whose `typecheck` check declares that it only depends on src/. */
function fixture(name: string): string {
  const root = path.join(TMP, name);
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name,
    scripts: { test: `node "${PASS}"`, typecheck: `node "${PASS}"` },
    canary: { paths: { typecheck: ['src/**'] } },
  }, null, 2));
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'export const v = 1;\n');
  git(['init', '-b', 'main'], root);
  git(['config', 'user.email', 'fast@canary.local'], root);
  git(['config', 'user.name', 'Fast'], root);
  commit(root, 'base');
  return root;
}

describe('1.1 fast path: sealed declaration, opt-in skipping', () => {
  it('setup seals the declaration, and doctor --fast skips only the declared check the change missed', () => {
    const root = fixture('docs-only');
    const setup = canary(['setup', '--yes'], root);
    assert.equal(setup.status, 0, setup.stdout + setup.stderr);
    const cfg = JSON.parse(fs.readFileSync(path.join(root, '.canary', 'canary.local.json'), 'utf8')) as {
      planAuthority?: { stepPaths?: Record<string, string[]> };
    };
    assert.deepEqual(cfg.planAuthority?.stepPaths, { typecheck: ['src/**'] }, 'the declaration must be sealed with the plan');

    // a docs-only change, committed so the diff is against the sealed baseline
    fs.writeFileSync(path.join(root, 'README.md'), '# docs only\n');
    commit(root, 'docs: readme only');

    const fast = canary(['doctor', '--fast', root], root);
    assert.equal(fast.status, 0, fast.stdout + fast.stderr);
    assert.match(fast.stdout, /FAST PATH/, 'the skip must be announced');
    assert.match(fast.stdout, /skipped typecheck: typecheck/, 'the declared check must be left out');
    assert.match(fast.stdout, /skipped typecheck: typecheck[\s\S]*?no changed path is inside the declared paths/, 'the skip must carry its reason');
    assert.ok(!/✓ typecheck/.test(fast.stdout), 'the skipped step must not report a run');
    assert.match(fast.stdout, /✓ tests/, 'the undeclared check must still run');
  });

  it('the JSON envelope carries the skips, so a machine cannot read a fast run as a full one', () => {
    const root = fixture('envelope');
    assert.equal(canary(['setup', '--yes'], root).status, 0);
    fs.writeFileSync(path.join(root, 'README.md'), '# docs only\n');
    commit(root, 'docs: readme only');

    const r = canary(['doctor', '--json', '--fast', root], root);
    assert.equal(r.status, 0, r.stderr);
    const env = JSON.parse(r.stdout) as { status: string; skipped?: Array<{ step: string; reason: string }> };
    assert.equal(env.status, 'READY');
    assert.ok(Array.isArray(env.skipped) && env.skipped.length === 1, JSON.stringify(env));
    assert.equal(env.skipped![0]!.step, 'typecheck');
    assert.match(env.skipped![0]!.reason, /no changed path is inside/);
  });

  it('without --fast the full plan runs (the fast path is opt-in)', () => {
    const root = fixture('opt-in');
    assert.equal(canary(['setup', '--yes'], root).status, 0);
    fs.writeFileSync(path.join(root, 'README.md'), '# docs only\n');
    commit(root, 'docs: readme only');

    const normal = canary(['doctor', root], root);
    assert.equal(normal.status, 0, normal.stdout + normal.stderr);
    assert.match(normal.stdout, /✓ typecheck/, 'the declared check must run when the flag is absent');
    assert.match(normal.stdout, /✓ tests/);
    assert.ok(!/FAST PATH/.test(normal.stdout));
  });

  it('a change INSIDE the declaration runs the check as usual', () => {
    const root = fixture('src-change');
    assert.equal(canary(['setup', '--yes'], root).status, 0);
    fs.appendFileSync(path.join(root, 'src', 'app.js'), '// touched\n');
    commit(root, 'feat: touch src');

    const fast = canary(['doctor', '--fast', root], root);
    assert.equal(fast.status, 0, fast.stdout + fast.stderr);
    assert.match(fast.stdout, /✓ typecheck/, 'a declared path changed, so the check must run');
    assert.ok(!/FAST PATH/.test(fast.stdout), 'nothing may be skipped');
  });

  it('a malformed declaration is refused at setup rather than quietly ignored', () => {
    const root = fixture('bad-declaration');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
    (pkg.canary as Record<string, unknown>).paths = { nosuchcheck: ['src/**'] };
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg, null, 2));
    commit(root, 'chore: declare paths for a check that does not exist');

    const setup = canary(['setup', '--yes'], root);
    assert.equal(setup.status, 2, setup.stdout);
    assert.match(setup.stdout, /REFUSED/);
    assert.match(setup.stdout, /not a check in the sealed plan/);
    assert.ok(!fs.existsSync(path.join(root, '.canary', 'canary.local.json')), 'a refused seal must write no config');
  });
});
