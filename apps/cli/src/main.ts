#!/usr/bin/env node
/**
 * canary — independent verification layer CLI.
 *
 *   canary run   <spec.json>                 execute an experiment, write evidence
 *   canary prove <spec.json> [proof.json]    re-run and assert committed expectations
 *   canary check <spec.json> [proof.json]    prove without re-running (last evidence)
 *   canary report [evidence.json] [out.html] render the human-readable report
 *                                          (no args: the latest run's evidence)
 *   --- productization surface (see onboarding.ts for its doctrine) ---
 *   canary setup    [--yes]                  detect project+harness, wire automatic
 *                                          verification, smoke-run it (READY only on proof)
 *   canary doctor                            runs the checks NOW; READY only from this run
 *   canary uninstall                         remove exactly Canary's own changes
 *   canary checkpoint                        harness-internal: verify at completion boundary
 *   canary claim <text>                      record the agent's account as an UNTRUSTED
 *                                          hint — claims are not evidence, never a verdict
 *   canary task <text> [--kind k] [--requirement "..."]…
 *                                          register the task INTENT so Canary derives
 *                                          proof obligations for its kind — an
 *                                          AGENT_REPORTED hint that can only ADD
 *                                          obligations, never lift the sealed plan
 *
 * Exit codes: 0 proof holds fully on the proof host / CONFIRMED_REGRESSION as expected
 *             1 proof failed / PASS
 *             2 other classification / infra / proof INCOMPLETE — host-exact
 *               assertions could not be verified because this runtime is not
 *               the committed proof host (round-3 B3; never a PASS pretense)
 *             2 also: onboarding NEEDS ATTENTION / UNSUPPORTED (onboarding never
 *               exits 0 without having executed and seen its checks pass)
 *             3 misuse / refused bundle / NOT-SELF-CONSISTENT report
 *               (report's exit 0 means the evidence is self-consistent with
 *               the local artifacts — post-sol F1: it does NOT mean the
 *               committed proof was consulted; only prove/check do that)
 */

import fs from 'node:fs';
import path from 'node:path';

import { renderHtml } from '@canary-rn/report';
import { validateBundle, type EvidenceBundle } from '@canary-rn/evidence-schema';
import { runExperiment, InfraAbort, CANARY_VERSION } from './pipeline.js';
import {
  assertProof, readLatestEvidence, verifyArtifacts, verifyArtifactSemantics,
  verifyRunIdentity, verifyClassificationDerivation, hostBoundEvidenceChecks,
  findLatestEvidencePath, actualHostFingerprint, proofVerdict, environmentAttestationIssues,
  type ProofExpectation, type HostFingerprint, type TrustedRunSpec,
} from './prove.js';
import { verifyTreeSnapshots } from './verify-tree.js';
import { cmdSetup, cmdDoctor, cmdUninstall, cmdCheckpoint, cmdClaim, cmdTask } from './onboarding.js';

const REPO_ROOT_DEFAULT = path.resolve(process.cwd());

