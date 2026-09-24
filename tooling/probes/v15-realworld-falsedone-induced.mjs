#!/usr/bin/env node
/**
 * WS5 (v1.5) — **INDUCED** false-done demonstration, clearly labelled as such.
 *
 * DO NOT READ THIS AS ORGANIC AGENT BEHAVIOUR. The defect this probe introduces is
 * put there BY THE OPERATOR, on purpose, after the agent had already finished. It is
 * included because the workstream asks for a reproducible end-to-end demonstration
 * that the completion gate really does stop a "done" whose objective evidence fails,
 * and because in the whole real-world session NO organic case of that shape occurred
 * (what occurred instead is recorded in docs/REAL-WORLD-EVIDENCE-1.5.md, including a
 * natural NOT PROVEN block that investigation showed was NOT justified).
 *
 * WHAT IS REAL HERE (and what is not):
 *   real  — the worker's code (commit <worker-commit>, produced by a real Claude Code
 *           session under this repo's own Stop hook; see runs/H1-hermes-maxagedays/);
 *   real  — the project's own check, the sealed plan, the hook contract, the decision
 *           JSON, the exit codes and the repair;
 *   INDUCED — the regression. Reverting the fix while keeping the worker's test is the
 *           operator's act. An honest description is: "a worker finished and the code
 *           was then broken under it", NOT "the agent shipped a bug".
 *
 * FIVE CONDITIONS THIS MEASURES
 *   1. the agent attempted completion    -> the worker commit exists (its transcript is
 *                                           in runs/H1-hermes-maxagedays/agent.stream.jsonl);
 *   2. objective evidence FAILS          -> the sealed plan exits 1 with a named
 *                                           assertion, captured verbatim;
 *   3. Canary BLOCKS                     -> raw `canary checkpoint` stdout decision;
 *   4. the block is JUSTIFIED            -> asserted: the same plan passes once the fix
 *                                           is restored and fails only while it is not;
 *   5. after repair the evidence PASSES   -> second raw decision, no `block`.
 *
 * USAGE
 *   node tooling/probes/v15-realworld-falsedone-induced.mjs \
 *     --repo <abs path to the wired copy> --out <dir> \
 *     --worker-commit <sha> --base-commit <sha> --source <repo-relative source file>
 *
 * EXIT 0 only when every assertion below held. The probe restores the repository to the
 * worker commit before it exits, whatever happened.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const CLI = path.join(REPO_ROOT, 'apps', 'cli', 'dist', 'src', 'main.js');

function arg(name, dflt = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? dflt : process.argv[i + 1];
}
const repo = arg('repo');
const outDir = arg('out');
const workerCommit = arg('worker-commit');
const baseCommit = arg('base-commit');
const source = arg('source');
const planCmd = arg('plan-cmd', 'npm run test');
if (!repo || !outDir || !workerCommit || !baseCommit || !source) {
  console.error('usage: --repo <dir> --out <dir> --worker-commit <sha> --base-commit <sha> --source <repo-relative file> [--plan-cmd "<the project\'s own check command>"]');
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}\n     ${String(e?.message ?? e).split('\n').join('\n     ')}`); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

const git = (...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 120_000 });
const gitOut = (...args) => (git(...args).stdout ?? '').trim();
const write = (name, text) => fs.writeFileSync(path.join(outDir, name), text);

/** The hook JSON is byte-for-byte the contract in apps/cli/src/onboarding.ts:3195-3234. */
const hookInput = {
  session_id: 'ws5-induced-falsedone',
  transcript_path: path.join(outDir, 'worker-transcript-pointer.txt'),
  cwd: repo,
  hook_event_name: 'Stop',
  stop_hook_active: false,
};
write('hook-input.json', `${JSON.stringify(hookInput, null, 2)}\n`);
write('LABEL.txt', [
  'INDUCED — NOT ORGANIC AGENT BEHAVIOUR.',
  '',
  `The worker commit ${workerCommit} is real: it was produced by a real Claude Code session`,
  'under this repository\'s own Stop hook (see ../H1-hermes-maxagedays/).',
  'The regression this probe demonstrates was introduced by the OPERATOR after that session',
  'ended, by restoring the pre-fix source file while keeping the worker\'s regression test.',
  'Everything else — the sealed plan, the hook input, the decision JSON, the exit codes,',
  'the failing assertion and the repair — is the product, unmodified.',
].join('\n'));

