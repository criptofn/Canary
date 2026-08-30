import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  diffTrees,
  escapePkgKey,
  extractFailingTestNames,
  inDependencySubtree,
  parseSummaryCounts,
  streamsStable,
} from '../src/index.js';

describe('inDependencySubtree', () => {
  it('matches the dep itself and its nested copies at any depth (escaped keys)', () => {
    assert.ok(inDependencySubtree('axios', 'axios'));
    assert.ok(inDependencySubtree('axios/proxy-from-env', 'axios'));
    assert.ok(inDependencySubtree('bundlesize/axios', 'axios')); // nested copy
    assert.ok(inDependencySubtree('a/b/axios', 'axios'));
  });
  it('scoped name collisions cannot masquerade when keys are escaped (F4)', () => {
    assert.equal(escapePkgKey('@types/axios'), '@types%2Faxios');
    assert.ok(!inDependencySubtree('@types%2Faxios', 'axios')); // NOT a nested copy
    assert.ok(!inDependencySubtree('axios-mock-adapter', 'axios')); // prefix-lookalike
    assert.ok(!inDependencySubtree('lodash', 'axios'));
  });
});

describe('diffTrees — the arms-equality proof', () => {
  it('golden case: only the dependency subtree changed', () => {
    const before = { axios: '0.27.2', 'follow-redirects': '1.15.0', lodash: '4.17.21', chai: '4.3.6' };
    const after = {
      axios: '1.0.0', 'axios/proxy-from-env': '1.1.0',
      'axios/follow-redirects': '1.15.2',
      'follow-redirects': '1.15.0', lodash: '4.17.21', chai: '4.3.6',
    };
    const d = diffTrees(before, after, 'axios');
    assert.ok(d.confined, JSON.stringify(d.other));
  });

  it('detects contamination outside the dependency', () => {
    const d = diffTrees({ axios: '0.27.2', lodash: '4.17.21' }, { axios: '1.0.0', lodash: '4.17.20' }, 'axios');
    assert.ok(!d.confined);
    assert.deepEqual(d.other, ['lodash']);
  });
});

describe('log parsing (auxiliary — never decides classification)', () => {
  const mochaSample = [
    '  MockAdapter basics',
    '    √ handles post requests',
    '',
    '  128 passing (119ms)',
    '  3 failing',
    '',
    '  1) MockAdapter basics',
    '       can pass headers to match to a handler:',
    '     Error: Request failed with status code 404',
    '  2) passThrough tests (requires Node)',
    '       handles baseURL correctly:',
  ].join('\n');

  it('extracts failing test names from mocha output', () => {
    const names = extractFailingTestNames(mochaSample);
    assert.ok(names.includes('can pass headers to match to a handler'));
    assert.ok(names.includes('handles baseURL correctly'));
  });

  it('extracts failing test names from ava output', () => {
    const names = extractFailingTestNames('  ✖ basic › should store cookies to cookiejar');
    assert.ok(names.some((n) => n.includes('should store cookies')));
  });

  it('parses summary counts', () => {
    assert.deepEqual(parseSummaryCounts(mochaSample), { passing: 128, failing: 3, pending: undefined });
  });
});

describe('streamsStable', () => {
  it('true only for identical hashes across all rounds', () => {
    assert.ok(streamsStable(['aa', 'aa', 'aa']));
    assert.ok(!streamsStable(['aa', 'ab']));
    assert.ok(!streamsStable([]));
  });
});
