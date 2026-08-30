#!/usr/bin/env node
/**
 * canary — independent verification layer CLI.
 *
 *   canary run   <spec.json>                 execute an experiment, write evidence
 *   canary prove <spec.json> [proof.json]    re-run and assert committed expectations
 *   canary check <spec.json> [proof.json]    prove without re-running (last evidence)
 *   canary report [evidence.json] [out.html] render the human-readable report
 *                                          (no args: the latest run's evidence)
 *
 * Exit codes: 0 success (proof holds / CONFIRMED_REGRESSION as expected)
 *             1 proof failed / PASS
 *             2 other classification / infra
 *             3 misuse
 */

import fs from 'node:fs';
import path from 'node:path';

import { renderHtml } from '@canary-rn/report';
import { validateBundle, type EvidenceBundle } from '@canary-rn/evidence-schema';
import { runExperiment, InfraAbort, CANARY_VERSION } from './pipeline.js';
import { assertProof, readLatestEvidence, verifyArtifacts, findLatestEvidencePath, type ProofExpectation } from './prove.js';

const REPO_ROOT_DEFAULT = path.resolve(process.cwd());

function usage(): never {
  console.log(`canary ${CANARY_VERSION} — cool diff. prove that it actually made the project better.

usage:
  canary run   <spec.json>
  canary prove <spec.json> [proof.json]
  canary check <spec.json> [proof.json]     assert last run's evidence (no re-run)
  canary report [evidence.json] [out.html]  (defaults: latest run's evidence; sibling report.html)
  canary version`);
  process.exit(3);
}

function loadJson(p: string): unknown {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function defaultProofPath(specPath: string): string {
  return specPath.replace(/\.json$/, '.proof.json');
}

async function cmdRun(specPath: string): Promise<number> {
  const result = await runExperiment(loadJson(specPath), REPO_ROOT_DEFAULT);
  if (result.bundleIssues.length) {
    console.error('evidence bundle validation issues:', result.bundleIssues);
    return 3;
  }
  console.log(`evidence: ${path.join(result.artifactsDir, 'evidence.json')}`);
  const label = result.bundle.classification.label;
  return label === 'CONFIRMED_REGRESSION' ? 0 : label === 'PASS' ? 1 : 2;
}

async function cmdProve(specPath: string, proofPath: string, rerun: boolean): Promise<number> {
  const spec = loadJson(specPath) as { id: string };
  const proof = loadJson(proofPath) as ProofExpectation;
  const id = spec.id;

  // F7: prefer the artifacts dir of THIS run over the shared pointer file
  // (two runs of the same id would let prove assert the wrong evidence).
  let artifactsDir: string | undefined;
  if (rerun) {
    const r = await runExperiment(spec, REPO_ROOT_DEFAULT);
    if (r.bundleIssues.length) {
      console.error('bundle invalid:', r.bundleIssues);
      return 3;
    }
    artifactsDir = r.artifactsDir;
  }
  const ev = artifactsDir
    ? {
        bundle: JSON.parse(fs.readFileSync(path.join(artifactsDir, 'evidence.json'), 'utf8')) as ReturnType<typeof readLatestEvidence>['bundle'],
        artifactsDir,
        issues: validateBundleFile(path.join(artifactsDir, 'evidence.json')),
      }
    : readLatestEvidence(REPO_ROOT_DEFAULT, id);
  if (ev.issues.length) {
    console.error('refusing to prove against an invalid bundle:', ev.issues);
    return 3;
  }
  // Audit F4: the bundle is worthless unless the artifacts on disk still hash
  // to what it records. Verify BEFORE asserting against expectations.
  const tamper = verifyArtifacts(ev.artifactsDir, ev.bundle);
  if (tamper.length) {
    console.error('refusing to prove: evidence hashes do not match the artifacts on disk');
    for (const t of tamper) console.error('  ' + t);
    return 3;
  }
  const readLog = (round: 'baseline' | 'candidate'): string => {
    const p = path.join(ev.artifactsDir, `${round}-1.stdout.log`);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  };
  const checks = assertProof(ev.bundle, proof, {
    candidateStdout: readLog('candidate'),
    baselineStdout: readLog('baseline'),
  });
  const failed = checks.filter((c) => !c.ok);
  const skipped = checks.filter((c) => c.skipped);

  console.log('\n=== PROOF ASSERTIONS ===');
  for (const c of checks) {
    const tag = c.skipped ? ' skip ' : c.ok ? '  ok  ' : '  FAIL';
    console.log(`${tag} ${c.name}` +
      (c.ok ? '' : `\n         expected: ${JSON.stringify(c.expected)}\n         actual:   ${JSON.stringify(c.actual)}`));
  }
  console.log('='.repeat(60));
  console.log(failed.length === 0
    ? `CANARY REGRESSION PROOF: PASS — ${checks.length - skipped.length} assertion(s) held` +
      (skipped.length ? ` (${skipped.length} host-exact skipped: this is not the proof host)` : ' (all, incl. host-exact hashes)')
    : `CANARY REGRESSION PROOF: FAIL — ${failed.length}/${checks.length} assertions diverged`);
  console.log('='.repeat(60));
  return failed.length === 0 ? 0 : 1;
}

function validateBundleFile(p: string): string[] {
  return validateBundle(JSON.parse(fs.readFileSync(p, 'utf8')) as unknown);
}

function cmdReport(evidencePath: string | undefined, outPath?: string): number {
  let resolved = evidencePath;
  if (!resolved) {
    // Audit F12: `npm run report` (no argument) must work — default to the
    // most recent recorded run's evidence bundle.
    const latest = findLatestEvidencePath(REPO_ROOT_DEFAULT);
    if (!latest) {
      console.error('no runs recorded under .canary-runs — run an experiment first, or pass an explicit evidence.json');
      return 3;
    }
    resolved = latest.evidencePath;
    console.log(`using latest evidence (${latest.experimentId}): ${resolved}`);
  }
  const bundle = JSON.parse(fs.readFileSync(resolved, 'utf8')) as EvidenceBundle;
  const issues = validateBundle(bundle);
  if (issues.length) {
    console.error('refusing to render an invalid bundle:', issues);
    return 3;
  }
  const html = renderHtml(bundle);
  const target = outPath ?? path.join(path.dirname(resolved), 'report.html');
  fs.writeFileSync(target, html, 'utf8');
  console.log(`report: ${target}`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === 'version' || argv.includes('--version')) { console.log(`canary ${CANARY_VERSION}`); return 0; }
  if (cmd === 'run' && rest[0]) return cmdRun(rest[0]);
  if (cmd === 'prove' && rest[0]) return cmdProve(rest[0], rest[1] ?? defaultProofPath(rest[0]), true);
  if (cmd === 'check' && rest[0]) return cmdProve(rest[0], rest[1] ?? defaultProofPath(rest[0]), false);
  if (cmd === 'report') return cmdReport(rest[0], rest[1]);
  return usage();
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    if (e instanceof InfraAbort) { console.error(String(e.message)); process.exit(2); }
    console.error('ERROR:', e instanceof Error ? e.message : e);
    process.exit(3);
  });
