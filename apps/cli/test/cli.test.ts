/**
 * Audit M8 — CLI subprocess integration: exit-code contract end to end.
 *
 * Spawns the BUILT CLI (`node dist/src/main.js ...`) as a child process
 * against a stub experiment run fully offline (fetch/extract seam; local
 * `node` scripts). Pins the contract documented in main.ts's header:
 *   check → exit 0 while the proof holds; 3 when artifacts are tampered;
 *   report → exit 3 on a fabricated bundle; version → 0; no args → 3.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, describe, it } from 'node:test';

import { runExperiment } from '../src/pipeline.js';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..'); // dist/test -> dist -> cli -> apps -> repo root
const CLI = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');
assert.ok(fs.existsSync(CLI), `build first: ${CLI} missing`);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-cli-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const FAKE_SHA = 'a'.repeat(40);

const NODE = process.execPath;
const cli = (repoRoot: string, args: string[]) =>
  spawnSync(NODE, [CLI, ...args], { cwd: repoRoot, encoding: 'utf8', timeout: 120_000 });

function writeStub(stub: string): void {
  fs.mkdirSync(path.join(stub, 'node_modules', 'widget'), { recursive: true });
  fs.writeFileSync(path.join(stub, 'package.json'),
    JSON.stringify({ name: 'downstream', version: '1.0.0', dependencies: { widget: '1.0.0' } }));
  fs.writeFileSync(path.join(stub, 'node_modules', 'widget', 'package.json'),
    JSON.stringify({ name: 'widget', version: '1.0.0', main: 'index.js' }));
  fs.writeFileSync(path.join(stub, 'node_modules', 'widget', 'index.js'), 'module.exports={}');
  fs.writeFileSync(path.join(stub, 'test.js'), [
    "const v = require('./node_modules/widget/package.json').version;",
    "if (v !== '2.0.0') { console.log('  2 passing (1ms)'); process.exit(0); }",
    "console.log('  1 passing (1ms)'); console.log('  1 failing'); console.log('');",
    "console.log('  1) widget suite:'); console.log('       candidate breaks widget:');",
    "process.exit(1);",
  ].join('\n'));
  fs.writeFileSync(path.join(stub, 'swap.js'),
    "const fs=require('fs');const p='./node_modules/widget/package.json';" +
    "const j=JSON.parse(fs.readFileSync(p));j.version='2.0.0';fs.writeFileSync(p,JSON.stringify(j));");
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
      prepare: [['node', '-e', "''"]],
      swap: ['node', 'swap.js', '{candidate}'],
      test: ['node', 'test.js'],
    },
    repeats: { baseline: 2, candidate: 2 },
    timeoutSecs: { install: 120, test: 120 },
  };
  const result = await runExperiment(spec, repoRoot, true, {
    fetch: async () => ({ bytes: Buffer.alloc(0), sha256: 'b'.repeat(64) }),
    extract: (_t, wsRoot) => fs.cpSync(stub, path.join(wsRoot, `downstream-${FAKE_SHA}`), { recursive: true }),
  });
  assert.equal(result.bundle.classification.label, 'CONFIRMED_REGRESSION');
  const specPath = path.join(repoRoot, 'stub-cli.json');
  fs.writeFileSync(specPath, JSON.stringify(spec, null, 2));
  const b = result.bundle;
  const hashes = (arm: 'baseline' | 'candidate'): string[] =>
    b.rounds.filter((r) => r.arm === arm).map((r) => r.normalizedStdoutSha256);
  const proof = {
    schema: 1, experimentId: 'stub-cli',
    dependency: spec.dependency, downstream: { repo: 'stub/downstream', commit: FAKE_SHA },
    expected: {
      classification: 'CONFIRMED_REGRESSION', rule: 5, driftConfinedToDependency: true,
      baseline: { rounds: 2, exitCodes: [0, 0], normalizedStdoutSha256AcrossRounds: hashes('baseline'), summary: { passing: 2 } },
      candidate: { rounds: 2, exitCodes: [1, 1], normalizedStdoutSha256AcrossRounds: hashes('candidate'), summary: { passing: 1, failing: 1 } },
      failingTestNames: ['candidate breaks widget'],
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
});
