import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validateSpec, planArms } from '../src/index.js';

const GOOD = {
  schema: 2,
  id: 'demo-case',
  dependency: { package: 'axios', baseline: '0.27.2', candidate: '1.0.0' },
  downstream: { repo: 'ctimmerm/axios-mock-adapter', commit: 'b8804442837556a2c7673caeb2925688991b610c' },
  commands: {
    prepare: [['$npm', 'install', '--before=2022-10-04T00:00:00Z']],
    toolchainOverrides: [['$npm', 'i', '--no-save', 'yargs@16.2.2']],
    build: null,
    swap: ['$npm', 'install', '--no-save', '{dep}@{candidate}'],
    test: ['$bin:mocha'],
  },
  repeats: { baseline: 2, candidate: 3 },
};

const clone = (): typeof GOOD => JSON.parse(JSON.stringify(GOOD));

describe('validateSpec', () => {
  it('accepts the golden shape', () => {
    const v = validateSpec(GOOD);
    assert.ok(v.ok, v.errors.join('; '));
  });

  it('rejects branch/tag names instead of full SHAs', () => {
    const s = clone();
    (s.downstream as { commit: string }).commit = 'main';
    assert.ok(validateSpec(s).errors.some((e) => /40-hex/.test(e)));
  });

  it('rejects a swap that does not install the candidate', () => {
    const s = clone();
    s.commands.swap = ['$npm', 'install', 'axios@0.27.2'];
    assert.ok(validateSpec(s).errors.some((e) => /candidate/.test(e)));
  });

  it('requires >=2 candidate repetitions (a regression must reproduce)', () => {
    const s = clone();
    s.repeats = { baseline: 2, candidate: 1 };
    assert.ok(validateSpec(s).errors.some((e) => /reproduction/.test(e)));
  });

  it('requires >=2 baseline rounds so the FLAKY guard is reachable (F8)', () => {
    const s = clone();
    s.repeats = { baseline: 1, candidate: 3 };
    assert.ok(validateSpec(s).errors.some((e) => /baseline/.test(e)));
  });

  it('rejects identical baseline/candidate', () => {
    const s = clone();
    s.dependency.candidate = '0.27.2';
    assert.ok(validateSpec(s).errors.some((e) => /differ/.test(e)));
  });

  it('rejects malformed prepare argv (not array-of-arrays)', () => {
    const s = clone();
    s.commands.prepare = ['$npm', 'install'] as unknown as string[][];
    assert.ok(!validateSpec(s).ok);
  });

  it('rejects non-object input without throwing', () => {
    assert.ok(!validateSpec('nonsense').ok);
    assert.ok(!validateSpec(null).ok);
  });
});

describe('planArms', () => {
  it('orders steps with toolchain between prepare and build', () => {
    assert.deepEqual(planArms(GOOD as never), ['prepare', 'toolchain', 'baseline', 'swap', 'candidate']);
  });
  it('omits toolchain/build when absent', () => {
    const s = clone();
    Reflect.deleteProperty(s.commands, 'toolchainOverrides');
    assert.deepEqual(planArms(s as never), ['prepare', 'baseline', 'swap', 'candidate']);
  });
});
