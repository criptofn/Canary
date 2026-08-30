/**
 * Audit M8 — OFFLINE end-to-end pipeline integration test.
 *
 * The 73-test baseline classified and validated pieces but NEVER wired the
 * whole pipeline, which is exactly why rule-9 confinement removal and
 * fabricated-evidence acceptance slipped through. This test runs the REAL
 * runExperiment (classification -> evidence bundle -> validateBundle ->
 * verifyArtifacts -> assertProof) against a local stub repo with NO network:
 * the fetch/extract boundaries are injected (the same seam idiom as
 * ExecutorDeps.run); every command is a local `node` script producing REAL
 * artifacts. It pins the four release-blocking behaviors:
 *   1. a genuine confined regression classifies CONFIRMED_REGRESSION and the
 *      real on-disk artifacts re-hash clean (F4/F13 end to end);
 *   2. unconfined tree drift is downgraded to INCONCLUSIVE rule 9 (F9 e2e);
 *   3. a tampered artifact is caught by the prove path (F4 e2e);
 *   4. a fabricated, self-contradictory bundle is refuted by validateBundle (F3 e2e).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { runExperiment } from '../src/pipeline.js';
import { validateBundle, type EvidenceBundle } from '@canary-rn/evidence-schema';
import { assertProof, verifyArtifacts, type ProofExpectation } from '../src/prove.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-e2e-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const FAKE_SHA = 'a'.repeat(40);
const FAKE_BLOB = { bytes: Buffer.alloc(0), sha256: 'b'.repeat(64) };

/**
 * A downstream repo whose test.js PASSES under widget@1 and FAILS (with a
 * mocha-style summary) under widget@2. `driftSwap` additionally bumps an
 * unrelated dep (left-pad) so the candidate tree drifts OUTSIDE the studied
 * dependency subtree.
 */
function makeStub(dir: string, opts: { driftSwap: boolean }): void {
  const w = (p: string, s: string): void => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, s, 'utf8');
  };
  w(path.join(dir, 'package.json'), JSON.stringify({
    name: 'downstream', version: '1.0.0', dependencies: { widget: '1.0.0' },
  }));
  w(path.join(dir, 'node_modules', 'widget', 'package.json'),
    JSON.stringify({ name: 'widget', version: '1.0.0', main: 'index.js' }));
  w(path.join(dir, 'node_modules', 'widget', 'index.js'), 'module.exports={v:"1"}');
  w(path.join(dir, 'node_modules', 'left-pad', 'package.json'),
    JSON.stringify({ name: 'left-pad', version: '1.0.0', main: 'index.js' }));
  w(path.join(dir, 'node_modules', 'left-pad', 'index.js'), 'module.exports={}');
  w(path.join(dir, 'test.js'), [
    "const v = require('./node_modules/widget/package.json').version;",
    "if (v !== '2.0.0') { console.log('  2 passing (1ms)'); process.exit(0); }",
    "console.log('  1 passing (1ms)');",
    "console.log('  1 failing');",
    "console.log('');",
    "console.log('  1) widget suite:');",
    "console.log('       candidate breaks widget:');",
    "console.log('     Error: widget 2 changed behavior');",
    "process.exit(1);",
  ].join('\n'));
  // swap.js: bump widget; when driftSwap, also bump an UNRELATED dep.
  const swapLines = [
    "const fs = require('fs');",
    "const bump = (n) => { const p = './node_modules/' + n + '/package.json'; const j = JSON.parse(fs.readFileSync(p)); j.version = '2.0.0'; fs.writeFileSync(p, JSON.stringify(j)); };",
    "bump('widget');",
  ];
  if (opts.driftSwap) swapLines.push("bump('left-pad');");
  w(path.join(dir, 'swap.js'), swapLines.join('\n'));
}

function specFor(): unknown {
  return {
    schema: 2, id: 'stub-e2e',
    dependency: { package: 'widget', baseline: '1.0.0', candidate: '2.0.0' },
    downstream: { repo: 'stub/downstream', commit: FAKE_SHA },
    commands: {
      prepare: [['node', '-e', "console.log('prepared')"]],
      // {candidate} is required by the planner (the swap must name the version
      // it installs); swap.js ignores the arg but the token proves intent.
      swap: ['node', 'swap.js', '{candidate}'],
      test: ['node', 'test.js'],
    },
    repeats: { baseline: 2, candidate: 2 },
    timeoutSecs: { install: 120, test: 120 },
  };
}

async function offlineRun(driftSwap: boolean): Promise<
  { repoRoot: string; artifactsDir: string; bundle: EvidenceBundle; issues: string[] }
