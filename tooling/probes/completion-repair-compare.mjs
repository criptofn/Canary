#!/usr/bin/env node
// Run one frozen repair journey against two explicit installed CLI paths. No CLI fallback or build.
// Usage: node tooling/probes/completion-repair-compare.mjs <before-main.js> <after-main.js> <evidence-dir>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(import.meta.dirname, '../..');
const instrument = path.join(repo, 'apps/cli/dist/test/onboarding.test.js');
const fixture = path.join(repo, 'tooling/test-support/fixtures/f-regression.cjs');
const args = process.argv.slice(2);
if (args.length !== 3 || ![args[0], args[1], instrument].every((file) => fs.existsSync(file))) {
  console.error('FAIL: provide two existing installed main.js paths and an evidence directory; build the test instrument first');
  process.exit(2);
}
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const evidence = path.resolve(args[2]);
fs.mkdirSync(evidence, { recursive: true });
const report = {
  schema: 'canary-repair-comparison/1',
  at: new Date().toISOString(),
  orchestrator: { path: import.meta.filename, sha256: hash(import.meta.filename) },
  instrument: { path: instrument, sha256: hash(instrument) },
  fixture: { path: fixture, sha256: hash(fixture) },
  runtime: { executable: process.execPath, version: process.version, platform: process.platform },
  nativeAgentSession: false,
  runs: [],
};
for (const [index, file] of args.slice(0, 2).entries()) {
  const cli = path.resolve(file);
  const version = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  const argv = ['--test', '--test-name-pattern=scoped failures', instrument];
  const started = Date.now();
  const result = spawnSync(process.execPath, argv, {
    cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 120_000,
    env: { ...process.env, CANARY_TEST_CLI: cli },
  });
  const label = index === 0 ? 'before' : 'after';
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const expected = version.status === 0 && (index === 0
    ? result.status === 1 && /was never sealed/.test(output)
    : result.status === 0 && /scoped failures/.test(output) && /fail 0/.test(output));
  fs.writeFileSync(path.join(evidence, `${label}.log`), output);
  report.runs.push({ label, cli, cliSha256: hash(cli), version: version.stdout?.trim(), versionExit: version.status,
    argv, elapsedMs: Date.now() - started, exitCode: result.status, error: result.error?.message ?? null,
    observed: index === 0 ? 'expected known authority-sealing defect' : 'full repair journey must pass',
    expectationMet: expected, outputFile: `${label}.log` });
  console.log(`${expected ? 'PASS' : 'FAIL'} ${label}: ${cli}; exit ${result.status}; ${report.runs.at(-1).elapsedMs} ms`);
}
fs.writeFileSync(path.join(evidence, 'comparison.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`evidence: ${evidence}`);
process.exit(report.runs.every((run) => run.expectationMet) ? 0 : 1);
