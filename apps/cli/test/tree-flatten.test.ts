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
import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { flattenNpmLsJson, MAX_TREE_NODES, MAX_TREE_DEPTH } from '../src/pipeline.js';
import { reflattenNpmLs, statusOfObservation, MAX_TREE_NODES as V_NODES, MAX_TREE_DEPTH as V_DEPTH } from '../src/verify-tree.js';
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
    // post-sol M-2: a non-empty problems array MUST be echoed by ELSPROBLEMS
    // on stderr (real npm does exactly this) or the doc fails closed for
    // every {} node — the channels are fed consistently here.
    const r = flattenNpmLsJson(out, 'npm error code ELSPROBLEMS\nnpm error invalid: fsevents@2.3.3 node_modules/fsevents\n');
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
    const r = flattenNpmLsJson(out, 'npm error code ELSPROBLEMS\n');
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

// ---------------------------------------------------------------------------
// POST-SOL M-2 — the `{}` exemption must be the NARROWEST evidence-supported
// condition, not a general trust in empty nodes. Empirical ground truth
// (probed against the real npm 11.19 during remediation):
//   * an uninstalled OPTIONAL dep renders as a pure `{}` node (root fsevents
//     on win32, ws's bufferutil/utf-8-validate) in a document whose `problems`
//     channel is SILENT (field absent) and whose STDERR is silent — npm's own
//     verdict that the tree is problem-free;
//   * an uninstalled REQUIRED dep NEVER renders `{}`: it carries
//     {"missing":true,"problems":[...]} plus a root `problems` array plus an
//     "ELSPROBLEMS" line on stderr (exit 1).
// Therefore a zero-key node is an expected-absent optional ONLY IF the
// document's problem channels are well-formed and mutually CONSISTENT
// (problems absent-or-string[], stderr ELSPROBLEMS present iff problems
// non-empty) and npm's problems list mentions the name nowhere. Malformed
// problems, channel contradictions, or a missing-flag node are holes and fail
// CLOSED. This is the narrowest condition retained bytes can express; the
// remaining gap (a forgery consistent across BOTH channels) is the documented
// integrity-only ceiling (SECURITY.md), not a trust grant.
// ---------------------------------------------------------------------------
describe('post-sol M-2 — empty-node semantics (narrowest exemption)', () => {
  const J = (o: unknown): string => JSON.stringify(o);

  it('the REAL captured npm 11.19 shape (root fsevents {}, ws nested {} natives) stays VALID', () => {
    // verbatim structural sample from `npm ls --json --all --depth 9999`
    // (npm 11.19.0, win32) during the remediation probes
    const out = J({
      version: '1.0.0', name: 'probe',
      dependencies: {
        fsevents: {},
        'left-pad': { version: '1.3.0', resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz', overridden: false },
        ws: {
          version: '8.18.0', resolved: 'https://r/ws-8.18.0.tgz', overridden: false,
          dependencies: { bufferutil: {}, 'utf-8-validate': {}, asyncLocalStorage: { version: '2.1.0' } },
        },
      },
    });
    const r = flattenNpmLsJson(out, '');
    assert.deepEqual(r.jsonAnomalies, []);
    assert.deepEqual(r.flat, { 'left-pad': '1.3.0', ws: '8.18.0', 'ws/asyncLocalStorage': '2.1.0' });
    assert.equal(classifyTreeObservation({
      parsed: r.parsed, hasRootDeps: r.hasRootDeps, deps: r.flat,
      dependencyPresent: dependencyInTree(r.flat, 'ws'), anomalies: r.jsonAnomalies,
    }), 'VALID');
    // …and the independent verifier agrees (same rules, different code):
    const v = reflattenNpmLs(out, '');
    assert.deepEqual(v.anomalies, []);
    assert.deepEqual(v.flat, r.flat);
  });

  it('R4-SR1 (self-review): problems WITH a silent stderr is npm\'s real extraneous-only shape — the observation is complete, not contradictory', () => {
    // Probe-verified on npm 11.19: `npm ls` lists extraneous problems in
    // the JSON while exiting 0 with EMPTY stderr. The contradiction check
    // is therefore MONOTONIC (ELSPROBLEMS demands problems, never the
    // reverse); over-firing it here would cap every honest extraneous tree
    // at INCOMPLETE and destroy the golden drift test (rule 9 -> 10).
    const out = J({
      dependencies: { axios: { version: '1.0.0' }, fsevents: {}, left: { version: '1.0.0', extraneous: true } },
      problems: ['extraneous: left@1.0.0 node_modules/left'],
    });
    const r = flattenNpmLsJson(out, '');
    assert.deepEqual(r.jsonAnomalies, [], r.jsonAnomalies.join('; '));
    assert.equal(r.flat['fsevents'], undefined, 'expected-absent optional: no flat entry');
    assert.equal(r.flat['left'], '1.0.0');
    assert.deepEqual(reflattenNpmLs(out, '').anomalies, []);
    assert.equal(classifyTreeObservation({
      parsed: r.parsed, hasRootDeps: r.hasRootDeps, deps: r.flat,
      dependencyPresent: true, anomalies: r.jsonAnomalies,
    }), 'VALID');
  });

  it('an empty/absent problems field under an ELSPROBLEMS stderr IS the contradiction (stripped-report forgery)', () => {
    const err = 'npm error code ELSPROBLEMS\nnpm error missing: evil@1.0.0, required by app@1.0.0\n';
    for (const doc of [
      { dependencies: { axios: { version: '1.0.0' }, 'evil-required': {} } },
      { dependencies: { axios: { version: '1.0.0' }, 'evil-required': {} }, problems: [] },
    ]) {
      const out = J(doc);
      const r = flattenNpmLsJson(out, err);
      assert.ok(r.jsonAnomalies.includes('problems-stderr-contradiction'), JSON.stringify(r.jsonAnomalies));
      assert.ok(r.jsonAnomalies.includes('missing-version:evil-required'),
        'a {} node cannot masquerade as optional when npm exited with a problems banner it did not report');
      assert.deepEqual(reflattenNpmLs(out, err).anomalies, r.jsonAnomalies);
    }
  });

  it('problems ABSENT but stderr SCREAMING ELSPROBLEMS is equally a contradiction (stripped-stderr forgery)', () => {
    const err = 'npm error code ELSPROBLEMS\nnpm error missing: evil-required@1.0.0, required by app@1.0.0\n';
    const out = J({ dependencies: { axios: { version: '1.0.0' }, 'evil-required': {} } });
    const r = flattenNpmLsJson(out, err);
    assert.ok(r.jsonAnomalies.includes('problems-stderr-contradiction'), JSON.stringify(r.jsonAnomalies));
    assert.ok(r.jsonAnomalies.includes('missing-version:evil-required'),
      'a {} node cannot masquerade as optional when stderr says the tree has problems');
  });

  it('a MALFORMED problems field (string, object, or array with non-strings) kills the exemption and is itself an anomaly', () => {
    for (const bad of ['just a string about axios@1.0.0', { weird: true }, ['valid entry', 42]]) {
      const out = J({ dependencies: { axios: { version: '1.0.0' }, fsevents: {} }, problems: bad });
      const r = flattenNpmLsJson(out, '');
      assert.ok(r.jsonAnomalies.includes('malformed-problems'), JSON.stringify(r.jsonAnomalies) + ' for ' + JSON.stringify(bad));
      assert.ok(r.jsonAnomalies.includes('missing-version:fsevents'), 'no exemption through a malformed channel');
      // parity: verifier sees the same
      assert.deepEqual(reflattenNpmLs(out, '').anomalies, r.jsonAnomalies);
    }
  });

  it('string-valued problems mentioning the node fail closed identically on BOTH parsers (N4 differential)', () => {
    const out = J({ dependencies: { axios: { version: '1.0.0' }, fsevents: {} }, problems: 'invalid: fsevents@2.3.3 node_modules/fsevents' });
    const a = flattenNpmLsJson(out, '');
    const b = reflattenNpmLs(out, '');
    assert.deepEqual(a.jsonAnomalies, b.anomalies);
    assert.ok(a.jsonAnomalies.includes('malformed-problems'));
    assert.ok(a.jsonAnomalies.includes('missing-version:fsevents'));
  });

  it('the STUDIED dependency appearing as {} is absence (INCOMPLETE via depPresent), never presence', () => {
    const out = J({ dependencies: { axios: {}, other: { version: '1.0.0' } } });
    const r = flattenNpmLsJson(out, '');
    assert.equal(dependencyInTree(r.flat, 'axios'), false);
    assert.equal(statusOfObservation(reflattenNpmLs(out, ''), 'axios'), 'INCOMPLETE');
  });

  it('drift caused by DISAPPEARANCE of a formerly-versioned dep is byte-visible, not exemption-hidden (outside-subtree drift -> unconfined)', () => {
    const base = flattenNpmLsJson(J({ dependencies: { axios: { version: '0.27.2' }, 'left-pad': { version: '1.3.0' } } }), '').flat;
    // candidate: left-pad rendered {} (a hole dressed as optional in a clean doc):
    const cand = flattenNpmLsJson(J({ dependencies: { axios: { version: '1.0.0' }, 'left-pad': {} } }), '').flat;
    const drift = diffTrees(base, cand, 'axios');
    assert.equal(drift.confined, false, 'disappearance outside the dep subtree must surface as drift');
    assert.deepEqual(drift.other, ['left-pad']);
  });

  it('deeply nested hostile trees are BOUNDED on both parsers (no stack exhaustion; fails closed)', () => {
    // 300 levels of legitimate-looking nesting
    let deep: Record<string, unknown> = { version: '9.9.9' };
    for (let i = 0; i < 300; i++) deep = { version: `${i}.0.0`, dependencies: { [`p${i}`]: deep } };
    const out = JSON.stringify({ name: 'hostile', version: '1.0.0', dependencies: { axios: { version: '1.0.0' }, deep: deep as never } });
    const a = flattenNpmLsJson(out, '');
    const b = reflattenNpmLs(out, '');
    assert.ok(a.jsonAnomalies.some((x) => /budget-exceeded/.test(x)), JSON.stringify(a.jsonAnomalies.slice(0, 4)));
    assert.deepEqual(b.anomalies, a.jsonAnomalies);
    assert.equal(statusOfObservation(b, 'axios'), 'INCOMPLETE', 'a bounded (partial) observation cannot be VALID');
  });

  it('the traversal budgets are IDENTICAL contracts in both implementations', () => {
    assert.equal(MAX_TREE_NODES, V_NODES, 'node budget drift between producer and verifier');
    assert.equal(MAX_TREE_DEPTH, V_DEPTH, 'depth budget drift between producer and verifier');
  });

  it('anomalies from the two problem channels are DETERMINISTIC and deduped across repeated {} nodes', () => {
    const out = J({ dependencies: { axios: { version: '1.0.0' }, a: {}, b: {}, c: {} }, problems: 'x' });
    const r = flattenNpmLsJson(out, '');
    assert.equal(r.jsonAnomalies.filter((x) => x === 'malformed-problems').length, 1);
    assert.deepEqual(r.jsonAnomalies, [...r.jsonAnomalies].sort());
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