function usage(): never {
  console.log(`canary ${CANARY_VERSION} — cool diff. prove that it actually made the project better.

usage:
  canary run   <spec.json>
  canary prove <spec.json> [proof.json]
  canary check <spec.json> [proof.json]     assert last run's evidence (no re-run)
  canary report [evidence.json] [out.html]  (defaults: latest run's evidence; sibling report.html)
                                          (SELF-CONSISTENT requires byte + identity + tree +
                                          derivation checks ON THIS MACHINE — NOT a committed-
                                          proof comparison; that is prove/check. exit 0 on
                                          self-consistency, else NOT SELF-CONSISTENT, exit 3)
  canary setup [--yes]      one-command onboarding for a Node project (AI-harness auto-wiring)
  canary doctor             is Canary actually protecting this repo? Runs the checks now;
                            READY / NEEDS ATTENTION / UNSUPPORTED (--run accepted, always on)
  canary uninstall          remove Canary's own changes, keep everything else
  canary claim "<text>"     the agent's account, stored as an UNTRUSTED hint — claims
                            are not evidence; only Canary's own runs decide verdicts
  canary task "<intent>"    register task intent (--kind bugfix|refactor|dependency|
                            performance|ui|multi, --requirement per part) so completion
                            checks derive the task's proof obligations — a hint with zero
                            authority: it can only ADD obligations, never weaken the plan
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
  const spec = loadJson(specPath) as TrustedRunSpec;
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
  // Round-3 blocker 3 + post-GLM G: the ACTUAL runtime is sampled UP FRONT now
  // — host-exactness decides the replay of the execution-observation channel
  // (verifyArtifactSemantics / verifyClassificationDerivation) exactly like it
  // decides the argv/env host-bound checks below. If reality cannot even be
  // sampled, host-bound claims are unverifiable: explicit downgrade (exit 2),
  // not a pass, not a byte-mismatch failure invented from unsound inputs.
  let runtime: HostFingerprint;
  try {
    runtime = actualHostFingerprint();
  } catch (e) {
    console.error('refusing to certify host-exact claims: cannot sample the actual runtime (npm --version)');
    console.error(String(e));
    return 2;
  }
  const replayCtx = { spec, proof, runtime };
  // Audit F4: the bundle is worthless unless the artifacts on disk still hash
  // to what it records. Verify BEFORE asserting against expectations.
  const tamper = verifyArtifacts(ev.artifactsDir, ev.bundle);
  if (tamper.length) {
    console.error('refusing to prove: evidence hashes do not match the artifacts on disk');
    for (const t of tamper) console.error('  ' + t);
    return 3;
  }
  // Audit B4: the digests matching their bytes is not enough — the round facts
  // that DRIVE the classification must be reproduced FROM those bytes.
  const semantic = verifyArtifactSemantics(ev.artifactsDir, ev.bundle, replayCtx);
  if (semantic.length) {
    console.error('refusing to prove: recorded round facts do not match the artifact bytes');
    for (const s of semantic) console.error('  ' + s);
    return 3;
  }
  // Round-3 blocker 4-A: run identity and fetched content are bound to the
  // WORKSPACE, not the bundle's prose — runId must be the physical run
  // directory, and the recorded tarball digest must be the retained
  // fixture.tgz's actual bytes.
  const identity = verifyRunIdentity(ev.artifactsDir, ev.bundle);
  if (identity.length) {
    console.error('refusing to prove: run identity / tarball digest is not bound to the workspace bytes');
    for (const i of identity) console.error('  ' + i);
    return 3;
  }
  // Round-3 blocker 6: the tree claims (hashes, VALID status, copy counts,
  // drift confinement) must be reproduced from RETAINED npm-ls snapshot bytes
  // by an INDEPENDENT re-flatten — not taken on the bundle's word. Runs after
  // validateBundle (which structurally requires the snapshot refs for a
  // trustful label) and before assertProof (which asserts the proof's pinned
  // tree expectations against them).
  const tree = verifyTreeSnapshots(ev.bundle, ev.artifactsDir);
  if (tree.length) {
    console.error('refusing to prove: retained tree snapshots do not support the recorded tree facts');
    for (const t of tree) console.error('  ' + t);
    return 3;
  }
  // Round-3 blocker 4-B: the classification tuple (label, rule, REASON,
  // reproductionCount) must be reproducible from the artifact bytes plus the
  // retained tree snapshots — re-running classify() and the confinement guard
  // independently, never trusting the bundle's own recorded round facts.
  const derivation = verifyClassificationDerivation(ev.artifactsDir, ev.bundle, replayCtx);
  if (derivation.length) {
    console.error('refusing to prove: the recorded classification does not follow from the evidence bytes');
    for (const d of derivation) console.error('  ' + d);
    return 3;
  }
  const readLog = (round: 'baseline' | 'candidate'): string => {
    const p = path.join(ev.artifactsDir, `${round}-1.stdout.log`);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  };
  // (runtime was sampled up front — post-GLM G replay gating; see above.)
  const checks = assertProof(ev.bundle, proof, {
    candidateStdout: readLog('candidate'),
    baselineStdout: readLog('baseline'),
  }, runtime);
  // Round-3 blocker 4-C: on the actual pinned proof host, each round's argv
  // and env key set are re-derived from the COMMITTED spec and the sanitizer
  // policy — evidence cannot weaken its own execution record and reseal.
  // Off-host these two skip (B3 posture: the verdict downgrades to
  // INCOMPLETE, never PASS).
  checks.push(...hostBoundEvidenceChecks(ev.bundle, proof, spec, ev.artifactsDir, runtime));
  const v = proofVerdict(checks);

  console.log('\n=== PROOF ASSERTIONS ===');
  for (const c of checks) {
    const tag = c.skipped ? ' skip ' : c.ok ? '  ok  ' : '  FAIL';
    console.log(`${tag} ${c.name}` +
      (c.ok ? '' : `\n         expected: ${JSON.stringify(c.expected)}\n         actual:   ${JSON.stringify(c.actual)}`));
  }
  console.log('='.repeat(60));
  if (v.status === 'FAIL') {
    console.log(`CANARY REGRESSION PROOF: FAIL — ${v.failed.length}/${checks.length} assertions diverged`);
  } else if (v.status === 'INCOMPLETE') {
    console.log(`CANARY REGRESSION PROOF: INCOMPLETE — ${checks.length - v.skipped.length} assertion(s) held, ` +
      `but ${v.skipped.length} host-exact assertion(s) could not be verified: this runtime is NOT the committed proof host. ` +
      `PASS is not claimed (exit 2).`);
  } else {
    console.log(`CANARY REGRESSION PROOF: PASS — ${checks.length} assertion(s) held (all of them, host-exact included, ON the proof host)`);
  }
  console.log('='.repeat(60));
  return v.exitCode;
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
  // Audit B4: a report must not look more trustworthy than its evidence. Try to
  // verify the bundle against the on-disk artifacts (digests + byte-derived
  // facts); if that is not fully possible, RENDER BUT LABEL NOT SELF-CONSISTENT.
  const artifactsDir = path.dirname(resolved);
  // Round-3 blocker 3: normalized digests are machine-local. A report opened
  // on a machine that is not the machine the evidence claims to have run on
  // cannot attest those digests — and an evidence block whose claim does not
  // match reality is itself the forgery tell. Either way: a NOT-SELF-CONSISTENT note,
  // decided by the ACTUAL runtime, never by the bundle's own metadata.
  let hostNotes: string[];
  try {
    hostNotes = environmentAttestationIssues(bundle, actualHostFingerprint());
  } catch (e) {
    hostNotes = [`environment attestation: the actual runtime could not be sampled (${String(e)}) — host-bound digests are unverifiable here (round-3 B3)`];
  }
  const notes = [
    ...verifyArtifacts(artifactsDir, bundle),
    ...verifyArtifactSemantics(artifactsDir, bundle),
    // Round-3 B4: run identity/tarball bytes and the classification derivation
    // are checked here too — a report must not render resealed release facts
    // as self-consistent. (argv/envKeys need the committed spec, which report has
    // no handle on; those remain prove/check-only host-bound assertions.)
    ...verifyRunIdentity(artifactsDir, bundle),
    ...verifyClassificationDerivation(artifactsDir, bundle),
    // Round-3 B6: tree facts are only counted self-consistent when the independent snapshot
    // re-derivation also holds; without retained tree artifacts the report
    // says NOT SELF-CONSISTENT rather than rendering tree claims as confirmed.
    ...verifyTreeSnapshots(bundle, artifactsDir),
    ...hostNotes,
  ];
  const selfConsistent = notes.length === 0;
  const html = renderHtml(bundle, undefined, {
    status: selfConsistent ? 'SELF_CONSISTENT' : 'NOT_SELF_CONSISTENT',
    notes: selfConsistent ? undefined : notes.slice(0, 12),
  });
  const target = outPath ?? path.join(artifactsDir, 'report.html');
  fs.writeFileSync(target, html, 'utf8');
  // post-sol F1: report verifies AGAINST THE LOCAL ARTIFACTS ONLY; the
  // committed-proof comparison belongs to prove/check and is never implied.
  console.log(`report: ${target} (${selfConsistent
    ? 'SELF-CONSISTENT on local artifacts — committed proof NOT compared (use canary check)'
    : 'NOT SELF-CONSISTENT — see banner'})`);
  return selfConsistent ? 0 : 3;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === 'version' || argv.includes('--version')) { console.log(`canary ${CANARY_VERSION}`); return 0; }
  if (cmd === 'run' && rest[0]) return cmdRun(rest[0]);
  if (cmd === 'prove' && rest[0]) return cmdProve(rest[0], rest[1] ?? defaultProofPath(rest[0]), true);
  if (cmd === 'check' && rest[0]) return cmdProve(rest[0], rest[1] ?? defaultProofPath(rest[0]), false);
  if (cmd === 'report') return cmdReport(rest[0], rest[1]);
  // productization surface (apps/cli/src/onboarding.ts) — separate promise from
  // the proof pipeline above; exit codes: 0 READY, 2 NEEDS ATTENTION/UNSUPPORTED.
  if (cmd === 'setup') return cmdSetup(rest);
  if (cmd === 'doctor') return cmdDoctor(rest);
  if (cmd === 'uninstall') return cmdUninstall(rest);
  if (cmd === 'checkpoint') return cmdCheckpoint();
  if (cmd === 'claim') return cmdClaim(rest);
  if (cmd === 'task') return cmdTask(rest);
  return usage();
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    if (e instanceof InfraAbort) { console.error(String(e.message)); process.exit(2); }
    console.error('ERROR:', e instanceof Error ? e.message : e);
    process.exit(3);
  });
