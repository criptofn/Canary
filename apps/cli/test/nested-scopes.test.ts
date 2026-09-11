/**
 * v1.1 item B — explicit, deterministic nested ecosystem scopes.
 *
 * The rule this file exists to pin: a plan is SEALED AUTHORITY, so the set of
 * directories that contribute checks is stated by the human in
 * `canary.scopes.json` and NOTHING ELSE is ever added. No walk, no heuristics,
 * no "it looked like a project". The failure mode being prevented is concrete
 * and lives in this very repository: root-only discovery is why
 * `archive/python-golden-prototype/pyproject.toml` does not silently contribute
 * a pytest step to Canary's own plan, and a declaration must not become a
 * loophole that re-opens the same door by accident.
 *
 * Also pinned: a declaration Canary cannot honour is REFUSED in full — never
 * partially applied, never quietly reduced to the entries that happened to
 * validate, because shipping a plan that silently omits a check the human asked
 * for is worse than shipping none.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, describe, it } from 'node:test';

process.env.CANARY_TRUST_STORE = path.join(os.tmpdir(), `canary-nested-${process.pid}`);

import { SCOPES_FILE, SCOPES_SCHEMA, composePlan, readScopeDeclaration } from '../src/project.js';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const CLI = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-nested-scopes-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function dir(name: string, files: Record<string, string>): string {
  const root = path.join(TMP, name);
  fs.mkdirSync(root, { recursive: true });
  for (const [f, text] of Object.entries(files)) {
    const p = path.join(root, f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
  return root;
}
const nodePkg = (scripts: Record<string, string>): string => JSON.stringify({ name: 'fx', private: true, scripts }, null, 2);
const decl = (scopes: unknown): string => JSON.stringify({ schema: SCOPES_SCHEMA, scopes }, null, 2);
const where = (root: string) => composePlan(root).scopes.map((s) => `${s.scope || '.'}:${s.adapter.id}`);

/** The layout the feature is for, with a decoy tree that must NEVER be reached. */
const POLYGLOT: Record<string, string> = {
  'web/package.json': nodePkg({ test: 'node -e "process.exit(0)"' }),
  'backend/pyproject.toml': '[project]\nname = "backend"\nversion = "0.1.0"\n',
  'service/go.mod': 'module example.com/service\n\ngo 1.22\n',
  // decoys: real projects, in trees nobody declared
  'archive/python-golden-prototype/pyproject.toml': '[project]\nname = "archived"\nversion = "0.0.1"\n',
  'examples/toy/package.json': nodePkg({ test: 'node -e "process.exit(0)"' }),
  'vendor/thing/go.mod': 'module example.com/vendored\n\ngo 1.22\n',
};

describe('no declaration — root only, and subdirectories never add authority', () => {
  it('a repo with only nested manifests composes an EMPTY plan', () => {
    const root = dir('no-decl', POLYGLOT);
    const composed = composePlan(root);
    assert.deepEqual(composed.scopes, [], 'nothing is at the root, so nothing is discovered');
    assert.deepEqual(composed.plan, []);
    assert.equal(composed.scopeSource, 'root-only');
    assert.deepEqual(composed.problems, []);
    assert.equal(readScopeDeclaration(root).scopes.length, 0, 'absent file is not a declaration');
  });

  it('a root manifest is the only contributor; archive/ and examples/ stay out', () => {
    const root = dir('root-only', { ...POLYGLOT, 'package.json': nodePkg({ test: 'node -e "process.exit(0)"' }) });
    assert.deepEqual(where(root), ['.:node'], 'exactly the root, exactly one scope');
    assert.equal(composePlan(root).scopeSource, 'root-only');
  });
});

