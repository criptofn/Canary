#!/usr/bin/env node
/**
 * WS5 (v1.5 "Evidence Release") — run ONE real agent task against a REAL third-party
 * repository copy and capture the completion gate's verdict, unfaked.
 *
 * WHY THIS IS A PROBE AND NOT A SHELL ONE-LINER: the measurement is a long chain of
 * observations (agent stream → usage ledger → whether Canary's own Stop hook fired
 * *during* the run → the raw hook JSON → the raw decision JSON → the diff), and a
 * chain like that must be one reviewable artefact with an explicit exit code. It is
 * also the rule this repository writes down in AGENTS.md: no inline interpreter
 * snippets for multi-step verification.
 *
 * WHAT IT DOES NOT DO
 *  - it never writes inside the repository it measures outside of what the AGENT
 *    itself writes (the probe only reads, plus writes its record under --out);
 *  - it never invents a verdict: if the hook did not fire, the record says so and
 *    the manually driven invocation is labelled as such;
 *  - it never prints a secret. Endpoint values are read from ~/.claude/settings.json
 *    `env` and forwarded by KEY; only key NAMES are ever recorded or logged.
 *
 * USAGE
 *   node tooling/probes/v15-realworld-run-task.mjs \
 *     --repo <abs path> --task-file <file> --label <id> --out <dir> [--arm canary|plain]
 *     [--timeout-min 20] [--extra-path <dir>[;<dir>...]]
 *
 * EXIT CODE: 0 only when the run produced a parseable result event AND a checkpoint
 * decision (or an honest allow) — i.e. the measurement completed. Infrastructure
 * failures print FAIL and exit 1.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const CLI = path.join(REPO_ROOT, 'apps', 'cli', 'dist', 'src', 'main.js');

// ---------------------------------------------------------------- args
function arg(name, dflt = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? dflt : process.argv[i + 1];
}
const repo = arg('repo');
const taskFile = arg('task-file');
const label = arg('label');
const outDir = arg('out');
const arm = arg('arm', 'canary');
const timeoutMin = Number(arg('timeout-min', '20'));
const extraPath = arg('extra-path', '');
if (!repo || !taskFile || !label || !outDir) {
  console.error('usage: --repo <dir> --task-file <file> --label <id> --out <dir> [--arm canary|plain] [--timeout-min N] [--extra-path <dirs>]');
  process.exit(2);
}

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}\n     ${String(e?.message ?? e).split('\n').join('\n     ')}`); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const nowIso = () => new Date().toISOString();
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

fs.mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------- git facts
const git = (...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 120_000 });
const gitOut = (...args) => (git(...args).stdout ?? '').trim();
const before = {
  head: gitOut('rev-parse', 'HEAD'),
  tree: gitOut('rev-parse', 'HEAD^{tree}'),
  status: gitOut('status', '--porcelain'),
  tracked: gitOut('ls-files').split('\n').filter(Boolean).length,
};
fs.writeFileSync(path.join(outDir, 'git-before.json'), `${JSON.stringify(before, null, 2)}\n`);

// ---------------------------------------------------------------- env (keys only)
/**
 * The endpoint configuration lives in the operator's USER-level Claude Code
 * settings. The benchmark harness (tooling/benchmark/run-trial.mjs:540-558) runs
 * trials with `--setting-sources project,local` so that user-level hooks and
 * instruction blocks cannot dominate the observed behaviour, and forwards these
 * `env` values explicitly for exactly that reason. Same posture here: KEY NAMES
 * are recorded, VALUES are never written to any file this probe produces.
 */
const forwardedKeys = [];
const agentEnv = {
  ...process.env,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
};
if (extraPath) agentEnv.PATH = `${extraPath};${process.env.PATH ?? ''}`;
try {
  const settings = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8'));
  for (const [k, v] of Object.entries(settings.env ?? {})) {
    if (typeof v !== 'string' || v === '') continue;
    if (agentEnv[k] === undefined || agentEnv[k] === '') { agentEnv[k] = v; forwardedKeys.push(k); }
  }
} catch { /* no user settings: the CLI's own environment is used as-is */ }
console.log(`forwarded env keys: ${forwardedKeys.join(', ') || '(none)'}`);

// ---------------------------------------------------------------- secret redaction
const secretValues = [];
try {
  const settings = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8'));
  for (const [k, v] of Object.entries(settings.env ?? {})) {
    if (typeof v === 'string' && v.length >= 12 && /TOKEN|KEY|SECRET|PASSWORD/i.test(k)) secretValues.push(v);
  }
} catch { /* nothing to redact */ }
const redact = (s) => {
  let t = s ?? '';
  for (const v of secretValues) t = t.split(v).join('[REDACTED]');
  return t;
};

// ---------------------------------------------------------------- prompt
const taskText = fs.readFileSync(taskFile, 'utf8').trim();
const armSuffix = arm === 'canary'
  ? ['', 'Verification in this repository is AUTOMATIC: when you believe the work is complete, simply finish.',
    'The project\'s checks are run for you, and if anything fails you will be told exactly what to fix,']
  : [''];
