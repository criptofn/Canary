/**
 * Shared OFFLINE stub harness for pipeline-level tests (post-GLM AM-2 shape).
 *
 * WHY: auditFixtureDir now REFUSES a fixture that ships node_modules/ at
 * audit time ('node-modules-shipped' → InfraAbort). Runner bytes must arrive
 * through Canary's own controlled steps (install or prepare), never through
 * the acquired tree — a repo that can smuggle its mocha can smuggle a
 * prepare-created double past every version-derived check (that was AM-1's
 * attack surface; AM-1's pin table closes the runtime side, AM-2 closes the
 * acquisition side).
 *
 * So stubs stage their fake node_modules OUTSIDE the reserved name
 * (stub-payload/) and a generated prepare command copies the payload into
 * ./node_modules AFTER the audit — which is exactly how a legitimate install
 * also lands there. When a scenario wants the REAL observation channel
 * (strong verdicts), it also gets the Canary mocha double injected at the
 * canonical location via the same prepare step — hash-pinned, offline, no
 * network.
 */
import fs from 'node:fs';
import path from 'node:path';

export const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..'); // dist/test -> dist -> cli -> apps -> repo root

export const MOCHA_DOUBLE_SRC = path.join(REPO, 'apps', 'cli', 'test', 'fixtures', 'mocha-double');
export const DOUBLE_VERSION = '0.0.0-canary-double';
export const STAGING_REL = 'stub-payload';
export const STAGER_REL = 'canary-stub-stage.js';

export interface StubPkg { name: string; version: string; index?: string }

/** Write the staged payload (fake node_modules content) + the stager script.
 *  NOTHING here may use the name node_modules at write time. */
export function writeStagedPayload(dir: string, pkgs: readonly StubPkg[]): void {
  for (const p of pkgs) {
    const pd = path.join(dir, STAGING_REL, 'node_modules', p.name);
    fs.mkdirSync(pd, { recursive: true });
    fs.writeFileSync(path.join(pd, 'package.json'), JSON.stringify({ name: p.name, version: p.version, main: 'index.js' }), 'utf8');
    fs.writeFileSync(path.join(pd, 'index.js'), p.index ?? 'module.exports={}', 'utf8');
  }
  fs.writeFileSync(path.join(dir, STAGER_REL), [
    "'use strict';",
    "// Offline-stub stager (generated): materialize staged fake node_modules",
    "// into ./node_modules AFTER Canary's audit — same post-audit position a",
    "// real install occupies. Optionally inject the Canary mocha double.",
    "const fs = require('fs');",
    "const path = require('path');",
    `const SRC = ${JSON.stringify(path.join(dir, STAGING_REL))};`,
    `const DOUBLE = ${JSON.stringify(MOCHA_DOUBLE_SRC)};`,
    "const dst = path.resolve('node_modules');",
    "fs.mkdirSync(dst, { recursive: true });",
    "for (const e of fs.readdirSync(path.join(SRC, 'node_modules'))) {",
    "  fs.cpSync(path.join(SRC, 'node_modules', e), path.join(dst, e), { recursive: true });",
    "}",
    "if (process.argv[2] === 'mocha') {",
    "  fs.cpSync(DOUBLE, path.join(dst, 'mocha'), { recursive: true });",
    "}",
    "console.log('staged');",
  ].join('\n'), 'utf8');
}

/** The prepare-command argvs for a spec using writeStagedPayload. 'mocha'
 *  additionally lands the double (required for any strong-verdict scenario —
 *  prose-only runs can never attest and stop at rule 14). */
export function stageCommands(opts: { mocha: boolean }): string[][] {
  return [['node', STAGER_REL, ...(opts.mocha ? ['mocha'] : [])]];
}

/** Spec test-command for running the double. */
export const MOCHA_TEST_ARGV = ['$bin:mocha', 'test.js'];

/** A mocha-spec test.js under the double: baseline (widget@1) passes two
 *  tests; candidate (widget@2) fails exactly 'candidate breaks widget'.
 *  Byte-deterministic across rounds (the double prints no timings). */
export function widgetSpec(): string {
  return [
    "const { describe, it } = require('mocha');",
    "const v = require('./node_modules/widget/package.json').version;",
    "describe('widget suite', () => {",
    "  it('loads the dependency', () => {});",
    "  it('candidate breaks widget', () => {",
    "    if (v === '2.0.0') throw new Error('widget 2 changed behavior');",
    "  });",
    "});",
  ].join('\n');
}

/** Convenience: the full stub package payload (widget + left-pad). */
export const WIDGET_PKGS: StubPkg[] = [
  { name: 'widget', version: '1.0.0', index: 'module.exports={v:"1"}' },
  { name: 'left-pad', version: '1.0.0', index: 'module.exports={}' },
];

/** swap.js: bump widget (and optionally an unrelated dep for drift tests). */
export function swapScript(driftSwap: boolean): string {
  return [
    "const fs = require('fs');",
    "const bump = (n) => { const p = './node_modules/' + n + '/package.json'; const j = JSON.parse(fs.readFileSync(p)); j.version = '2.0.0'; fs.writeFileSync(p, JSON.stringify(j)); };",
    "bump('widget');",
    ...(driftSwap ? ["bump('left-pad');"] : []),
  ].join('\n');
}

/** Assert every round of a bundle carries the observation a double-run must
 *  produce — VALID, agreeing counts/identities, pinned double version. */
export function assertDoubleObservation(rounds: Array<{
  arm: string; round: number;
  reportedPassing?: number | undefined; reportedFailing?: number | undefined; reportedPending?: number | undefined;
  failingTestNames?: readonly string[] | undefined;
  executionObservation?: {
    status?: string; invalidReason?: string; absentKind?: string;
    observedCounts?: { passing: number; failing: number; pending: number };
    observedFailingIdentities?: readonly string[];
    expectedMochaVersion?: string;
    frameCount?: number;
  };
}>): void {
  for (const r of rounds) {
    const o = r.executionObservation;
    assert2(o && o.status === 'VALID',
      `${r.arm}#${r.round}: observation must be VALID via the double (got ${o ? `${o.status}/${o.invalidReason ?? o.absentKind}` : 'missing'})`);
    assert2(o.observedCounts?.passing === (r.reportedPassing ?? 0), `${r.arm}#${r.round}: passing channels disagree`);
    assert2(o.observedCounts?.failing === (r.reportedFailing ?? 0), `${r.arm}#${r.round}: failing channels disagree`);
    assert2((o.observedFailingIdentities ?? []).join('|') === [...new Set(r.failingTestNames ?? [])].sort().join('|'), `${r.arm}#${r.round}: identity channels disagree`);
    assert2(o.expectedMochaVersion === DOUBLE_VERSION, `${r.arm}#${r.round}: expected runner must be the pinned double`);
    assert2((o.frameCount ?? 0) >= 2, `${r.arm}#${r.round}: frames must include at least hello+bye`);
  }
}
function assert2(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