describe('a declaration names exactly the scopes that count', () => {
  it('web/ Node + backend/ Python + service/ Go compose the declared set only', () => {
    const root = dir('declared', { ...POLYGLOT, [SCOPES_FILE]: decl([
      { path: 'web', ecosystem: 'node' },
      { path: 'backend', ecosystem: 'python' },
      { path: 'service', ecosystem: 'go' },
    ]) });
    const composed = composePlan(root);
    assert.deepEqual(composed.problems, []);
    assert.equal(composed.scopeSource, 'declared');
    assert.deepEqual(where(root), ['backend:python', 'service:go', 'web:node'], 'sorted by path, deterministic');
    for (const s of composed.plan) {
      assert.ok(s.scope !== undefined && ['web', 'backend', 'service'].includes(s.scope),
        `step ${s.kind} ran outside every declared scope: ${JSON.stringify(s)}`);
    }
    // the decoys are real projects and are still NOT represented anywhere
    const joined = JSON.stringify(composed);
    for (const decoy of ['archive', 'examples', 'vendor']) {
      assert.ok(!joined.includes(decoy), `undeclared tree "${decoy}" leaked into the plan`);
    }
  });

  it('the root still contributes when it declares checks AND scopes are declared', () => {
    const root = dir('root-plus', {
      ...POLYGLOT,
      'package.json': nodePkg({ test: 'node -e "process.exit(0)"' }),
      [SCOPES_FILE]: decl([{ path: 'service', ecosystem: 'go' }]),
    });
    assert.deepEqual(where(root), ['.:node', 'service:go']);
  });

  it('declaration ORDER is cosmetic: it cannot change the sealed plan', () => {
    const a = dir('order-a', { ...POLYGLOT, [SCOPES_FILE]: decl([
      { path: 'web', ecosystem: 'node' }, { path: 'backend', ecosystem: 'python' }, { path: 'service', ecosystem: 'go' },
    ]) });
    const b = dir('order-b', { ...POLYGLOT, [SCOPES_FILE]: decl([
      { path: 'service', ecosystem: 'go' }, { path: 'web', ecosystem: 'node' }, { path: 'backend', ecosystem: 'python' },
    ]) });
    assert.deepEqual(where(a), where(b), 'reordering a declaration must not re-order authority');
    assert.deepEqual(composePlan(a).plan.map((s) => `${s.scope}:${s.kind}`),
      composePlan(b).plan.map((s) => `${s.scope}:${s.kind}`));
  });

  it('two ecosystems may share one scope directory (a genuinely polyglot directory)', () => {
    const root = dir('shared-dir', {
      'mixed/package.json': nodePkg({ test: 'node -e "process.exit(0)"' }),
      'mixed/go.mod': 'module example.com/mixed\n\ngo 1.22\n',
      [SCOPES_FILE]: decl([
        { path: 'mixed', ecosystem: 'node' },
        { path: 'mixed', ecosystem: 'go' },
      ]),
    });
    assert.deepEqual(composePlan(root).problems, []);
    assert.deepEqual(where(root), ['mixed:go', 'mixed:node']);
  });
});