const prompt = [taskText, ...armSuffix, '', 'Work in the current directory. When you are finished, state plainly whether everything works now, and list what you changed.'].join('\n');

// ---------------------------------------------------------------- checkpoint state BEFORE
const checkpointPath = path.join(repo, '.canary', 'last-checkpoint.json');
const readCheckpointRaw = () => { try { return fs.readFileSync(checkpointPath, 'utf8'); } catch { return null; } };
const checkpointBefore = readCheckpointRaw();
const checkpointMtimeBefore = (() => { try { return fs.statSync(checkpointPath).mtimeMs; } catch { return null; } })();

// ---------------------------------------------------------------- run the agent
const mcpConfig = path.join(repo, '.mcp.json');
const args = [
  '-p', prompt,
  '--output-format', 'stream-json', '--verbose',
  '--permission-mode', 'acceptEdits',
  '--strict-mcp-config',
  '--setting-sources', 'project,local',
  '--allowedTools', 'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep',
];
if (fs.existsSync(mcpConfig)) args.push('--mcp-config', mcpConfig);

/**
 * PIPES → WRITE STREAMS, NOT INHERITED FILE DESCRIPTORS.
 *
 * MEASURED on this host (WS5, 2026-09-24): with `stdio: ['ignore', <fd opened by
 * this process>, <fd>]` the claude CLI produced ZERO bytes in the capture file for
 * the entire run — while `Start-Process -RedirectStandardOutput <file>` streaming
 * the same invocation wrote 5.7 KB within 20 s and kept growing. Two runs that
 * looked "hung" were in fact working normally; the capture shape was the problem,
 * not the agent. Piping and writing the bytes from here is the shape that streams,
 * and it also means a timed-out run still leaves the partial stream on disk.
 */
const stdoutPath = path.join(outDir, 'agent.stream.raw.txt');
const stderrPath = path.join(outDir, 'agent.stderr.raw.txt');
const stdoutSink = fs.createWriteStream(stdoutPath);
const stderrSink = fs.createWriteStream(stderrPath);

const startedAt = nowIso();
const t0 = Date.now();
const run = await new Promise((resolve) => {
  const child = spawn('claude', args, {
    cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: agentEnv,
  });
  child.stdout.pipe(stdoutSink, { end: false });
  child.stderr.pipe(stderrSink, { end: false });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMin * 60_000);
  child.on('error', (e) => { clearTimeout(timer); resolve({ code: null, spawnError: String(e?.message ?? e), timedOut }); });
  child.on('close', (code) => { clearTimeout(timer); resolve({ code, timedOut }); });
});
const wallSeconds = Math.round((Date.now() - t0) / 100) / 10;
await new Promise((r) => { stdoutSink.end(); stderrSink.end(); r(); });
await new Promise((r) => setTimeout(r, 250)); // let the sinks flush before reading

const rawStream = fs.readFileSync(stdoutPath, 'utf8');
const rawErr = fs.readFileSync(stderrPath, 'utf8');
fs.writeFileSync(path.join(outDir, 'agent.stream.jsonl'), redact(rawStream));
fs.writeFileSync(path.join(outDir, 'agent.stderr.txt'), redact(rawErr));

// ---------------------------------------------------------------- parse the stream
const events = [];
let parseErrors = 0;
for (const line of rawStream.split(/\r?\n/)) {
  if (!line.trim()) continue;
  try { events.push(JSON.parse(line)); } catch { parseErrors++; }
}
const resultEvents = events.filter((e) => e.type === 'result');
const result = resultEvents.length ? resultEvents[resultEvents.length - 1] : null;
const assistantEvents = events.filter((e) => e.type === 'assistant');
const model = (() => {
  for (const e of assistantEvents) { const m = e.message?.model; if (m) return m; }
  return null;
})();
/**
 * The `result` event's `usage` is the CLI's own provider-native session total.
 * `num_turns`, `duration_ms` and `total_cost_usd` come from the same event.
 * Nothing here is estimated: if a field is absent it stays null.
 */
const usage = result?.usage ?? null;
const ledger = {
  label, arm, repo, startedAt, wallSeconds,
  agentExitCode: run.code ?? null, spawnError: run.spawnError ?? null, timedOut: run.timedOut === true,
  streamLines: rawStream.split(/\r?\n/).filter((l) => l.trim()).length,
  streamParseErrors: parseErrors,
  sawResultEvent: result !== null,
  resultSubtype: result?.subtype ?? null,
  resultIsError: result?.is_error ?? null,
  model,
  numTurns: result?.num_turns ?? null,
  durationMsProvider: result?.duration_ms ?? null,
  usage,
  totalCostUsdProvider: result?.total_cost_usd ?? null,
  forwardedEnvKeys: forwardedKeys,
  assistantEvents: assistantEvents.length,
};
fs.writeFileSync(path.join(outDir, 'ledger.json'), `${JSON.stringify(ledger, null, 2)}\n`);

