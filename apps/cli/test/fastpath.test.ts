/**
 * 1.1 §23 — the fast-path decision, pinned so it can only remove work a sealed
 * declaration justifies. This is the pure half of the feature: no I/O, no
 * spawning, no CLI wiring yet. Every rule in the module header has a test here,
 * including the ones that exist to make the feature FAIL CLOSED.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decideFastPath, pathMatchesGlobs, validateStepPaths } from '../src/fastpath.js';
import type { PlanStep } from '../src/project.js';

const plan: PlanStep[] = [
  { kind: 'typecheck', script: 'typecheck' },
  { kind: 'tests', script: 'test' },
  { kind: 'build', script: 'build' },
];

describe('1.1 fast path: the glob containment check', () => {
  it('** matches zero or more segments, and matching is case-insensitive', () => {
    assert.equal(pathMatchesGlobs('README.md', ['**/*.md']), true, '** must match zero directories');
    assert.equal(pathMatchesGlobs('docs/guide/intro.md', ['**/*.md']), true);
    assert.equal(pathMatchesGlobs('src/app.ts', ['**/*.md']), false);
    assert.equal(pathMatchesGlobs('SRC/App.TS', ['src/**']), true, 'case differences must not turn a match into a skip');
    assert.equal(pathMatchesGlobs('./src/app.ts', ['src/**']), true, 'a leading ./ is not a different file');
    assert.equal(pathMatchesGlobs('src\\app.ts', ['src/**']), true, 'a backslash path is the same path');
  });

  it('* stays inside one segment and ? matches one character', () => {
    assert.equal(pathMatchesGlobs('src/a.ts', ['src/*.ts']), true);
    assert.equal(pathMatchesGlobs('src/nested/a.ts', ['src/*.ts']), false);
    assert.equal(pathMatchesGlobs('src/a.ts', ['src/?.ts']), true);
    assert.equal(pathMatchesGlobs('src/ab.ts', ['src/?.ts']), false);
  });

  it('a bare directory pattern matches the tree under it only when asked', () => {
    assert.equal(pathMatchesGlobs('src/a.ts', ['src/**']), true);
    assert.equal(pathMatchesGlobs('src', ['src/**']), true, 'the directory itself is inside its own tree');
    assert.equal(pathMatchesGlobs('srcx/a.ts', ['src/**']), false, 'a prefix is not a segment match');
  });
});

describe('1.1 fast path: the declaration is refused when it cannot mean what it says', () => {
  const base = (paths: unknown): unknown => ({ 'test': ['**/*.ts'], ...(paths as object) });
  it('accepts a well-formed declaration keyed by sealed step keys', () => {
    assert.deepEqual(validateStepPaths({ test: ['src/**', '**/*.ts'] }, plan), { test: ['src/**', '**/*.ts'] });
    assert.deepEqual(validateStepPaths(undefined, plan), {}, 'absent declaration = empty map, not an error');
  });
  it('refuses steps that are not in the plan, empty lists and non-string patterns', () => {
    assert.throws(() => validateStepPaths({ nosuch: ['src/**'] }, plan), /not a check in the sealed plan/);
    assert.throws(() => validateStepPaths({ test: [] }, plan), /non-empty array/);
    assert.throws(() => validateStepPaths({ test: [''] }, plan), /non-empty string/);
    assert.throws(() => validateStepPaths({ test: [7] }, plan), /non-empty string/);
  });
  it('refuses patterns that could escape the project or smuggle a path', () => {
    assert.throws(() => validateStepPaths({ test: ['../secrets/**'] }, plan), /escape the project root/);
    assert.throws(() => validateStepPaths({ test: ['/etc/**'] }, plan), /relative to the project root/);
    assert.throws(() => validateStepPaths({ test: ['C:/x/**'] }, plan), /relative to the project root/);
    assert.throws(() => validateStepPaths({ test: ['src\\**'] }, plan), /forward slashes only/);
    assert.throws(() => validateStepPaths({ test: ['x'.repeat(201)] }, plan), /longer than/);
    assert.throws(() => validateStepPaths({ test: Array.from({ length: 33 }, () => 'x') }, plan), /more than 32/);
    assert.throws(() => validateStepPaths([], plan), /must be an object/);
  });
  it('the shared base fixture is well-formed (so the refusals above are about what they say)', () => {
    assert.deepEqual(validateStepPaths(base({ test: ['**/*.ts'] }), plan), { test: ['**/*.ts'] });
  });
});

describe('1.1 fast path: it can only remove work a declaration justifies', () => {
  const declared = { test: ['src/**', '**/*.ts'], build: ['src/**', 'package.json'] };

  it('with NO declaration for a step, that step runs — there is no implicit default', () => {
    const d = decideFastPath(plan, {}, ['README.md']);
    assert.deepEqual(d.run.map((s) => s.script), ['typecheck', 'test', 'build']);
    assert.deepEqual(d.skipped, []);
    assert.equal(d.usedFastPath, false);
  });

  it('a docs-only change skips exactly the steps whose declared paths it misses', () => {
    const d = decideFastPath(plan, declared, ['README.md', 'docs/guide.md']);
    assert.deepEqual(d.run.map((s) => s.script), ['typecheck'], 'typecheck was never declared, so it always runs');
    assert.deepEqual(d.skipped.map((s) => s.key), ['test', 'build']);
    assert.equal(d.usedFastPath, true);
    // every skip must be able to explain itself
    for (const s of d.skipped) assert.match(s.reason, /no changed path is inside the declared paths/);
    assert.match(d.skipped[0]!.reason, /2 changed path\(s\) were checked/);
  });

  it('ONE changed path inside the declaration is enough to run the step', () => {
    const d = decideFastPath(plan, declared, ['README.md', 'src/app.ts']);
    assert.deepEqual(d.run.map((s) => s.script), ['typecheck', 'test', 'build']);
    assert.deepEqual(d.skipped, []);
  });

  it('an empty change set runs everything: a skip needs a reason it can show', () => {
    const d = decideFastPath(plan, declared, []);
    assert.deepEqual(d.run.map((s) => s.script), ['typecheck', 'test', 'build']);
    assert.equal(d.usedFastPath, false);
  });

  it('a declaration for a different scope or label does not leak onto another step', () => {
    const scoped: PlanStep[] = [
      { kind: 'tests', script: 'test', adapter: 'node', scope: 'web' },
      { kind: 'tests', script: 'pytest', adapter: 'python', scope: 'backend', argv: ['python', '-m', 'pytest'] },
    ];
    // only the python scope is declared; the node one must still run
    const d = decideFastPath(scoped, { 'backend::pytest': ['backend/**'] }, ['README.md']);
    assert.deepEqual(d.run.map((s) => s.script), ['test']);
    assert.deepEqual(d.skipped.map((s) => s.key), ['backend::pytest']);
  });
});
