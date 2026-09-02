/**
 * Audit M8 — CLI subprocess integration: exit-code contract end to end.
 *
 * Spawns the BUILT CLI (`node dist/src/main.js ...`) as a child process
 * against a stub experiment run fully offline (fetch/extract seam; local
 * `node` scripts). Pins the contract documented in main.ts's header:
 *   check → exit 0 while the proof holds; 3 when artifacts are tampered;
 *   report → exit 3 on a fabricated bundle; version → 0; no args → 3.
 *
 * Post-GLM migration (same idiom as pipeline-e2e.test.ts): the stub fixture
 * STAGES its fake node_modules (AM-2 refuses a fixture that SHIPS one), the
 * prepare step materializes it after the audit AND lands the hash-pinned
 * Canary mocha double, and the test command runs through $bin:mocha — so the
 * CONFIRMED_REGRESSION bundle the CLI consumes carries REAL VALID
 * observations (rule 14 makes prose-only runs structurally unable to earn a
 * strong label). The exit-code/rendering assertions themselves are unchanged.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, describe, it } from 'node:test';

import { runExperiment } from '../src/pipeline.js';
import { sha256hex } from '@canary-rn/hashing';
import {
  writeStagedPayload, stageCommands, MOCHA_TEST_ARGV, widgetSpec, swapScript,
  WIDGET_PKGS, assertDoubleObservation,
} from './stub-harness.js';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..'); // dist/test -> dist -> cli -> apps -> repo root
const CLI = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');
assert.ok(fs.existsSync(CLI), `build first: ${CLI} missing`);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-cli-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const FAKE_SHA = 'a'.repeat(40);

const NODE = process.execPath;
const cli = (repoRoot: string, args: string[]) =>
  spawnSync(NODE, [CLI, ...args], { cwd: repoRoot, encoding: 'utf8', timeout: 120_000 });

/** Post-AM-2 stub: fake deps are STAGED (stub-payload/) and the generated
 *  prepare stager materializes them + the Canary mocha double after the
 *  audit; test.js is a real mocha spec (widget@1 green, widget@2 fails
 *  exactly 'candidate breaks widget'). */
function writeStub(stub: string): void {
  fs.mkdirSync(stub, { recursive: true });
  fs.writeFileSync(path.join(stub, 'package.json'),
    JSON.stringify({ name: 'downstream', version: '1.0.0', dependencies: { widget: '1.0.0' } }));
  writeStagedPayload(stub, WIDGET_PKGS);
  fs.writeFileSync(path.join(stub, 'test.js'), widgetSpec());
  fs.writeFileSync(path.join(stub, 'swap.js'), swapScript(false));
}

/** Offline confirmed-regression run staged as a repoRoot with spec + proof. */
async function stage(): Promise<{ repoRoot: string; specPath: string; artifactsDir: string }> {
  const repoRoot = fs.mkdtempSync(path.join(TMP, 'repo-'));
  const stub = path.join(repoRoot, 'stub-src');
  writeStub(stub);
  const spec = {
    schema: 2, id: 'stub-cli',
    dependency: { package: 'widget', baseline: '1.0.0', candidate: '2.0.0' },
    downstream: { repo: 'stub/downstream', commit: FAKE_SHA },
    commands: {
      // stage + land the pinned double (post-audit), then run the spec
      // through $bin:mocha so every round carries a real VALID observation.
      prepare: stageCommands({ mocha: true }),
      swap: ['node', 'swap.js', '{candidate}'],
      test: [...MOCHA_TEST_ARGV],
    },
    repeats: { baseline: 2, candidate: 2 },
    timeoutSecs: { install: 120, test: 120 },
  };
  // Round-3 B4: the fetch seam must declare the REAL digest of its bytes —
  // the prove/check gate re-hashes the retained fixture.tgz (verifyRunIdentity).
  const blob = Buffer.from('canary-cli-stub-tarball');
  const result = await runExperiment(spec, repoRoot, true, {
    fetch: async () => ({ bytes: blob, sha256: sha256hex(blob) }),
    extract: (_t, wsRoot) => fs.cpSync(stub, path.join(wsRoot, `downstream-${FAKE_SHA}`), { recursive: true }),
  });
  assert.equal(result.bundle.classification.label, 'CONFIRMED_REGRESSION');
  // the CLI scenarios below all reason about this bundle, so its strong label
  // must be EARNED (rule 14): every round VALID-attested by the pinned double.
  assertDoubleObservation(result.bundle.rounds);
  const specPath = path.join(repoRoot, 'stub-cli.json');
  fs.writeFileSync(specPath, JSON.stringify(spec, null, 2));
  const b = result.bundle;
  const hashes = (arm: 'baseline' | 'candidate'): string[] =>
    b.rounds.filter((r) => r.arm === arm).map((r) => r.normalizedStdoutSha256);
  const proof = {
    schema: 1, experimentId: 'stub-cli',
    dependency: spec.dependency, downstream: { repo: 'stub/downstream', commit: FAKE_SHA },
    // B4: a proof must pin the release-critical tarball digest.
    tarballSha256: b.downstream.tarballSha256,
    expected: {
      classification: 'CONFIRMED_REGRESSION', rule: 5, driftConfinedToDependency: true,
      baseline: { rounds: 2, exitCodes: [0, 0], normalizedStdoutSha256AcrossRounds: hashes('baseline'), summary: { passing: 2 } },
      candidate: { rounds: 2, exitCodes: [1, 1], normalizedStdoutSha256AcrossRounds: hashes('candidate'), summary: { passing: 1, failing: 1 } },
      failingTestNames: ['widget suite > candidate breaks widget'],
    },
  };
  fs.writeFileSync(specPath.replace(/\.json$/, '.proof.json'), JSON.stringify(proof, null, 2));
  return { repoRoot, specPath, artifactsDir: result.artifactsDir };
}

