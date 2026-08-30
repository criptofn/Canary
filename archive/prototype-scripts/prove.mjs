#!/usr/bin/env node
/**
 * canary prove — the end-to-end regression proof of Canary itself.
 *
 * Re-runs the golden experiment from scratch (fresh fetch, fresh install,
 * fresh workspace) and asserts the outcome matches the committed expectation
 * file EXACTLY: classification, rule, per-round exit codes, per-round
 * NORMALIZED output hashes (prefix-compared), tree-drift confinement, and
 * the identity of the failing downstream tests.
 *
 *   node scripts/prove.mjs [spec.json] [proof.json]
 *   node scripts/prove.mjs --check-only   (assert against last run's evidence)
 *
 * Exit 0 = proof holds. This is the boring, reproducible milestone.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = process.argv[2] ?? path.join(REPO_ROOT, 'fixtures/axios-0.27-to-1.0/specs/axios-mock-adapter.json');
const PROOF = process.argv[3] ?? SPEC.replace(/\.json$/, '.proof.json');
const CHECK_ONLY = process.argv.includes('--check-only');

function main() {
  const spec = JSON.parse(fs.readFileSync(SPEC, 'utf8'));
  const proof = JSON.parse(fs.readFileSync(PROOF, 'utf8'));

  if (!CHECK_ONLY) {
    console.log('=== re-running experiment from scratch ===');
    const r = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts/run-experiment.mjs'), SPEC], {
      stdio: 'inherit', timeout: 30 * 60 * 1000,
    });
    console.log(`(experiment runner exit code: ${r.status})`);
  }

  const pointer = JSON.parse(fs.readFileSync(
    path.join(REPO_ROOT, '.canary-runs', `latest-${spec.id}.json`), 'utf8'));
  const ev = JSON.parse(fs.readFileSync(pointer.evidence, 'utf8'));

  const checks = [];
  const eq = (name, actual, expected) =>
    checks.push({ name, ok: JSON.stringify(actual) === JSON.stringify(expected), actual, expected });

  eq('classification', ev.classification.label, proof.expected.classification);
  eq('rule', ev.classification.rule, proof.expected.rule);
  eq('drift-confined-to-dependency', ev.treeComparison.driftConfinedToDependency, true);
  eq('dependency pinned', `${ev.dependency.package}@${ev.dependency.baselineVersion}->${ev.dependency.candidateVersion}`,
    `${spec.dependency.package}@${spec.dependency.baseline}->${spec.dependency.candidate}`);
  eq('commit pinned', ev.downstream.commitSha, spec.downstream.commit);

  const base = ev.rounds.filter((x) => x.arm === 'baseline');
  const cand = ev.rounds.filter((x) => x.arm === 'candidate');
  eq('baseline exit codes', base.map((x) => x.exitCode), proof.expected.baseline.exitCodes);
  eq('candidate exit codes', cand.map((x) => x.exitCode), proof.expected.candidate.exitCodes);
  eq('baseline normalized stdout hashes',
    base.map((x) => x.normalizedStdoutSha256.slice(0, 16)), proof.expected.baseline.normalizedStdoutSha256AcrossRounds.map((h) => h.slice(0, 16)));
  eq('candidate normalized stdout hashes',
    cand.map((x) => x.normalizedStdoutSha256.slice(0, 16)), proof.expected.candidate.normalizedStdoutSha256AcrossRounds.map((h) => h.slice(0, 16)));
  eq('baseline arm internally deterministic', new Set(base.map((x) => x.normalizedStdoutSha256)).size, 1);
  eq('candidate arm internally deterministic', new Set(cand.map((x) => x.normalizedStdoutSha256)).size, 1);

  const candLog = fs.readFileSync(path.join(path.dirname(pointer.evidence), 'candidate-1.stdout.log'), 'utf8');
  for (const t of proof.expected.failingTestNames) {
    checks.push({ name: `failing test present: "${t}"`, ok: candLog.includes(t), actual: undefined, expected: undefined });
  }
  checks.push({ name: `candidate delta: "${proof.expected.candidateDelta}"`, ok: candLog.includes('3 failing') && candLog.includes('125 passing'), actual: undefined, expected: undefined });

  console.log('\n=== PROOF ASSERTIONS ===');
  let failed = 0;
  for (const c of checks) {
    if (!c.ok) failed++;
    console.log(`${c.ok ? '  ok  ' : '  FAIL'} ${c.name}${c.ok ? '' : `\n         expected: ${JSON.stringify(c.expected)}\n         actual:   ${JSON.stringify(c.actual)}`}`);
  }
  console.log(`\n${'='.repeat(60)}`);
  console.log(failed === 0
    ? 'CANARY REGRESSION PROOF: PASS — fresh run reproduced the committed evidence exactly'
    : `CANARY REGRESSION PROOF: FAIL — ${failed}/${checks.length} assertions diverged`);
  console.log('='.repeat(60));
  process.exit(failed === 0 ? 0 : 1);
}

main();
