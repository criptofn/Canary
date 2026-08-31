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
  it('audit F10: a SCOPED dependency matches its own escaped keys', () => {
    // dependency '@scope/pkg' → tree key '@scope%2Fpkg'. The old raw compare
    // ('@scope%2Fpkg' === '@scope/pkg') made the dep's OWN subtree look
    // "not confined"; escaping the dep argument fixes it.
    assert.ok(inDependencySubtree('@scope%2Fpkg', '@scope/pkg'));
    assert.ok(inDependencySubtree('@scope%2Fpkg/child', '@scope/pkg')); // dep's child
    assert.ok(inDependencySubtree('host/@scope%2Fpkg', '@scope/pkg'));  // nested copy
    // and still not a lookalike:
    assert.ok(!inDependencySubtree('other%2Fpkg', '@scope/pkg'));
    assert.ok(!inDependencySubtree('@scope/pkg', '@scope/pkg')); // raw key form is the escaped one in trees
  });
});

describe('diffTrees — the arms-equality proof', () => {
  it('audit F10: scoped dependency drift inside its subtree is confined', () => {
    // treeHash emits ESCAPED keys on BOTH arms — the realistic shape.
    const before = { '@scope%2Fpkg': '1.0.0', 'lodash': '4.17.21' };
    const after = { '@scope%2Fpkg': '2.0.0', 'lodash': '4.17.21' };
    const d = diffTrees(before, after, '@scope/pkg');
    // The changed key is the scoped dep's own copy → confined (previously the
    // raw-vs-escaped mismatch pushed it into `other`).
    assert.ok(d.confined, JSON.stringify(d.other));
  });
  it('audit F10: scoped dep PLUS real external drift is still NOT confined', () => {
    const before = { '@scope%2Fpkg': '1.0.0', 'lodash': '4.17.21' };
    const after = { '@scope%2Fpkg': '2.0.0', 'lodash': '4.17.20' };
    const d = diffTrees(before, after, '@scope/pkg');
    assert.ok(!d.confined);
    assert.deepEqual(d.other, ['lodash']);
  });
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

  it('extracts canonical suite-qualified identities from mocha output (audit B1)', () => {
    const names = extractFailingTestNames(mochaSample);
    assert.ok(names.includes('MockAdapter basics > can pass headers to match to a handler'),
      JSON.stringify(names));
    assert.ok(names.includes('passThrough tests (requires Node) > handles baseURL correctly'),
      JSON.stringify(names));
  });

  it('audit B1: same leaf title in DIFFERENT suites stays DISTINCT', () => {
    const log = [
      '  1) passThrough tests (requires Node)',
      '       handles baseURL correctly:',
      '     TypeError: Invalid URL',
      '  2) onNoMatch=passthrough option tests (requires Node)',
      '       handles baseURL correctly:',
      '     TypeError: Invalid URL',
    ].join('\n');
    const names = extractFailingTestNames(log);
    assert.equal(names.length, 2, `collapse: ${JSON.stringify(names)}`);
    assert.notEqual(names[0], names[1]);
  });

  it('audit B1: nested describe paths survive as multi-segment identities', () => {
    const log = [
      '  1) Outer suite',
      '       Inner suite',
      '         does the thing:',
      '     Error: boom',
    ].join('\n');
    assert.deepEqual(extractFailingTestNames(log), ['Outer suite > Inner suite > does the thing']);
  });

  it('audit B1: progress-list lines (N) followed by a passing line yield NO identity', () => {
    // mocha's inline progress section prints "    1) test title" lines BEFORE
    // the summary; they are not failure-detail blocks and must not fabricate
    // suite-only identities.
    const log = [
      '    1) handles baseURL correctly',
      '    √ handle request with baseURL only',
      '  125 passing',
      '  1 failing',
      '  1) passThrough tests (requires Node)',
      '       handles baseURL correctly:',
      '     TypeError: Invalid URL',
    ].join('\n');
    const names = extractFailingTestNames(log);
    assert.deepEqual(names, ['passThrough tests (requires Node) > handles baseURL correctly']);
  });

  it('audit B1: identical identities in one run dedupe deterministically; distinct never collapse', () => {
    const dup = [
      '  1) Suite S', '       t twice:', '     Error: a',
      '  2) Suite S', '       t twice:', '     Error: b',
      '  3) Suite S', '       u other:', '     Error: c',
    ].join('\n');
    assert.deepEqual(extractFailingTestNames(dup), ['Suite S > t twice', 'Suite S > u other']);
    // order independence of the identity itself is not a thing — mocha numbers
    // are deterministic; verify run-to-run stability by re-extracting.
    assert.deepEqual(extractFailingTestNames(dup), extractFailingTestNames(dup));
  });

  it('audit B1: ava identities keep the full suite path', () => {
    const names = extractFailingTestNames(
      '  ✖ basic › should store cookies to cookiejar\n  ✖ api > users › creates');
    assert.ok(names.includes('basic > should store cookies to cookiejar'), JSON.stringify(names));
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
