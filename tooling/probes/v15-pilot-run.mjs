#!/usr/bin/env node
/** Run the six paired agent sessions with native evidence and hard guards. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hasCodexLocalUsageEvidence } from './v15-codex-jsonl.mjs';
import { hasOllamaNativeUsageEvidence } from './v15-ollama-native-agent.mjs';

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const arg = (name, fallback = null) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const worktree = path.resolve(arg('worktree') ?? path.resolve(import.meta.dirname, '../..'));
const preparedRoot = path.resolve(arg('prepared-root') ?? 'C:\\Users\\Johannes\\AppData\\Local\\Temp\\canary-v15-pilot-20260927');
const outRoot = path.resolve(arg('out') ?? '.');
const cli = path.resolve(arg('cli') ?? '');
const protocol = arg('agent-protocol', 'claude');
const agent = path.resolve(arg('agent') ?? (['codex-local', 'ollama-native'].includes(protocol) ? process.execPath : "C:\\Users\\Johannes\\.local\\bin\\claude.exe"));
const codexEntryArg = arg('codex-entry');
const codexEntry = codexEntryArg ? path.resolve(codexEntryArg) : null;
const agentEntryArg = arg('agent-entry');
const agentEntry = agentEntryArg ? path.resolve(agentEntryArg) : (protocol === 'ollama-native' ? path.join(worktree, 'tooling/probes/v15-ollama-native-agent.mjs') : null);
const ollamaCli = protocol === 'ollama-native' ? path.resolve(arg('ollama') ?? path.join(process.env.LOCALAPPDATA ?? '', 'Programs/Ollama/ollama.exe')) : null;
const oracle = path.resolve(arg('oracle', path.join(worktree, 'tooling/probes/v15-validation-oracle.mjs')));
const runProbe = path.resolve(arg('run-probe', path.join(worktree, 'tooling/probes/v15-realworld-run-task.mjs')));
const codexJsonlParser = path.join(worktree, 'tooling/probes/v15-codex-jsonl.mjs');
const artifact = arg('artifact-sha256', 'cf8f777a68f3646df0cf0228b245a8084f56329c2999bb082134a20de0b89386');
const model = arg('model', ['codex-local', 'ollama-native'].includes(protocol) ? 'qwen3.5:9b' : 'qwen3.8-flash');
const checksFileArg = arg('checks-file');
const checksFile = checksFileArg ? path.resolve(checksFileArg) : null;
const providerCostApplicable = protocol === 'claude';
const perSessionMax = Number(arg('per-session-max-usd', '2.5'));
const totalMax = Number(arg('total-max-usd', '30'));
const timeoutMin = Number(arg('timeout-min', '30'));
const taskRoot = path.join(worktree, 'tooling/benchmark/results/session-evidence/v15-realworld/tasks');
const taskRunner = path.join(worktree, 'tooling/probes/v15-release-validation-task.mjs');
const taskFiles = {
  H1: 'H1-maxagedays-zero.md', H2: 'H2-invoice-classification.md',
  H3: 'H3-quantize-bits-validation.md', H5: 'H5-simulation-cases.md',
  R1: 'R1-pytest-id-collision.md', S1: 'S1-idlookup-ambiguity.md',
};
const toolchains = {
  H1: [], H2: [], H3: [], H5: [],
  R1: [
    'C:\\Users\\Johannes\\Desktop\\canary-ws5-scratch\\python311',
    'C:\\Users\\Johannes\\Desktop\\canary-ws5-scratch\\python311\\Scripts',
    'C:\\Program Files\\Git\\cmd', 'C:\\Program Files\\Git\\usr\\bin',
  ],
  S1: [
    'C:\\Users\\Johannes\\.gradle\\wrapper\\dists\\gradle-8.13-bin\\5xuhj0ry160q40clulazy9h7d\\gradle-8.13\\bin',
    'C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.12.101-hotspot\\bin',
  ],
};
const allSessions = [
  ['H1', 'plain'], ['H1', 'canary'],
  ['H2', 'canary'], ['H2', 'plain'],
  ['H3', 'plain'], ['H3', 'canary'],
  ['H5', 'canary'], ['H5', 'plain'],
  ['R1', 'plain'], ['R1', 'canary'],
  ['S1', 'canary'], ['S1', 'plain'],
];
const requestedLabels = arg('tasks')?.split(',') ?? Object.keys(taskFiles);
if (!requestedLabels.length || new Set(requestedLabels).size !== requestedLabels.length || requestedLabels.some((label) => !taskFiles[label])) {
  throw new Error('--tasks must name unique existing task labels separated by commas');
}
const schedule = allSessions.filter(([label]) => requestedLabels.includes(label));
const run = (executable, args, cwd, timeout = 10_000) => spawnSync(executable, args, {
  cwd, encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024,
});
const npmVersion = run(process.execPath, [cli, '--version'], worktree);
const agentVersionRun = protocol === 'codex-local'
  ? (codexEntry ? run(agent, [codexEntry, '--version'], worktree) : { status: 1, stdout: '', stderr: 'missing --codex-entry' })
  : protocol === 'ollama-native'
    ? (agentEntry ? run(agent, [agentEntry, '--version'], worktree) : { status: 1, stdout: '', stderr: 'missing --agent-entry' })
  : run(agent, ['--version'], worktree);
if (!fs.statSync(preparedRoot, { throwIfNoEntry: false })?.isDirectory()
  || !fs.statSync(cli, { throwIfNoEntry: false })?.isFile()
  || !fs.statSync(agent, { throwIfNoEntry: false })?.isFile()
  || !['claude', 'codex-local', 'ollama-native'].includes(protocol)
  || (protocol === 'codex-local' && (!codexEntry || !fs.statSync(codexEntry, { throwIfNoEntry: false })?.isFile()))
  || (protocol === 'ollama-native' && (!agentEntry || !fs.statSync(agentEntry, { throwIfNoEntry: false })?.isFile()))
  || (protocol === 'ollama-native' && !fs.statSync(ollamaCli, { throwIfNoEntry: false })?.isFile())
  || (checksFile && (protocol !== 'ollama-native' || !fs.statSync(checksFile, { throwIfNoEntry: false })?.isFile()))
  || !fs.statSync(oracle, { throwIfNoEntry: false })?.isFile()
  || !fs.statSync(runProbe, { throwIfNoEntry: false })?.isFile()
  || (protocol === 'codex-local' && !fs.statSync(codexJsonlParser, { throwIfNoEntry: false })?.isFile())
  || npmVersion.status !== 0 || !/^canary 1\.5\.0\s*$/m.test(npmVersion.stdout ?? '')
  || agentVersionRun.status !== 0 || !/\d+\.\d+\.\d+/.test(agentVersionRun.stdout ?? '')
  || !Number.isFinite(perSessionMax) || perSessionMax <= 0 || perSessionMax > 2.5
  || !Number.isFinite(totalMax) || totalMax <= 0 || totalMax > 30
  || !Number.isFinite(timeoutMin) || timeoutMin <= 0 || timeoutMin > 30
  || fs.existsSync(outRoot)) {
  console.error('usage: --prepared-root <complete pilot prep> --out <new evidence directory> --cli <installed 1.5.0 main.js> [--agent-protocol claude|codex-local|ollama-native] [--agent <executable>] [--codex-entry <codex.js>] [--agent-entry <ollama runner>] [--ollama <ollama.exe>] [--model <model>] [--per-session-max-usd <=2.50] [--total-max-usd <=30] [--timeout-min <=30]');
  process.exit(2);
}
const preparation = JSON.parse(fs.readFileSync(path.join(preparedRoot, 'preparation-summary.json'), 'utf8'));
if (preparation.status !== 'complete' || preparation.records.length !== schedule.length) throw new Error('pilot preparation is incomplete; no model call was started');
for (const [label, arm] of schedule) {
  const repo = path.join(preparedRoot, 'projects', label, arm);
  if (!fs.statSync(repo, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`missing prepared workspace ${label}/${arm}`);
  const preflightPath = path.join(preparedRoot, 'preflight', arm, label, 'attempt-result.json');
  const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8'));
  if (preflight.status !== 'complete' || (arm === 'canary' && !preflight.sealedBaselineHead)) throw new Error(`preflight is incomplete for ${label}/${arm}`);
}
fs.mkdirSync(outRoot, { recursive: true });
const startedAt = new Date().toISOString();
const manifest = {
  schema: 'canary-v15-paired-agent-pilot/2',
  probe: 'tooling/probes/v15-pilot-run.mjs',
  probeSha256: sha256(fs.readFileSync(fileURLToPath(import.meta.url))),
  runProbeSha256: sha256(fs.readFileSync(runProbe)), oracleSha256: sha256(fs.readFileSync(oracle)),
  codexJsonlParserSha256: protocol === 'codex-local' ? sha256(fs.readFileSync(codexJsonlParser)) : null,
  ollamaNativeAgentSha256: protocol === 'ollama-native' ? sha256(fs.readFileSync(agentEntry)) : null,
  ollamaCliPath: ollamaCli, ollamaCliSha256: ollamaCli ? sha256(fs.readFileSync(ollamaCli)) : null,
  cliPath: cli, cliVersion: (npmVersion.stdout ?? '').trim(), cliSha256: sha256(fs.readFileSync(cli)), artifactSha256: artifact,
  agentProtocol: protocol, agentPath: agent,
  agentEntryPath: protocol === 'codex-local' ? codexEntry : protocol === 'ollama-native' ? agentEntry : null,
  agentEntrySha256: protocol === 'codex-local' ? sha256(fs.readFileSync(codexEntry)) : protocol === 'ollama-native' ? sha256(fs.readFileSync(agentEntry)) : null,
  agentVersion: (agentVersionRun.stdout ?? '').trim(), runnerRuntime: process.version,
  model, preflightModel: preparation.model ?? null, providerUsdCostApplicable: providerCostApplicable,
  tasks: requestedLabels, checksFile, checksFileSha256: checksFile ? sha256(fs.readFileSync(checksFile)) : null,
  budgetCapPerSessionUsd: providerCostApplicable ? perSessionMax : null, totalBudgetCapUsd: providerCostApplicable ? totalMax : null, timeoutMinutes: timeoutMin,
  maximumSessions: schedule.length, schedule: schedule.map(([label, arm], index) => ({ order: index + 1, label, arm })),
  preparationSummary: preparation, startedAt,
};
fs.writeFileSync(path.join(outRoot, 'pilot-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });

const outcomes = [];
let costTotal = 0;
let stopReason = null;
for (let i = 0; i < schedule.length; i++) {
  const [label, arm] = schedule[i];
  let sessionCap = null;
  if (providerCostApplicable) {
    const remaining = totalMax - costTotal;
    if (!(remaining > 0)) { stopReason = 'total budget exhausted before next session'; break; }
    sessionCap = Math.min(perSessionMax, remaining);
  }
  const repo = path.join(preparedRoot, 'projects', label, arm);
  const taskFile = path.join(taskRoot, taskFiles[label]);
  const runRoot = path.join(outRoot, 'runs', label, arm);
  const extraPath = toolchains[label].join(path.delimiter);
  const args = [runProbe, '--repo', repo, '--task-file', taskFile, '--label', label,
    '--out', runRoot, '--cli', cli, '--artifact-sha256', artifact,
    '--attempt', 'pilot-1', '--arm', arm, '--timeout-min', String(timeoutMin),
    '--agent-cmd', agent];
  if (providerCostApplicable) args.push('--max-budget-usd', String(sessionCap), '--agent-arg', '--model', '--agent-arg', model);
  else if (protocol === 'codex-local') args.push('--agent-protocol', 'codex-local', '--model', model, '--agent-arg', codexEntry);
  else args.push('--agent-protocol', 'ollama-native', '--model', model, '--agent-entry', agentEntry);
  if (checksFile) args.push('--agent-arg', '--checks-file', '--agent-arg', checksFile);
  if (extraPath) args.push('--extra-path', extraPath);
  const started = new Date().toISOString();
  console.log(providerCostApplicable
    ? `START ${i + 1}/${schedule.length} ${label}/${arm}; per-session cap ${sessionCap.toFixed(2)}, accounted ${costTotal.toFixed(4)}/${totalMax.toFixed(2)}`
    : `START ${i + 1}/${schedule.length} ${label}/${arm}; local ${model}, provider USD charge not applicable`);
  const agentRun = run(process.execPath, args, worktree, timeoutMin * 60_000 + 120_000);
  const attemptDir = path.join(runRoot, 'pilot-1');
  const ledgerPath = path.join(attemptDir, 'ledger.json');
  const recordPath = path.join(attemptDir, 'record.json');
  const resultPath = path.join(attemptDir, 'attempt-result.json');
  const ledger = fs.existsSync(ledgerPath) ? JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) : null;
  const agentRecord = fs.existsSync(recordPath) ? JSON.parse(fs.readFileSync(recordPath, 'utf8')) : null;
  const attemptResult = fs.existsSync(resultPath) ? JSON.parse(fs.readFileSync(resultPath, 'utf8')) : null;
  const nativeCost = ledger?.totalCostUsdProvider;
  const costPresent = !providerCostApplicable || (Number.isFinite(nativeCost) && nativeCost >= 0);
  if (providerCostApplicable && costPresent) costTotal += nativeCost;
  const modelUnload = protocol === 'ollama-native' ? run(ollamaCli, ['stop', model], worktree, 30_000) : null;
  const oracleOut = path.join(outRoot, 'oracles', label, arm);
  const oracleArgs = [oracle, '--label', label, '--repo', repo, '--out', oracleOut, '--expected', 'pass'];
  if (label === 'R1') oracleArgs.push('--runtime-root', repo);
  if (label === 'S1') {
    oracleArgs.push('--javac', path.join(toolchains.S1[1], 'javac.exe'), '--java', path.join(toolchains.S1[1], 'java.exe'));
  }
  const correctnessRun = run(process.execPath, oracleArgs, worktree, 180_000);
  const correctnessPath = path.join(oracleOut, 'oracle-result.json');
  const correctness = fs.existsSync(correctnessPath) ? JSON.parse(fs.readFileSync(correctnessPath, 'utf8')) : null;
  const outcome = {
    order: i + 1, label, arm, protocol, startedAt: started, finishedAt: new Date().toISOString(),
    runExitCode: agentRun.status ?? null, runTimeout: agentRun.error?.code === 'ETIMEDOUT',
    attemptStatus: attemptResult?.status ?? 'missing',
    agentSessionOutcome: ledger?.agentSessionOutcome ?? 'missing',
    resultSubtype: ledger?.resultSubtype ?? null, isError: ledger?.resultIsError ?? null,
    stopReason: ledger?.stopReason ?? null, model: ledger?.model ?? null,
    nativeCostUsd: providerCostApplicable && costPresent ? nativeCost : null, accountedTotalUsd: providerCostApplicable ? costTotal : null,
    budgetCapUsd: providerCostApplicable ? sessionCap : null, costWithinSessionBudget: providerCostApplicable ? (ledger?.costWithinSessionBudget ?? false) : null,
    localModelRuntime: ledger?.localModelRuntime?.after ?? null,
    localModelUnload: modelUnload ? { exitCode: modelUnload.status ?? null, timedOut: modelUnload.error?.code === 'ETIMEDOUT', error: modelUnload.error?.message ?? null } : null,
    nativeUsage: ledger?.usage ?? null, numTurns: ledger?.numTurns ?? null,
    hookFiredDuringRun: agentRecord?.hookFiredDuringRun ?? null,
    checkpointDrivenManually: agentRecord?.checkpointDrivenManually ?? null,
    blockDecisionObserved: agentRecord?.verification?.blockDecisionObserved ?? null,
    checkpointStatus: agentRecord?.verification?.checkpointStatus ?? null,
    evidenceStatus: agentRecord?.verification?.evidenceStatus ?? 'unknown',
    correctnessStatus: correctness?.testPassed === true ? 'pass' : correctness?.testPassed === false ? 'fail' : 'incomplete',
    oracleExitCode: correctnessRun.status ?? null,
    runRoot, attemptDir, oracleOut,
  };
  outcomes.push(outcome);
  fs.writeFileSync(path.join(outRoot, `session-${String(i + 1).padStart(2, '0')}.json`), `${JSON.stringify(outcome, null, 2)}\n`, { flag: 'wx' });
  console.log(providerCostApplicable
    ? `END ${i + 1}/${schedule.length} ${label}/${arm}: session=${outcome.agentSessionOutcome}; evidence=${outcome.evidenceStatus}; oracle=${outcome.correctnessStatus}; cost=${costPresent ? `$${nativeCost.toFixed(4)}` : 'MISSING'}; total=$${costTotal.toFixed(4)}`
    : `END ${i + 1}/${schedule.length} ${label}/${arm}: session=${outcome.agentSessionOutcome}; evidence=${outcome.evidenceStatus}; oracle=${outcome.correctnessStatus}; tokens=${JSON.stringify(outcome.nativeUsage)}; runtime=${JSON.stringify(outcome.localModelRuntime)}`);
  if (providerCostApplicable && !costPresent) { stopReason = 'native provider cost missing; stopped before the next paid session'; break; }
  if (providerCostApplicable && (nativeCost > sessionCap || costTotal > totalMax)) { stopReason = 'provider reported cost beyond an enforced cap; stopped before the next session'; break; }
  if (ledger?.model !== model) { stopReason = `observed model ${String(ledger?.model)} differs from pinned ${model}`; break; }
  if (protocol === 'codex-local' && !hasCodexLocalUsageEvidence(ledger?.usage, outcome.localModelRuntime)) { stopReason = 'local model runtime or native usage evidence is missing'; break; }
  if (protocol === 'ollama-native' && !hasOllamaNativeUsageEvidence(ledger?.usage, outcome.localModelRuntime)) { stopReason = 'Ollama local model runtime or native token usage evidence is missing'; break; }
  if (protocol === 'ollama-native' && modelUnload?.status !== 0) { stopReason = 'local Ollama model could not be unloaded after the session'; break; }
  if (protocol === 'codex-local' && arm === 'canary' && outcome.hookFiredDuringRun !== true) { stopReason = 'Canary Stop hook did not fire in the model session'; break; }

  if (!correctness || correctnessRun.status !== 0) console.log(`OBSERVED correctness oracle outcome for ${label}/${arm}; raw oracle report saved`);
}
const summary = {
  ...manifest, finishedAt: new Date().toISOString(),
  sessions: outcomes, sessionsAttempted: outcomes.length,
  sessionsWithTerminalResult: outcomes.filter((o) => o.resultSubtype !== null).length,
  sessionsComplete: outcomes.filter((o) => o.attemptStatus === 'complete' && ['completed', 'completed_after_block_and_repair', 'completed_after_canary_stop_guard'].includes(o.agentSessionOutcome)).length,
  correctnessPasses: outcomes.filter((o) => o.correctnessStatus === 'pass').length,
  correctlyAccountedUsd: providerCostApplicable ? costTotal : null, stopReason,
  status: outcomes.length === schedule.length && outcomes.every((o) => o.attemptStatus === 'complete' && ['completed', 'completed_after_block_and_repair', 'completed_after_canary_stop_guard'].includes(o.agentSessionOutcome) && o.correctnessStatus !== 'incomplete' && (protocol !== 'ollama-native' || o.localModelUnload?.exitCode === 0))
    ? 'complete' : 'incomplete',
  statement: outcomes.length === schedule.length
    ? `${schedule.length} sessions and independent oracle outcomes were recorded; correctness and Canary proof status are reported separately.`
    : `Stopped after ${outcomes.length} session(s): ${stopReason}`,
};
fs.writeFileSync(path.join(outRoot, 'pilot-summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' });
const files = fs.readdirSync(outRoot, { recursive: true }).filter((name) => typeof name === 'string' && fs.statSync(path.join(outRoot, name)).isFile() && name !== 'SHA256SUMS').sort();
fs.writeFileSync(path.join(outRoot, 'SHA256SUMS'), `${files.map((name) => `${sha256(fs.readFileSync(path.join(outRoot, name)))}  ${name.replaceAll('\\', '/')}`).join('\n')}\n`, { flag: 'wx' });
console.log(providerCostApplicable
  ? `--- PILOT ${summary.status}: ${outcomes.length}/${schedule.length} attempted; native cost ${costTotal.toFixed(4)}${stopReason ? `; stopped: ${stopReason}` : ''}`
  : `--- PILOT ${summary.status}: ${outcomes.length}/${schedule.length} attempted; local inference, no provider USD charge${stopReason ? `; stopped: ${stopReason}` : ''}`);
process.exitCode = summary.status === 'complete' ? 0 : 1;