> {
  const repoRoot = fs.mkdtempSync(path.join(TMP, 'repo-'));
  const stub = fs.mkdtempSync(path.join(TMP, 'stub-'));
  makeStub(stub, { driftSwap });
  const proj = 'downstream';
  const result = await runExperiment(specFor(), repoRoot, true, {
    fetch: async () => ({ ...FAKE_BLOB }),
    extract: (_tgz, wsRoot) => {
      const target = path.join(wsRoot, `${proj}-${FAKE_SHA}`);
      fs.cpSync(stub, target, { recursive: true });
    },
  });
  return { repoRoot, artifactsDir: result.artifactsDir, bundle: result.bundle, issues: result.bundleIssues };
}

describe('audit M8 — offline pipeline end-to-end', () => {
  it('confined regression: CONFIRMED_REGRESSION, real artifacts re-hash clean', async () => {
    const { bundle, artifactsDir, issues } = await offlineRun(false);
    assert.deepEqual(issues, [], `bundle must self-validate: ${issues.join('; ')}`);
    assert.equal(bundle.classification.label, 'CONFIRMED_REGRESSION', bundle.classification.reason);
    assert.equal(bundle.classification.rule, 5);
    assert.equal(bundle.treeComparison.driftConfinedToDependency, true);
    // F4 e2e: real on-disk artifacts must match the recorded digests.
    assert.deepEqual(verifyArtifacts(artifactsDir, bundle), []);
    // F13 e2e: failing-test identities are persisted in the bundle itself.
    const cand = bundle.rounds.find((r) => r.arm === 'candidate')!;
    assert.ok(cand.failingTestNames && cand.failingTestNames.length >= 1,
      'candidate round must persist failing-test identities');
    assert.equal(cand.reportedFailing, 1);
    // And a well-formed proof expectation passes assertProof against the logs.
    const baseHashes = bundle.rounds.filter((r) => r.arm === 'baseline').map((r) => r.normalizedStdoutSha256);
    const candHashes = bundle.rounds.filter((r) => r.arm === 'candidate').map((r) => r.normalizedStdoutSha256);
    const proof: ProofExpectation = {
      schema: 1, experimentId: 'stub-e2e',
      dependency: { package: 'widget', baseline: '1.0.0', candidate: '2.0.0' },
      downstream: { repo: 'stub/downstream', commit: FAKE_SHA },
      expected: {
        classification: 'CONFIRMED_REGRESSION', rule: 5, driftConfinedToDependency: true,
        baseline: { rounds: baseHashes.length, exitCodes: [0, 0], normalizedStdoutSha256AcrossRounds: baseHashes, summary: { passing: 2 } },
        candidate: { rounds: candHashes.length, exitCodes: [1, 1], normalizedStdoutSha256AcrossRounds: candHashes, summary: { passing: 1, failing: 1 } },
        failingTestNames: ['candidate breaks widget'],
      },
    };
    const readLog = (arm: 'baseline' | 'candidate'): string => {
      const p = path.join(artifactsDir, `${arm}-1.stdout.log`);
      return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    };
    const checks = assertProof(bundle, proof, { candidateStdout: readLog('candidate'), baselineStdout: readLog('baseline') });
    assert.deepEqual(checks.filter((c) => !c.ok).map((c) => c.name), [], 'a faithful proof must pass');
  });

  it('unconfined tree drift is downgraded to INCONCLUSIVE rule 9 (F9 e2e)', async () => {
    const { bundle, issues } = await offlineRun(true);
    assert.deepEqual(issues, [], `guard-produced bundle must still validate: ${issues.join('; ')}`);
    assert.equal(bundle.treeComparison.driftConfinedToDependency, false);
    assert.equal(bundle.classification.label, 'INCONCLUSIVE');
    assert.equal(bundle.classification.rule, 9);
    assert.match(bundle.classification.reason, /left-pad/);
  });

  it('a tampered artifact is caught end-to-end by the prove path (F4 e2e)', async () => {
    const { bundle, artifactsDir } = await offlineRun(false);
    const logFile = path.join(artifactsDir, 'candidate-1.stdout.log');
    fs.appendFileSync(logFile, 'FORGED LINE injected after hashing\n');
    const issues = verifyArtifacts(artifactsDir, bundle);
    assert.equal(issues.length, 1, JSON.stringify(issues));
    assert.match(issues[0]!, /TAMPERED artifact candidate-1\.stdout\.log/);
  });

  it('a fabricated self-contradictory bundle is refuted by validateBundle (F3 e2e)', async () => {
    // Take a REAL confirmed bundle and lie: claim PASS with all candidate
    // rounds that actually failed. Re-derivation must refuse it.
    const { bundle } = await offlineRun(false);
    const forged = structuredClone(bundle) as EvidenceBundle;
    forged.classification = { label: 'PASS', rule: 3, reason: 'made up', reproductionCount: 2 };
    const issues = validateBundle(forged);
    assert.ok(issues.some((i) => /contradicts its own round facts/.test(i)),
      `expected a re-derivation refusal, got: ${issues.join('; ')}`);
  });
});
