import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  diffTrees,
  escapePkgKey,
  extractFailingTestNames,
  inDependencySubtree,
  classifyTreeObservation,
  dependencyInTree,
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
  it('round-3 B6: descendants of a NESTED copy are inside the subtree', () => {
    // bundlesize/axios/proxy-from-env is a child of a nested axios copy —
    // the old prefix/suffix tests missed it and falsely reported NOT confined.
    assert.ok(inDependencySubtree('bundlesize/axios/proxy-from-env', 'axios'));
    assert.ok(inDependencySubtree('a/b/axios/c/d', 'axios'));
    // and the escape contract still holds: no segment lookalikes
    assert.ok(!inDependencySubtree('bundlesize/@types%2Faxios/proxy', 'axios'));
    assert.ok(!inDependencySubtree('axios-like', 'axios'));
    assert.ok(!inDependencySubtree('x/axiosy/z', 'axios'));
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

  it('audit B6 exposes the vacuous-confinement hazard (empty trees report confined)', () => {
    // This is WHY the observation status exists: diffTrees alone cannot tell
    // "both arms identical & confined" from "both arms observed nothing".
    const d = diffTrees({}, {}, 'axios');
    assert.equal(d.confined, true); // <-- vacuously true; classifyTreeObservation guards it
  });
});