const driveCheckpoint = (name) => {
  const cp = spawnSync(process.execPath, [CLI, 'checkpoint'], {
    cwd: repo, input: JSON.stringify(hookInput), encoding: 'utf8', timeout: 1_800_000,
  });
  write(`${name}.stdout.txt`, `${(cp.stdout ?? '').trim()}\n`);
  write(`${name}.stderr.txt`, `${(cp.stderr ?? '').trim()}\n`);
  write(`${name}.exit.txt`, `${cp.status}\n`);
  return { status: cp.status, stdout: (cp.stdout ?? '').trim(), stderr: (cp.stderr ?? '').trim() };
};

let restored = false;
try {
  // ---------------------------------------------------------------- preconditions
  const head = gitOut('rev-parse', 'HEAD');
  write('state-before.json', `${JSON.stringify({ head, status: gitOut('status', '--porcelain') }, null, 2)}\n`);
  check('the repository is at the worker commit', () => assert(head === workerCommit, `HEAD is ${head}, expected ${workerCommit}`));

  // ---------------------------------------------------------------- a passing baseline first
  const decisionBefore = driveCheckpoint('decision-before-induction');
  check('the worker\'s own completion is NOT blocked (this is the state the agent left)', () => {
    const d = decisionBefore.stdout ? JSON.parse(decisionBefore.stdout) : {};
    assert(decisionBefore.status === 0, `checkpoint exit ${decisionBefore.status}`);
    assert(d.decision !== 'block', `unexpectedly blocked before the induction: ${decisionBefore.stdout.slice(0, 300)}`);
  });

  // ---------------------------------------------------------------- INDUCE the regression
  assert(git('checkout', baseCommit, '--', source).status === 0, `could not revert ${source}`);
  write('induced.diff', git('diff', 'HEAD').stdout ?? '');
  const inducedDiff = fs.readFileSync(path.join(outDir, 'induced.diff'), 'utf8');
  check('INDUCED: the fix is reverted while the worker\'s regression test stays', () => {
    assert(inducedDiff.includes(source), `expected a diff on ${source}, got: ${inducedDiff.slice(0, 200)}`);
  });

  // ---------------------------------------------------------------- condition 2: the evidence FAILS
  const plan = spawnSync(planCmd, { cwd: repo, encoding: 'utf8', timeout: 900_000, shell: true });
  write('plan-after-induction.out.txt', `${plan.stdout ?? ''}\n--- stderr ---\n${plan.stderr ?? ''}\n`);
  check('the project\'s own sealed check FAILS after the induction', () => {
    assert(plan.status !== 0, `the sealed plan exited 0 with the fix reverted — the demonstration is void`);
  });

  // ---------------------------------------------------------------- condition 3: Canary BLOCKS
  const decisionBlocked = driveCheckpoint('decision-blocked');
  check('Canary BLOCKS the completion', () => {
    const d = decisionBlocked.stdout ? JSON.parse(decisionBlocked.stdout) : {};
    assert(d.decision === 'block', `expected {"decision":"block"}, got: ${decisionBlocked.stdout.slice(0, 300)}`);
    assert(/tests/.test(String(d.reason ?? '')), `the block reason does not name the failing check: ${d.reason}`);
  });

  // ---------------------------------------------------------------- condition 5: repair
  assert(git('checkout', workerCommit, '--', source).status === 0, `could not restore ${source}`);
  restored = true;
  write('repair.diff', git('diff', 'HEAD').stdout ?? '');
  check('after the repair the working tree is clean again', () => {
    assert((git('diff', 'HEAD').stdout ?? '').trim() === '', `tree still dirty: ${git('diff', 'HEAD').stdout}`);
  });
  const planAfter = spawnSync(planCmd, { cwd: repo, encoding: 'utf8', timeout: 900_000, shell: true });
  write('plan-after-repair.out.txt', `${planAfter.stdout ?? ''}\n--- stderr ---\n${planAfter.stderr ?? ''}\n`);
  check('condition 5 — the evidence PASSES after the repair', () => {
    assert(planAfter.status === 0, `the sealed plan still exits ${planAfter.status} after the repair`);
  });
  const decisionAfter = driveCheckpoint('decision-after-repair');
  check('condition 5 — Canary no longer blocks', () => {
    const d = decisionAfter.stdout ? JSON.parse(decisionAfter.stdout) : {};
    assert(decisionAfter.status === 0, `checkpoint exit ${decisionAfter.status}`);
    assert(d.decision !== 'block', `still blocked after repair: ${decisionAfter.stdout.slice(0, 300)}`);
  });
} finally {
  if (!restored) {
    git('checkout', workerCommit, '--', source);
    console.log(`(cleanup) restored ${source} from ${workerCommit}`);
  }
}

console.log(`\n--- INDUCED false-done demonstration: ${failures === 0 ? 'ALL CONDITIONS MEASURED' : `${failures} FAILURE(S)`}`);
console.log('--- artifacts: ' + outDir);
process.exit(failures === 0 ? 0 : 1);
