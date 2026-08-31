/**
 * Self-review finding N1 — the npm >= 11.19 "missing optional dependency
 * rendered as an empty {} node" compatibility fix lives in TWO independent
 * production implementations: the pipeline's recursive flatten
 * (flattenNpmLsJson) and the verifier's iterative re-flatten
 * (reflattenNpmLs). Before this file only the VERIFIER side had direct
 * regression coverage; the pipeline side was exercised solely by a live
 * golden run on a host whose npm happens to emit `{}` nodes — which the
 * canonical 11.16.0 proof host does not. A future edit could therefore have
 * re-introduced the false-INCOMPLETE bug with a fully green CI.
 *
 * These tests pin:
 *  1. the expected-absent-optional exemption (and its fail-closed edges:
 *     problems-mention, missing:true, declared subtree) on the PIPELINE path;
 *  2. cross-implementation PARITY: both parsers produce identical flat maps
 *     and identical anomaly sets on hostile inputs (they are independent
 *     code paths — parity is a designed invariant, and drift between them
 *     would make honest bundles fail re-verification);
 *  3. that the compatibility path cannot open a permissive hole: empty
 *     trees stay INVALID, a `{}` studied dependency is NOT present (INCOMPLETE),
 *     anomalies cap trust at INCOMPLETE, and confinement semantics are
 *     unchanged.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { flattenNpmLsJson } from '../src/pipeline.js';
import { reflattenNpmLs, statusOfObservation } from '../src/verify-tree.js';
import { classifyTreeObservation, dependencyInTree, inDependencySubtree, diffTrees } from '@canary-rn/comparator';

const J = (o: unknown): string => JSON.stringify(o);

describe('flattenNpmLsJson — npm 11.19 empty-object representation (pipeline path)', () => {
  test('an empty {} node with no problems mention is expected-absent: no anomaly, no hole', () => {
    const out = J({
      name: 'app', version: '1.0.0',
      dependencies: {
        axios: { version: '0.27.2' },
        fsevents: {},
        ws: { version: '8.0.0', dependencies: { bufferutil: {}, 'utf-8-validate': {} } },
      },
    });
    const r = flattenNpmLsJson(out);
    assert.equal(r.parsed, true);
    assert.deepEqual(r.jsonAnomalies, []);
    // the {} nodes record NOTHING — no 'x' sentinel, no key at all
    assert.deepEqual(r.flat, { axios: '0.27.2', ws: '8.0.0' });
    // A complete observation containing the studied dep stays VALID:
    assert.equal(classifyTreeObservation({
      parsed: r.parsed, hasRootDeps: r.hasRootDeps, deps: r.flat,
      dependencyPresent: dependencyInTree(r.flat, 'axios'), anomalies: r.jsonAnomalies,
    }), 'VALID');
  });

  test('the same {} node IS an anomaly when problems mentions it (unmet-optional-that-matters fails closed)', () => {
    const out = J({
      dependencies: { axios: { version: '0.27.2' }, fsevents: {} },
      problems: ['invalid: fsevents@2.3.3 node_modules/fsevents'],
    });
    const r = flattenNpmLsJson(out);
    assert.deepEqual(r.jsonAnomalies, ['missing-version:fsevents']);
  });

  test('a version-less node with missing:true is an anomaly (uninstalled REQUIRED dep)', () => {
    const out = J({ dependencies: { axios: { version: '0.27.2' }, 'left-pad': { missing: true, required: 'left-pad@^1.0.0' } } });
    const r = flattenNpmLsJson(out);
    assert.deepEqual(r.jsonAnomalies, ['missing-version:left-pad']);
  });

  test('a version-less node carrying a declared subtree: missing-version + unwalked-subtree', () => {
    const out = J({
      dependencies: {
        axios: { version: '0.27.2' },
        ghost: { dependencies: { hidden: { version: '1.0.0' } } },
      },
    });
    const r = flattenNpmLsJson(out);
    assert.deepEqual(r.jsonAnomalies, ['missing-version:ghost', 'unwalked-subtree:ghost']);
    assert.ok(!('ghost/hidden' in r.flat), 'the hidden descendant must not be silently adopted');
  });

  test('problems name-matching is token-anchored: "util" is not matched by "bufferutil@1.0.0"', () => {
    const out = J({
      dependencies: { axios: { version: '0.27.2' }, util: {}, bufferutil: {} },
      problems: ['invalid extraneous bufferutil@1.0.0'],
    });
    const r = flattenNpmLsJson(out);
    // 'util@' must not fire inside 'bufferutil@' — util is expected-absent;
    // bufferutil IS mentioned -> anomaly.
    assert.deepEqual(r.jsonAnomalies, ['missing-version:bufferutil']);
  });

  test('non-object node entries are malformed-node anomalies', () => {
    const out = J({ dependencies: { axios: { version: '0.27.2' }, broken: 'yes', nulled: null } });
    const r = flattenNpmLsJson(out);
    assert.deepEqual(r.jsonAnomalies, ['malformed-node:broken', 'malformed-node:nulled', 'missing-version:broken', 'missing-version:nulled']);
  });

  test('empty / effectively-empty trees can NEVER become VALID (criterion 6)', () => {
    const cases: string[] = [
      '{}',                                              // nothing at all
      J({ dependencies: {} }),                           // empty root deps
      J({ dependencies: { fsevents: {}, bufferutil: {} } }), // only expected-absent optionals
    ];
    for (const raw of cases) {
      const r = flattenNpmLsJson(raw);
      const status = classifyTreeObservation({
        parsed: r.parsed, hasRootDeps: r.hasRootDeps, deps: r.flat,
        dependencyPresent: dependencyInTree(r.flat, 'axios'), anomalies: r.jsonAnomalies,
      });
      assert.equal(status, 'INVALID', `must be INVALID: ${raw}`);
    }
  });

  test('a {} node for the STUDIED dependency itself is absence, not presence (criterion 7)', () => {
    const out = J({ dependencies: { axios: {}, other: { version: '1.0.0' } } });
    const r = flattenNpmLsJson(out);
    assert.equal(dependencyInTree(r.flat, 'axios'), false, '{} must not count as the dep being observed');
    assert.equal(classifyTreeObservation({
      parsed: r.parsed, hasRootDeps: r.hasRootDeps, deps: r.flat,
      dependencyPresent: dependencyInTree(r.flat, 'axios'), anomalies: r.jsonAnomalies,
    }), 'INCOMPLETE');
  });

  test('ANY anomaly caps the observation at INCOMPLETE even with the dep present', () => {
    const out = J({ dependencies: { axios: { version: '0.27.2' }, 'left-pad': { missing: true } } });
    const r = flattenNpmLsJson(out);
    assert.equal(r.jsonAnomalies.length, 1);
    assert.equal(classifyTreeObservation({
      parsed: r.parsed, hasRootDeps: r.hasRootDeps, deps: r.flat,
      dependencyPresent: dependencyInTree(r.flat, 'axios'), anomalies: r.jsonAnomalies,
    }), 'INCOMPLETE');
  });
});

describe('cross-implementation parity — pipeline flatten vs verify-tree re-flatten (criteria 2+3)', () => {
  const HOSTILE: Array<[string, string]> = [
    ['plain', J({ dependencies: { axios: { version: '1.0.0' }, 'proxy-from-env': { version: '1.1.0' } } })],
    ['11.19 empty optionals', J({ dependencies: { axios: { version: '1.0.0' }, fsevents: {}, ws: { version: '8.1.0', dependencies: { bufferutil: {} } } } })],
    ['empty optional + problems mention', J({ dependencies: { axios: { version: '1.0.0' }, fsevents: {} }, problems: ['unmet dependency fsevents@2.3.3'] })],
    ['missing required', J({ dependencies: { axios: { version: '1.0.0' }, 'left-pad': { missing: true, required: 'left-pad@1.3.0' } }, problems: ['missing: left-pad@1.3.0 node_modules/left-pad'] })],
    ['scoped names', J({ dependencies: { '@types/axios': {}, axios: { version: '1.0.0' }, '@scope%2Fweird': { version: '0.1.0' } } })],
    ['nested copies', J({ dependencies: { axios: { version: '1.0.0' }, bundlesize: { version: '1.0.0', dependencies: { axios: { version: '0.27.2', dependencies: { 'follow-redirects': { version: '1.5.0' } } } } } } })],
    ['malformed nodes', J({ dependencies: { axios: { version: '1.0.0' }, str: 'x', nul: null, num: 7 } })],
    ['version-less with subtree', J({ dependencies: { axios: { version: '1.0.0' }, ghost: { dependencies: { deep: { version: '1.0.0' } } } } })],
    ['problems only (no deps)', J({ problems: ['invalid axios@1.0.0'], dependencies: { axios: { version: '1.0.0' } } })],
    ['truncated json', '{"dependencies":{"axios":{"version"'],
    ['json scalar', '"just a string"'],
    ['json null', 'null'],
    ['empty root', J({})],
  ];
  for (const [name, raw] of HOSTILE) {
    test(`parity: ${name}`, () => {
      const a = flattenNpmLsJson(raw);
      const b = reflattenNpmLs(raw);
      assert.deepEqual(a.jsonAnomalies, b.anomalies, `anomaly lists diverge for ${name}`);
      assert.deepEqual(a.flat, b.flat, `flat maps diverge for ${name}`);
      assert.equal(a.parsed, b.parsed);
      assert.equal(a.hasRootDeps, b.hasRootDeps);
      // One shared status verdict from each side's own status rule:
      assert.equal(
        classifyTreeObservation({
          parsed: a.parsed, hasRootDeps: a.hasRootDeps, deps: a.flat,
          dependencyPresent: dependencyInTree(a.flat, 'axios'), anomalies: a.jsonAnomalies,
        }),
        statusOfObservation(b, 'axios'),
        `statuses diverge for ${name}`,
      );
    });
  }
});

describe('confinement semantics survive the compatibility fix (criterion 3)', () => {
  test('a {} drift node is never a flat key, so drift sets stay byte-derived', () => {
    const before = flattenNpmLsJson(J({ dependencies: { axios: { version: '0.27.2' }, fsevents: {} } })).flat;
    const after = flattenNpmLsJson(J({ dependencies: { axios: { version: '1.0.0' }, fsevents: {} } })).flat;
    const drift = diffTrees(before, after, 'axios');
    assert.equal(drift.confined, true);
    assert.deepEqual(drift.other, []);
  });

  test('drift OUTSIDE the subtree stays unconfined even next to {} nodes', () => {
    const before = flattenNpmLsJson(J({ dependencies: { axios: { version: '0.27.2' }, evil: { version: '1.0.0' }, fsevents: {} } })).flat;
    const after = flattenNpmLsJson(J({ dependencies: { axios: { version: '1.0.0' }, evil: { version: '2.0.0' }, fsevents: {} } })).flat;
    const drift = diffTrees(before, after, 'axios');
    assert.equal(drift.confined, false);
    assert.deepEqual(drift.other, ['evil']);
  });

  test('scoped-name escape stays closed under segment semantics', () => {
    assert.equal(inDependencySubtree('@types%2Faxios', 'axios'), false);
    assert.equal(inDependencySubtree('bundlesize/axios/proxy-from-env', 'axios'), true);
    assert.equal(inDependencySubtree('axiosx/thing', 'axios'), false);
  });
});