describe('audit B6 — classifyTreeObservation (tree completeness)', () => {
  const present = { axios: '0.27.2', 'follow-redirects': '1.15.0' };
  it('a parsed, non-empty tree containing the dependency is VALID', () => {
    assert.equal(classifyTreeObservation({
      parsed: true, hasRootDeps: true, deps: present, dependencyPresent: dependencyInTree(present, 'axios'),
    }), 'VALID');
  });
  it('empty tree (no data observed) is INVALID, not a proof of confinement', () => {
    assert.equal(classifyTreeObservation({
      parsed: true, hasRootDeps: true, deps: {}, dependencyPresent: false,
    }), 'INVALID');
  });
  it('unparseable / no-root-deps is INVALID', () => {
    assert.equal(classifyTreeObservation({ parsed: false, hasRootDeps: false, deps: {}, dependencyPresent: false }), 'INVALID');
    assert.equal(classifyTreeObservation({ parsed: true, hasRootDeps: false, deps: present, dependencyPresent: true }), 'INVALID');
  });
  it('tree present but the studied dependency absent is INCOMPLETE', () => {
    const noDep = { lodash: '4.17.21', chai: '4.3.6' };
    assert.equal(classifyTreeObservation({
      parsed: true, hasRootDeps: true, deps: noDep, dependencyPresent: dependencyInTree(noDep, 'axios'),
    }), 'INCOMPLETE');
  });
  it('scoped dependency presence is detected via the escaped key (dependencyInTree)', () => {
    const scoped = { '@scope%2Fpkg': '1.0.0', 'a/@scope%2Fpkg': '1.0.0' };
    assert.ok(dependencyInTree(scoped, '@scope/pkg'));
    assert.ok(!dependencyInTree(scoped, 'other'));
  });
  it('round-3 B6: ANY observation anomaly caps the status at INCOMPLETE', () => {
    const o = {
      parsed: true, hasRootDeps: true, deps: present,
      dependencyPresent: dependencyInTree(present, 'axios'),
    };
    assert.equal(classifyTreeObservation(o), 'VALID');
    assert.equal(classifyTreeObservation({ ...o, anomalies: [] }), 'VALID');
    assert.equal(classifyTreeObservation({ ...o, anomalies: ['missing-version:axios'] }), 'INCOMPLETE');
    assert.equal(
      classifyTreeObservation({ ...o, anomalies: ['disk-not-observed:axios/left-pad'] }),
      'INCOMPLETE', 'target present but descendants omitted must never be VALID');
    // anomalies cannot resurrect an INVALID observation
    assert.equal(classifyTreeObservation({ ...o, deps: {}, dependencyPresent: false, anomalies: ['x'] }), 'INVALID');
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

  // ---- Round-3 BLOCKER 1: root-level failures and block-boundary integrity ----
  it('round-3 B1: ROOT-level failure ("1) title:" — colon on the numbered line) yields its identity', () => {
    const log = [
      '  2 failing', '',
      '  1) root alpha:', '     Error: one', '',
      '  2) root beta:', '     Error: two',
    ].join('\n');
    const names = extractFailingTestNames(log);
    assert.deepEqual(names, ['root alpha', 'root beta'],
      'two different root failures must parse to two DISTINCT identities, never empty sets');
  });

  it('round-3 B1: repeated root-level titles across rounds re-extract identically (deterministic)', () => {
    const log = ['  1 failing', '  1) a single root test:', '     Error: x'].join('\n');
    assert.deepEqual(extractFailingTestNames(log), ['a single root test']);
    assert.deepEqual(extractFailingTestNames(log), extractFailingTestNames(log));
  });

  it('round-3 B1: mixed root + nested blocks do not corrupt each other', () => {
    const log = [
      '  2 failing', '',
      '  1) root failure:', '  2) suite B', '       inner test:', '     Error: nope',
    ].join('\n');
    const names = extractFailingTestNames(log);
    assert.deepEqual(names, ['root failure', 'suite B > inner test'],
      'the nested block must not be swallowed as continuation of the root block');
  });

  it('round-3 B1: a nested block is abandoned at the summary line, never past it', () => {
    const log = ['  1) orphan suite', '  3 failing', '  1) real suite', '       test:'].join('\n');
    assert.deepEqual(extractFailingTestNames(log), ['real suite > test']);
  });

  it('round-3 B1: malformed/truncated output yields NO fabricated identities', () => {
    const trunc = '  2 failing\n\n  1) suite with truncated block';
    assert.deepEqual(extractFailingTestNames(trunc), []);
    const junk = '  1) \n  2)\n     :';
    // no fabrication: empty/colon-only titles are never emitted as identities
    assert.ok(extractFailingTestNames(junk).every((n) => n.trim().length > 0 && !n.endsWith(':')));
  });

  it('round-3 B1: reordered distinct failures extract the same SET (profile order-independence)', () => {
    const a = ['  1) suite A', '       t1:', '  2) root two:'].join('\n');
    const b = ['  1) root two:', '  2) suite A', '       t1:'].join('\n');
    assert.deepEqual(
      [...extractFailingTestNames(a)].sort(),
      [...extractFailingTestNames(b)].sort(),
    );
    assert.equal(new Set(extractFailingTestNames(a)).size, 2);
  });
});

describe('streamsStable', () => {
  it('true only for identical hashes across all rounds', () => {
    assert.ok(streamsStable(['aa', 'aa', 'aa']));
    assert.ok(!streamsStable(['aa', 'ab']));
    assert.ok(!streamsStable([]));
  });
});

// post-sol secondary: the summary parser and identity extractor previously
// split only on /\r?\n/ — a lone-CR stream (some progress reporters emit
// it) parsed as ONE line and silently lost counts. Both now normalize at
// entry, matching the executor matchers and the normalizer pipeline.
describe('post-sol secondary — lone-CR line endings parse identically to LF/CRLF', () => {
  const LOG_LF = '  suite\r\n    √ ok one\r\n  128 passing (3s)\r\n  3 failing\r\n\r\n  1) suite A\r\n       breaks thing:\r\n';
  const toCR = (s: string): string => s.replace(/\r\n/g, '\r');
  it('parseSummaryCounts reads the same totals across LF, CRLF and CR-only', () => {
    const lf = parseSummaryCounts(LOG_LF.replace(/\r\n/g, '\n'));
    const crlf = parseSummaryCounts(LOG_LF);
    const cr = parseSummaryCounts(toCR(LOG_LF));
    assert.deepEqual(cr, lf);
    assert.deepEqual(crlf, lf);
    assert.equal(lf.passing, 128);
    assert.equal(lf.failing, 3);
  });
  it('extractFailingTestNames finds the same identities across LF, CRLF and CR-only', () => {
    const lf = [...extractFailingTestNames(LOG_LF.replace(/\r\n/g, '\n'))].sort();
    const cr = [...extractFailingTestNames(toCR(LOG_LF))].sort();
    assert.deepEqual(cr, lf);
    assert.ok(lf.length >= 1, 'fixture must actually carry an identity');
  });
});

// post-GLM F3: the executor's view() strips ANSI/CSI before its matchers run,
// but these parsers normalized ONLY line endings — the same bytes gave the
// summary recognizer and the count/identity parsers different views. The
// asymmetry is exploitable in BOTH directions:
//   FALSE PASS — an exit-code-swallowing wrapper prints a plain "N passing"
//     line and ANSI-wraps the failing line ("ESC[31m 3 failing ESC[0m"):
//     hasRunnerSummary (stripped) says yes, parseSummaryCounts (raw) says
//     failing=undefined, and rule-1's masked-failure clause
//     (exit 0 while reportedFailing>0) never fires.
//   FALSE INFRA — a genuine FORCE_COLOR run hides ALL its counts behind
//     escapes ("summary present but no machine-readable counts") while the
//     summary itself is recognized.
// Both parsers now share the executor's view normalization at entry.
describe('post-GLM F3 — ANSI-colored output parses identically to plain output', () => {
  const ESC = String.fromCharCode(27);
  const ansi = (s: string): string => `${ESC}[31m${s}${ESC}[0m`;
  const ansiG = (s: string): string => `${ESC}[32m${s}${ESC}[0m`;

  // mocha's spec reporter wraps the failing count in red; the passing count
  // is green and the failure headline number is red.
  const PLAIN = [
    '  128 passing (119ms)',
    '  3 failing',
    '',
    '  1) MockAdapter basics',
    '       can pass headers to match to a handler:',
    '     Error: Request failed with status code 404',
  ].join('\n');
  const COLORED = [
    `  ${ansiG('128 passing')} (119ms)`,
    `  ${ansi('3 failing')}`,
    '',
    `  ${ansi('1)')} MockAdapter basics`,
    '       can pass headers to match to a handler:',
    '     Error: Request failed with status code 404',
  ].join('\n');
  // the exact FALSE PASS attack: plain passing line, ANSI-wrapped failing line
  const MASKED = `  128 passing (1s)\n  ${ansi('3 failing')}\n`;

  it('parseSummaryCounts reads the same totals colored as plain', () => {
    assert.deepEqual(parseSummaryCounts(COLORED), parseSummaryCounts(PLAIN));
    assert.deepEqual(parseSummaryCounts(COLORED), { passing: 128, failing: 3, pending: undefined });
  });

  it('extractFailingTestNames finds the same identities colored as plain', () => {
    assert.deepEqual(
      [...extractFailingTestNames(COLORED)].sort(),
      [...extractFailingTestNames(PLAIN)].sort(),
    );
    assert.deepEqual(extractFailingTestNames(COLORED), ['MockAdapter basics > can pass headers to match to a handler']);
  });

  it('F3 false-PASS battery: an ANSI-wrapped failing line cannot hide from the masked-failure count', () => {
    assert.equal(parseSummaryCounts(MASKED).failing, 3,
      'ANSI on the failing line must not turn reportedFailing into undefined (rule-1 clause exit0+failing>0 needs the count)');
    assert.equal(parseSummaryCounts(MASKED).passing, 128);
  });

  it('precision control: stripping never fabricates counts', () => {
    assert.deepEqual(parseSummaryCounts(`  ${ansiG('128 passing')}${ESC}[0m`), { passing: 128, failing: undefined, pending: undefined });
    assert.deepEqual(extractFailingTestNames(`${ansi('1)')} suite\n     ${ansi('a passing title')}\n`), []);
  });

  it('ANSI and lone-CR compose: colored CR-only stream matches colored LF stream', () => {
    const cr = COLORED.replace(/\n/g, '\r');
    assert.deepEqual(parseSummaryCounts(cr), parseSummaryCounts(COLORED));
    assert.deepEqual([...extractFailingTestNames(cr)].sort(), [...extractFailingTestNames(COLORED)].sort());
  });
});