describe('an unusable declaration is REFUSED in full, never partially applied', () => {
  const bad: Array<[string, string, RegExp]> = [
    ['not JSON', '{ this is not json', /not valid JSON/],
    ['wrong schema', JSON.stringify({ schema: 'canary-scopes/99', scopes: [{ path: 'web', ecosystem: 'node' }] }), /must declare "schema"/],
    ['empty scopes', decl([]), /non-empty "scopes" array/],
    ['scopes not an array', JSON.stringify({ schema: SCOPES_SCHEMA, scopes: { path: 'web' } }), /non-empty "scopes" array/],
    ['unknown ecosystem', decl([{ path: 'web', ecosystem: 'cobol' }]), /is not one Canary can model/],
    ['absolute path', decl([{ path: '/etc', ecosystem: 'node' }]), /must be repo-relative, not absolute/],
    ['drive-qualified path', decl([{ path: 'C:/x', ecosystem: 'node' }]), /drive-qualified/],
    ['parent traversal', decl([{ path: '../outside', ecosystem: 'node' }]), /must not contain "\." or "\.\."/],
    ['backslash', decl([{ path: 'web\\sub', ecosystem: 'node' }]), /must use forward slashes/],
    ['hidden segment', decl([{ path: 'web/.hidden', ecosystem: 'node' }]), /is hidden/],
    ['dependency store', decl([{ path: 'node_modules/pkg', ecosystem: 'node' }]), /dependency or build store/],
    ['build output', decl([{ path: 'website/dist', ecosystem: 'node' }]), /dependency or build store/],
    ['missing directory', decl([{ path: 'nope', ecosystem: 'node' }]), /is not a directory/],
    ['duplicate entry', decl([{ path: 'web', ecosystem: 'node' }, { path: 'web', ecosystem: 'node' }]), /declared twice/],
    ['file instead of object', JSON.stringify({ schema: SCOPES_SCHEMA, scopes: ['web'] }), /must be an object/],
  ];

  for (const [name, text, re] of bad) {
    it(`refuses: ${name}`, () => {
      const root = dir(`bad-${name.replace(/[^a-z0-9]+/gi, '-')}`, { ...POLYGLOT, [SCOPES_FILE]: text });
      const composed = composePlan(root);
      assert.ok(composed.problems.length > 0, 'the problem must be reported');
      assert.match(composed.problems.join(' | '), re);
      assert.deepEqual(composed.scopes, [], 'a refused declaration contributes NO scopes');
      assert.deepEqual(composed.plan, [], 'a refused declaration contributes NO checks — never a partial plan');
    });
  }

  it('refuses a scope that declares its ecosystem but has nothing of that ecosystem', () => {
    // The directory exists, the ecosystem id is real, but nothing there declares
    // it: Canary must not invent a check to satisfy the declaration.
    const root = dir('declared-but-empty', {
      'web/package.json': nodePkg({ test: 'node -e "process.exit(0)"' }),
      'backend/README.md': 'no python here\n',
      [SCOPES_FILE]: decl([
        { path: 'web', ecosystem: 'node' },
        { path: 'backend', ecosystem: 'python' },
      ]),
    });
    const composed = composePlan(root);
    assert.match(composed.problems.join(' | '), /but nothing there declares it/);
    assert.deepEqual(composed.scopes, [], 'the valid web/ entry is NOT applied on its own');
  });

  it('reports EVERY problem, not just the first', () => {
    const root = dir('many-problems', { [SCOPES_FILE]: decl([
      { path: '/abs', ecosystem: 'node' },
      { path: 'x', ecosystem: 'cobol' },
    ]) });
    assert.equal(composePlan(root).problems.length, 2, 'both defects must be named in one run');
  });
});

describe('the CLI refuses an unusable declaration instead of shipping a partial plan', () => {
  it('setup exits 2, names the declaration file, and writes no config', () => {
    assert.ok(fs.existsSync(CLI), `build first: ${CLI} missing`);
    const root = dir('cli-refusal', {
      'web/package.json': nodePkg({ test: 'node -e "process.exit(0)"' }),
      [SCOPES_FILE]: decl([{ path: 'web', ecosystem: 'cobol' }]),
    });
    const g = spawnSync('git', ['-C', root, 'init', '-b', 'main'], { encoding: 'utf8' });
    assert.equal(g.status, 0, g.stderr);
    const r = spawnSync(process.execPath, [CLI, 'setup', '--yes'], { cwd: root, encoding: 'utf8', timeout: 120_000 });
    assert.equal(r.status, 2, `setup must refuse:\n${r.stdout}`);
    assert.match(`${r.stdout}${r.stderr}`, /SCOPES_FILE|canary\.scopes\.json/);
    assert.match(`${r.stdout}${r.stderr}`, /cobol/);
    assert.ok(!fs.existsSync(path.join(root, '.canary', 'canary.local.json')),
      'a refused setup must not seal authority it could not honour');
  });
});