describe('audit M8 — CLI subprocess exit-code contract', () => {
  it('check on honest evidence exits 0 and prints PASS', async () => {
    const { repoRoot, specPath } = await stage();
    const r = cli(repoRoot, ['check', specPath]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /CANARY REGRESSION PROOF: PASS/);
  });

  it('check on a tampered artifact exits 3 and names the tampered file', async () => {
    const { repoRoot, specPath, artifactsDir } = await stage();
    fs.appendFileSync(path.join(artifactsDir, 'baseline-1.stdout.log'), 'forged\n');
    const r = cli(repoRoot, ['check', specPath]);
    assert.equal(r.status, 3);
    assert.match(r.stderr, /TAMPERED artifact baseline-1\.stdout\.log/);
  });

  it('report refuses a fabricated bundle (exit 3) and renders a valid one (exit 0)', async () => {
    const { repoRoot, artifactsDir } = await stage();
    const evidencePath = path.join(artifactsDir, 'evidence.json');
    const good = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    const bad = structuredClone(good);
    bad.classification = { label: 'PASS', rule: 3, reason: 'made up', reproductionCount: 2 };
    const badPath = path.join(artifactsDir, 'forged-evidence.json');
    fs.writeFileSync(badPath, JSON.stringify(bad));
    const refusal = cli(repoRoot, ['report', badPath]);
    assert.equal(refusal.status, 3);
    assert.match(refusal.stderr, /refusing to render an invalid bundle/);

    const render = cli(repoRoot, ['report', evidencePath]);
    assert.equal(render.status, 0, render.stderr);
    const htmlPath = path.join(artifactsDir, 'report.html');
    assert.ok(fs.existsSync(htmlPath), 'report.html must be written next to the evidence');
    const html = fs.readFileSync(htmlPath, 'utf8');
    assert.match(html, /CONFIRMED_REGRESSION/);
    // post-sol F1: the local-consistency banner must not claim plain VERIFIED,
    // and must point at prove/check for committed-proof agreement:
    assert.ok(!html.includes('VERIFIED'), `report banner overstated: ${html.slice(0, 600)}`);
    assert.match(html, /SELF-CONSISTENT/);
    assert.match(html, /committed proof/i);
    assert.match(render.stdout, /SELF-CONSISTENT/);
    assert.ok(!render.stdout.includes('VERIFIED'), render.stdout);
  });

  it('audit F12: report with NO argument defaults to the latest run and renders bundle-persisted failing identities', async () => {
    const { repoRoot, artifactsDir } = await stage();
    const r = cli(repoRoot, ['report']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /using latest evidence \(stub-cli\)/);
    const html = fs.readFileSync(path.join(artifactsDir, 'report.html'), 'utf8');
    // identities come from the bundle's candidate rounds (F13), not extras:
    assert.match(html, /Failing downstream tests \(candidate\)/);
    assert.match(html, /candidate breaks widget/);
  });

  it('version exits 0; no command prints usage and exits 3 (misuse)', () => {
    const repoRoot = fs.mkdtempSync(path.join(TMP, 'bare-'));
    const v = cli(repoRoot, ['version']);
    assert.equal(v.status, 0);
    assert.match(v.stdout, /canary \d+\.\d+\.\d+/);
    const none = cli(repoRoot, []);
    assert.equal(none.status, 3);
    assert.match(none.stdout, /usage:/);
  });

  it('round-3 secondary: an infrastructure abort exits 2 (environment fault), never 3 (misuse)', async () => {
    // The CLI `run` path has NO offline seam, so step [1] fetch of the
    // non-existent stub/downstream@<fake-sha> fails (404 online, ENOTFOUND
    // offline — both deterministic) and now throws InfraAbort. Pre-fix that
    // surfaced as a generic Error -> exit 3 (misuse, blaming the user);
    // round-3 wrapped acquisition as infrastructure -> exit 2 + banner.
    const repoRoot = fs.mkdtempSync(path.join(TMP, 'infra-'));
    const spec = {
      schema: 2, id: 'stub-infra',
      dependency: { package: 'widget', baseline: '1.0.0', candidate: '2.0.0' },
      downstream: { repo: 'stub/downstream-does-not-exist-canary-fixture', commit: FAKE_SHA },
      commands: {
        prepare: [['node', '-e', 'process.exit(4);']],
        swap: ['node', 'swap.js', '{candidate}'],
        test: ['node', 'test.js'],
      },
      repeats: { baseline: 2, candidate: 2 },
      timeoutSecs: { install: 60, test: 60 },
    };
    const specPath = path.join(repoRoot, 'stub-infra.json');
    fs.writeFileSync(specPath, JSON.stringify(spec));
    const r = cli(repoRoot, ['run', specPath]);
    assert.equal(r.status, 2, `stdout:${r.stdout}\nstderr:${r.stderr}`);
    assert.match(r.stderr, /INFRASTRUCTURE_FAILURE/);
  });
});
