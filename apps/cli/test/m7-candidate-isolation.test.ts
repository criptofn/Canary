/**
 * M7 contract tests — candidate isolation mechanics under the FAKE-git posture
 * (a bare .git DIRECTORY resolves nothing, exactly how onboarding tests pin
 * fail-closed behavior). The full end-to-end story on REAL git — worktree
 * creation, drift-before-execution, FAIL-leaves-base-untouched, dirty-remove
 * refusal, Unicode/space paths — is proven in tooling/probes/
 * m7-candidate-isolation.mjs, because the whole point of M7 is real git.
 *
 * What is pinned here: the CLI surface (misuse exit 3, refuse exit 2), the
 * trusted-base gate, registry shape-validation (a hand-edited record is
 * never trusted), the base-binding impersonation gate, LOST candidates
 * producing honest BLOCKED bundles, and the extended bundle writer keeping
 * every pre-existing field intact while adding plainly-labeled candidate
 * observation fields. NO PROOF, NO DONE: fake git must never yield a PASS.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const CLI = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');
const FX = (f: string) => path.join(REPO, 'tooling', 'test-support', 'fixtures', f);

test('built CLI exists (run npm run build first)', () => {
  assert.ok(fs.existsSync(CLI), `missing ${CLI}`);
});

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-m7-'));
const canary = (args: string[], cwd: string, input?: string) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd, input, encoding: 'utf8', timeout: 120_000 });
const fx = (f: string) => `node "${FX(f)}"`;

function makeProject(name: string): string {
  const root = path.join(TMP, name);
  fs.mkdirSync(path.join(root, '.git'), { recursive: true }); // FAKE git: probes answer nothing
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(
    { name, private: true, scripts: { test: fx('f-pass.js') } }, null, 2));
  return root;
}
function setUpProject(name: string): string {
  const root = makeProject(name);
  const r = canary(['setup', '--yes', root], root);
  assert.equal(r.status, 0, `setup failed: ${r.stdout}${r.stderr}`);
  return root;
}
const readCfg = (root: string) => JSON.parse(fs.readFileSync(path.join(root, '.canary', 'canary.local.json'), 'utf8'));
const candDir = (root: string) => path.join(root, '.canary', 'candidates');
const recPath = (root: string, name: string) => path.join(candDir(root), `${name}.json`);
const latestBundle = (root: string) => {
  const d = path.join(root, '.canary', 'evidence');
  const dirs = fs.readdirSync(d).filter((x) => x.endsWith('-candidate')).sort();
  assert.ok(dirs.length > 0, 'no candidate bundle');
  return JSON.parse(fs.readFileSync(path.join(d, dirs.at(-1)!, 'verification.json'), 'utf8'));
};

try {
  // ---------- CLI surface: exit 3 is the human's typo, not a verdict ----------
  test('isolate misuse exits 3 with usage, and never touches the repo', () => {
    const root = setUpProject('misuse');
    for (const args of [
      ['isolate'],
      ['isolate', '--verify'],                      // name missing
      ['isolate', '--remove'],
      ['isolate', 'bad name!'],                     // space + punctuation
      ['isolate', '../escape'],                     // path separator
      ['isolate', '--list', '--verify', 'x'],       // two modes
      ['isolate', '--base', 'HEAD', '--list'],      // create-only flag on list
      ['isolate', 'n1', '--discard'],               // remove-only flag on create
      ['isolate', '--frobnicate'],
    ]) {
      const r = canary(args, root);
      assert.equal(r.status, 3, `${args.join(' ')} => exit ${r.status}: ${r.stdout}`);
      assert.match(r.stdout, /usage: canary isolate/);
    }
    assert.ok(!fs.existsSync(candDir(root)), 'misuse must not create the registry dir');
  });

  // ---------- the trusted-base gate ----------
  test('isolate refuses a repo Canary does not verify (no config, exit 2)', () => {
    const root = makeProject('no-config');
    const r = canary(['isolate', 'c1', root], root);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /no \.canary config/);
  });

  test('isolate refuses a base whose own config is distrusted', () => {
    const root = setUpProject('distrust');
    const cfg = readCfg(root);
    cfg.cliPath = path.join(TMP, 'somebody-elses-cli.js'); // stale copy => untrusted
    fs.writeFileSync(path.join(root, '.canary', 'canary.local.json'), JSON.stringify(cfg));
    const r = canary(['isolate', '--list', root], root);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /not trusted/);
  });

  test('create refuses under fake git — an unresolvable base cannot be isolated from (and nothing registers)', () => {
    const root = setUpProject('fake-git');
    const r = canary(['isolate', 'c1', root], root);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /identity is unresolvable/);
    assert.ok(!fs.existsSync(recPath(root, 'c1')), 'a refused isolation must not register');
    assert.ok(!fs.existsSync(path.join(candDir(root), 'c1')), 'nor leave a worktree');
  });

  // ---------- registry validation: records are untrusted bytes ----------
  test('verify refuses a malformed or name-mismatched record without executing anything', () => {
    const root = setUpProject('bad-records');
    fs.mkdirSync(candDir(root), { recursive: true });
    fs.writeFileSync(recPath(root, 'garbage'), 'not json{{');
    fs.writeFileSync(recPath(root, 'liar'), JSON.stringify({
      schema: 'canary-candidate/1', name: 'someone-else', root: TMP, baseRoot: root,
      baseRef: 'HEAD', baseHead: 'f'.repeat(40), baseTree: null, createdAt: new Date().toISOString(),
    }));
    for (const nm of ['garbage', 'liar']) {
      const r = canary(['isolate', '--verify', nm, root], root);
      assert.equal(r.status, 2, nm);
      assert.match(r.stdout, /malformed/, nm);
    }
    fs.rmSync(recPath(root, 'garbage')); fs.rmSync(recPath(root, 'liar'));
  });

  test('verify refuses a record whose baseRoot is not this repo (impersonation guard, before any identity read)', () => {
    const root = setUpProject('impostor');
    const other = makeProject('imp-elsewhere');
    fs.mkdirSync(candDir(root), { recursive: true });
    fs.writeFileSync(recPath(root, 'x'), JSON.stringify({
      schema: 'canary-candidate/1', name: 'x', root: other, baseRoot: other,
      baseRef: 'HEAD', baseHead: 'a'.repeat(40), baseTree: null, createdAt: new Date().toISOString(),
    }));
    const r = canary(['isolate', '--verify', 'x', root], root);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /different base/);
    // and no evidence was written for a tree this repo cannot bind
    assert.deepEqual(fs.readdirSync(path.join(root, '.canary', 'evidence')).filter((x) => x.endsWith('-candidate')), [], 'pre-binding refusal writes no candidate bundle');
  });

  test('verify of a LOST candidate (fake git => unresolvable) blocks honestly and writes a BLOCKED bundle', () => {
    const root = setUpProject('lost');
    fs.mkdirSync(candDir(root), { recursive: true });
    const where = path.join(root, '.canary', 'candidates', 'gone');
    fs.writeFileSync(recPath(root, 'gone'), JSON.stringify({
      schema: 'canary-candidate/1', name: 'gone', root: where, baseRoot: root,
      baseRef: 'main', baseHead: 'b'.repeat(40), baseTree: 'c'.repeat(40), createdAt: '2026-09-07T00:00:00.000Z',
    }));
    const r = canary(['isolate', '--verify', 'gone', root], root);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /BLOCKED/);
    assert.match(r.stdout, /not a resolvable git tree/);
    assert.match(r.stdout, /nothing ran/);
    const b = latestBundle(root);
    assert.equal(b.source, 'candidate');
    assert.equal(b.status, 'blocked');
    assert.equal(b.trustClass, 'CANARY_OBSERVED');
    assert.deepEqual(b.steps, [], 'a block is not an execution');
    // the extended bundle keeps every M2-M4 field honest:
    assert.equal(typeof b.schema, 'string');
    assert.equal(b.candidate.resolved, false, 'identity comes from the SUBJECT tree, not the base');
    assert.equal(b.cwd, where, 'cwd names the candidate');
    assert.equal(b.candidateName, 'gone');
    assert.equal(b.candidateRoot, where);
    assert.deepEqual(b.isolatedFrom, { ref: 'main', head: 'b'.repeat(40), tree: 'c'.repeat(40), at: '2026-09-07T00:00:00.000Z' });
    assert.equal(b.provenance.planDigest.length, 64);
    // the companion hash still binds the bytes (tamper-evidence, not signature)
    const ed = path.join(root, '.canary', 'evidence');
    const bdir = path.join(ed, fs.readdirSync(ed).filter((x) => x.endsWith('-candidate')).sort().at(-1)!);
    assert.match(JSON.parse(fs.readFileSync(path.join(bdir, 'verification.sha256'), 'utf8')).label, /tamper-evidence only/);
  });

  test('under fake git, verify can NEVER report PASS — the fail-closed ceiling of the whole contract layer', () => {
    const root = setUpProject('no-pass');
    fs.mkdirSync(candDir(root), { recursive: true });
    fs.writeFileSync(recPath(root, 'q'), JSON.stringify({
      schema: 'canary-candidate/1', name: 'q', root, baseRoot: root, // even self-pointing
      baseRef: 'HEAD', baseHead: 'd'.repeat(40), baseTree: null, createdAt: new Date().toISOString(),
    }));
    const r = canary(['isolate', '--verify', 'q', root], root);
    assert.notEqual(r.status, 0);
    assert.ok(!r.stdout.includes('CANDIDATE PASS'), r.stdout);
  });

  // ---------- list / remove surface ----------
  test('list is honest with no registry, survives invalid records, and exits 0 (it never executes anything)', () => {
    const root = setUpProject('list-empty');
    let r = canary(['isolate', '--list', root], root);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /no candidates registered/);
    fs.mkdirSync(candDir(root), { recursive: true });
    fs.writeFileSync(path.join(candDir(root), 'weird name.json'), '{}');
    fs.writeFileSync(recPath(root, 'ok'), '{{{');
    r = canary(['isolate', '--list', root], root);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /INVALID/);
  });

  test('remove refuses unregistered names; a vanished candidate is pruned honestly (record deleted, exit 0)', () => {
    const root = setUpProject('remove');
    let r = canary(['isolate', '--remove', 'ghost', root], root);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /nothing removed/);
    fs.mkdirSync(candDir(root), { recursive: true });
    fs.writeFileSync(recPath(root, 'gone2'), JSON.stringify({
      schema: 'canary-candidate/1', name: 'gone2', root: path.join(root, 'nope'), baseRoot: root,
      baseRef: 'HEAD', baseHead: 'e'.repeat(40), baseTree: null, createdAt: new Date().toISOString(),
    }));
    r = canary(['isolate', '--remove', 'gone2', root], root);
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /REMOVED/);
    assert.ok(!fs.existsSync(recPath(root, 'gone2')));
  });

  // ---------- review-round additions: ownership boundaries the CLI CAN prove under fake git ----------
  test('uninstall refuses to delete .canary while candidates are registered (worker trees stay protectable)', () => {
    const root = setUpProject('uninst');
    fs.mkdirSync(candDir(root), { recursive: true });
    fs.writeFileSync(recPath(root, 'keep'), JSON.stringify({
      schema: 'canary-candidate/1', name: 'keep', root: path.join(root, 'nope'), baseRoot: root,
      baseRef: 'HEAD', baseHead: 'a'.repeat(40), baseTree: null, createdAt: new Date().toISOString(),
    }));
    const r = canary(['uninstall', root], root);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stdout, /candidates are still registered/);
    assert.ok(fs.existsSync(recPath(root, 'keep')), 'refusal must keep the candidate record');
    assert.ok(fs.existsSync(path.join(root, '.canary', 'canary.local.json')), 'refusal must keep the config so the retry can find its hooks');
    fs.rmSync(candDir(root), { recursive: true, force: true });
    const r2 = canary(['uninstall', root], root);
    assert.equal(r2.status, 0, r2.stdout);
    assert.ok(!fs.existsSync(path.join(root, '.canary')), 'with candidates gone, uninstall completes as before');
  });

  if (process.platform === 'win32') {
    test('Windows reserved device names are rejected as candidate names (misuse exit 3, before any git or filesystem work)', () => {
      const root = setUpProject('reserved');
      for (const nm of ['con', 'nul', 'COM5', 'lpt9']) {
        const r = canary(['isolate', nm, root], root);
        assert.equal(r.status, 3, `${nm} => exit ${r.status}: ${r.stdout}`);
        assert.match(r.stdout, /reserved Windows device name/i, nm);
      }
      assert.ok(!fs.existsSync(candDir(root)), 'reserved-name misuse must not create the registry dir');
    });
  }
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}