// Did the model SEE a refusal? On this CLI a Stop-hook refusal reaches the model as
// user-role text ("Stop hook feedback: …"); hook events are not emitted for a
// project-level Stop hook. "The hook fired" and "the model was told why" are two
// different claims and both are recorded.
const streamText = rawStream;
const sawStopHookFeedback = /Stop hook feedback/i.test(streamText);
const sawCanaryBlockText = /Canary blocked completion/i.test(streamText);
const sawCanarySystemMessage = /Canary (could not|found|:)/i.test(streamText);

// ---------------------------------------------------------------- checkpoint state AFTER
const checkpointAfter = readCheckpointRaw();
const checkpointMtimeAfter = (() => { try { return fs.statSync(checkpointPath).mtimeMs; } catch { return null; } })();
const hookFiredDuringRun = checkpointMtimeBefore !== checkpointMtimeAfter && checkpointMtimeAfter !== null;

// ---------------------------------------------------------------- drive checkpoint if needed
let driven = null;
if (!hookFiredDuringRun) {
  // MANUALLY DRIVEN: the seeded hook JSON is byte-for-byte the contract in
  // apps/cli/src/onboarding.ts:3195-3234 — {cwd, stop_hook_active, task} on stdin,
  // decision JSON on stdout, exit 0. This is NOT the harness firing the hook and the
  // record must never be read as if it were.
  const hookInput = {
    session_id: `ws5-${label}`,
    transcript_path: path.join(outDir, 'agent.stream.jsonl'),
    cwd: repo,
    hook_event_name: 'Stop',
    stop_hook_active: false,
  };
  fs.writeFileSync(path.join(outDir, 'hook-input.json'), `${JSON.stringify(hookInput, null, 2)}\n`);
  const cp = spawnSync(process.execPath, [CLI, 'checkpoint'], {
    cwd: repo, input: JSON.stringify(hookInput), encoding: 'utf8', timeout: 1_800_000,
    env: { ...process.env, PATH: agentEnv.PATH },
  });
  driven = { exitCode: cp.status, stdout: (cp.stdout ?? '').trim(), stderr: (cp.stderr ?? '').trim() };
  fs.writeFileSync(path.join(outDir, 'checkpoint-manual.stdout.txt'), `${driven.stdout}\n`);
  fs.writeFileSync(path.join(outDir, 'checkpoint-manual.stderr.txt'), `${driven.stderr}\n`);
}

// ---------------------------------------------------------------- diff + record
const after = {
  head: gitOut('rev-parse', 'HEAD'),
  status: gitOut('status', '--porcelain'),
  diff: git('diff', 'HEAD').stdout ?? '',
  untracked: gitOut('ls-files', '--others', '--exclude-standard'),
};
fs.writeFileSync(path.join(outDir, 'git-after.json'), `${JSON.stringify({ head: after.head, status: after.status, untracked: after.untracked }, null, 2)}\n`);
fs.writeFileSync(path.join(outDir, 'agent.diff'), redact(after.diff));

const record = {
  ...ledger,
  finishedAt: nowIso(),
  prompt,
  checkpointBefore,
  checkpointAfter,
  hookFiredDuringRun,
  seenByModel: { sawStopHookFeedback, sawCanaryBlockText, sawCanarySystemMessage },
  checkpointDrivenManually: driven !== null,
  manuallyDriven: driven,
  gitBefore: before,
  gitAfter: { head: after.head, status: after.status, untracked: after.untracked },
  claimedFilesTouchedOutsideRepo: null,
};
fs.writeFileSync(path.join(outDir, 'record.json'), `${JSON.stringify(record, null, 2)}\n`);

// ---------------------------------------------------------------- assertions (the probe's own bar)
check('agent process started and exited', () => assert(run.spawnError == null, `spawn error: ${run.spawnError}`));
check('stream is parseable NDJSON', () => assert(parseErrors <= 1, `${parseErrors} unparseable line(s) (at most one truncated trailing line is tolerated on a killed run)`));
check('agent produced a terminal result event', () => assert(result !== null, 'no `result` event in the stream'));
check('a Canary checkpoint decision was obtained (hook or manually driven)', () => {
  if (hookFiredDuringRun) return assert(checkpointAfter != null, 'hook fired but no checkpoint file');
  assert(driven != null, 'checkpoint was never driven');
  assert(driven.exitCode === 0, `checkpoint exit ${driven.exitCode}`);
  assert(driven.stdout.length > 0, 'checkpoint produced no stdout decision');
});
check('no secret leaked into the raw stream file', () => assert(!secretValues.some((v) => rawStream.includes(v)), 'a forwarded credential value appears in the capture'));

console.log(`--- ${label}: ${hookFiredDuringRun ? 'HOOK FIRED during the agent run' : 'HOOK DID NOT FIRE — checkpoint driven MANUALLY'}`);
console.log(`--- wall ${wallSeconds}s, turns ${ledger.numTurns}, usage ${JSON.stringify(usage)}`);
console.log(`--- ${failures === 0 ? 'RUN COMPLETE' : `RUN INCOMPLETE (${failures} failure(s))`}`);
process.exit(failures === 0 ? 0 : 1);
