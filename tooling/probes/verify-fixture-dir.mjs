#!/usr/bin/env node
/**
 * VALIDATE A FIXTURE DIRECTORY BEFORE IT IS PROMOTED INTO `tooling/benchmark/fixtures/`.
 *
 * `tooling/benchmark/fixtures.test.mjs` validates every REGISTERED fixture, which means it can
 * only run once the fixture is already inside the benchmark tree — and editing that tree changes
 * the instrument fingerprint of any benchmark batch that is running. This probe closes that gap:
 * point it at a staging directory and it applies exactly the same procedure
 * (untouched / known-good / known-bad, each a fresh copy with the solution overlaid, visible suite
 * then hidden oracle) and asserts the exit codes you pass in.
 *
 * It is deliberately the same procedure rather than a paraphrase: the visible suite is
 * `node run-tests.js` with cwd = the copied project, the oracle is
 * `node <fixture>/hidden/check.cjs <copied project>`, and a known-good solution must pass EVERY
 * hidden check (the summary line's numerator must equal its denominator).
 *
 * Usage:
 *   node tooling/probes/verify-fixture-dir.mjs <fixtureDir> \
 *        --untouched <visibleExit>/<hiddenExit> --good <visibleExit>/<hiddenExit> --bad <visibleExit>/<hiddenExit>
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runCaptured } from '../benchmark/capture.mjs';

const argv = process.argv.slice(2);
const fixtureDir = argv[0];
if (fixtureDir === undefined || argv.includes('--help')) {
  console.error('usage: node tooling/probes/verify-fixture-dir.mjs <fixtureDir> --untouched V/H --good V/H --bad V/H');
  process.exit(2);
}
const spec = (name) => {
  const v = argv[argv.indexOf(`--${name}`) + 1];
  if (v === undefined || !/^\d+\/\d+$/.test(v)) {
    console.error(`missing or malformed --${name} <visibleExit>/<hiddenExit>`);
    process.exit(2);
  }
  const [visible, hidden] = v.split('/').map(Number);
  return { visible, hidden };
};

let failures = 0;
const line = (ok, msg) => { if (!ok) failures += 1; console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); };

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    if (e.isDirectory()) copyDir(src, dst);
    else fs.copyFileSync(src, dst);
  }
}
// Captured through files, not pipes: a confined host refuses piped child stdio (EPERM), which is
// the difference between this probe measuring the fixture and measuring the sandbox.
const runSuite = (project) => runCaptured(process.execPath, ['run-tests.js'], { cwd: project, timeout: 180_000 });
const runOracle = (project) => runCaptured(process.execPath, [path.join(fixtureDir, 'hidden', 'check.cjs'), project], { timeout: 180_000 });

const forStates = [
  ['untouched', null, spec('untouched')],
  ['known-good', 'good', spec('good')],
  ['known-bad', 'bad', spec('bad')],
];

console.log(`fixture: ${fixtureDir}`);
for (const [label, solution, expected] of forStates) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `canary-fixture-${path.basename(fixtureDir)}-${solution ?? 'raw'}-`));
  const project = path.join(root, 'project');
  try {
    copyDir(path.join(fixtureDir, 'project'), project);
    if (solution !== null) {
      const dir = path.join(fixtureDir, 'solutions', solution);
      if (!fs.existsSync(dir)) throw new Error(`missing solutions/${solution}`);
      copyDir(dir, project);
    }
    const suite = runSuite(project);
    const oracle = runOracle(project);
    const summary = /hidden oracle: (\d+)\/(\d+) behaviour checks passed/.exec(oracle.stdout ?? '');
    console.log(`\n--- ${label}`);
    console.log(`    visible exit ${suite.status} (expected ${expected.visible})`);
    console.log(`    hidden  exit ${oracle.status} (expected ${expected.hidden})`);
    console.log(`    ${summary === null ? 'NO VERDICT LINE — the oracle did not report' : summary[0]}`);
    line(summary !== null, `${label}: the hidden oracle printed a verdict`);
    line(suite.status === expected.visible, `${label}: visible suite exit ${suite.status} == ${expected.visible}`);
    line(oracle.status === expected.hidden, `${label}: hidden oracle exit ${oracle.status} == ${expected.hidden}`);
    if (label === 'known-good') {
      line(summary !== null && summary[1] === summary[2], `${label}: EVERY hidden check passes (${summary?.[1]}/${summary?.[2]})`);
    }
    if (failures > 0) {
      console.log('    last lines of each side:');
      console.log(`      suite  : ${(suite.stdout ?? '').trim().split('\n').slice(-3).join(' | ')}`);
      console.log(`      oracle : ${(oracle.stdout ?? '').trim().split('\n').slice(-3).join(' | ')}`);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

console.log(`\n=== fixture directory: ${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} ===`);
process.exit(failures === 0 ? 0 : 1);
