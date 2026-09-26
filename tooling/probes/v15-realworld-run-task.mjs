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
 * ONE ATTEMPT = ONE IMMUTABLE DIRECTORY (v1.5, audit finding R1)
 * -------------------------------------------------------------
 * MEASURED (2026-09-24, the real-world bundle): this probe used to write every artifact
 * into `--out` directly, so a second attempt at the same task silently TRUNCATED the
 * first attempt's raw stream, ledger, record, diff and git state (plain
 * `fs.writeFileSync`), while the files the second attempt did not produce — the first
 * attempt's `hook-input.json` and `checkpoint-manual.*` — stayed behind. The result was
 * ONE directory holding TWO attempts' bytes, and the second attempt even READ the first
 * attempt's leftover checkpoint as its own `checkpointBefore`. Attempt identity is now a
 * directory:
 *
 *     <run root>            = --out        (the TASK: one task, many attempts)
 *       attempt-1/          = <attempt id> (ONE attempt: start metadata, raw stream,
 *       attempt-2/                          parsed record, checkpoint events, manual
 *                                           checkpoint if any, final result, timestamps,
 *                                           starting repo identity, SHA256SUMS)
 *
 * The rules, and they are enforced rather than documented:
 *  - the attempt directory is opened with a non-recursive `mkdir`, so two probes racing
 *    for the same id cannot share one;
 *  - EVERY artifact is written with `flag: 'wx'` (create-or-fail): an existing byte is
 *    never overwritten and an existing file is never opened for writing;
 *  - if the requested attempt directory already holds anything — or if the run root
 *    holds un-attributed (pre-layout, "flat") evidence — the probe REFUSES (exit 1) and
 *    writes nothing. It never merges, and it never picks a number that could be confused
 *    with un-attributed evidence.
 *  - `--new-attempt` opens a fresh attempt directory instead of refusing; inside a run
 *    root that already holds flat evidence it must be paired with `--attempt <id>`, so
 *    the operator names the new attempt rather than the tool guessing.
 *
 * USAGE
 *   node tooling/probes/v15-realworld-run-task.mjs \
 *     --repo <abs path> --task-file <file> --label <id> --out <run root for that task> \
 *     [--attempt <id>] [--new-attempt] [--arm canary|plain] [--timeout-min 20]
 *     [--extra-path <dir>[;<dir>...]] [--agent-cmd <exe>] [--agent-arg <arg> ...]
 *
 * `--agent-cmd`/`--agent-arg` exist so the provenance layer is testable end to end with a
 * STUB harness (tooling/probes/v15-attempt-provenance.mjs does exactly that). A run whose
 * agent command is not `claude` prints a WARNING and records the exact command it spawned,
 * so a stub run can never be mistaken for real-world evidence.
 *
 * EXIT CODE: 0 only when the run produced a parseable result event AND a checkpoint
 * decision (or an honest allow) — i.e. the measurement completed. Infrastructure
 * failures and provenance refusals print FAIL and exit 1; usage errors exit 2.
 */
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const CLI = path.join(REPO_ROOT, 'apps', 'cli', 'dist', 'src', 'main.js');
const PROBE = 'tooling/probes/v15-realworld-run-task.mjs';
const LAYOUT_VERSION = 1;

// ---------------------------------------------------------------- args
function arg(name, dflt = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? dflt : process.argv[i + 1];
}
function argAll(name) {
  const out = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === `--${name}` && i + 1 < process.argv.length) out.push(process.argv[i + 1]);
  }
  return out;
}
const repo = arg('repo');
const taskFile = arg('task-file');
const label = arg('label');
const outDir = arg('out');
const attemptArg = arg('attempt');
const newAttempt = process.argv.includes('--new-attempt');
const arm = arg('arm', 'canary');
const timeoutMin = Number(arg('timeout-min', '20'));
const extraPath = arg('extra-path', '');
const agentCmd = arg('agent-cmd', 'claude');
const agentExtraArgs = argAll('agent-arg');
if (!repo || !taskFile || !label || !outDir) {
  console.error('usage: --repo <dir> --task-file <file> --label <id> --out <run root> [--attempt <id>] [--new-attempt] [--arm canary|plain] [--timeout-min N] [--extra-path <dirs>] [--agent-cmd <exe>] [--agent-arg <arg> ...]');
  process.exit(2);
}

const nowIso = () => new Date().toISOString();
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// A refusal is a first-class outcome: it prints FAIL, names the next action, and writes
// NOTHING (no artifact, no directory, no partial attempt).
function refuse(reasons) {
  for (const r of reasons) console.log(`FAIL attempt identity: ${r}`);
  console.log('REFUSED: nothing was written. An attempt directory is immutable; a second run must get its own.');
  process.exit(1);
}

// ---------------------------------------------------------------- attempt identity
const ATTEMPT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Artifact names the PRE-LAYOUT probe wrote flat into `--out` (and into the R1 bundle). */
const FLAT_EVIDENCE = [
  'record.json', 'ledger.json', 'agent.stream.raw.txt', 'agent.stream.jsonl',
  'agent.stderr.raw.txt', 'agent.stderr.txt', 'git-before.json', 'git-after.json',
  'agent.diff', 'hook-input.json', 'checkpoint-manual.stdout.txt', 'checkpoint-manual.stderr.txt',
];
const runRoot = path.resolve(outDir);
const flatEvidence = FLAT_EVIDENCE.filter((n) => fs.existsSync(path.join(runRoot, n)));

if (attemptArg !== null && !ATTEMPT_ID_RE.test(attemptArg)) {
  refuse([`--attempt ${JSON.stringify(attemptArg)} is not a usable attempt id (letters, digits, dot, dash, underscore; max 64 chars; must not start with a dot)`]);
}
fs.mkdirSync(runRoot, { recursive: true });

let attemptId;
let attemptDir;
if (newAttempt && attemptArg === null) {
  if (flatEvidence.length) {
    refuse([
      `run root ${runRoot} already holds un-attributed (pre-layout) evidence: ${flatEvidence.join(', ')}`,
      'those files belong to an attempt this layout cannot name, so the probe will not guess an attempt number for them',
      'name the new attempt explicitly: --new-attempt --attempt <id> (the existing files are never read and never touched)',
    ]);
  }
  for (let n = 1; n <= 999 && attemptDir === undefined; n++) {
    const id = `attempt-${n}`;
    const dir = path.join(runRoot, id);
    try { fs.mkdirSync(dir); attemptId = id; attemptDir = dir; }
    catch (e) { if (e?.code !== 'EEXIST') throw e; } // occupied: the next number
  }
  if (attemptDir === undefined) refuse([`no free attempt id under ${runRoot} (attempt-1 … attempt-999 are all taken)`]);
  console.log(`ATTEMPT: ${attemptId} (new) -> ${attemptDir}`);
} else {
  attemptId = attemptArg ?? 'attempt-1';
  attemptDir = path.join(runRoot, attemptId);
  const existing = fs.existsSync(attemptDir) ? fs.readdirSync(attemptDir) : null;
  if (existing !== null && existing.length > 0) {
    refuse([
      `${attemptDir} already contains run evidence (${existing.length} entr${existing.length === 1 ? 'y' : 'ies'}: ${existing.slice(0, 6).join(', ')}${existing.length > 6 ? ', …' : ''})`,
      're-running into it would OVERWRITE that attempt\'s stream/ledger/record and leave its leftovers behind — that is exactly how two attempts were merged in the R1 evidence bundle',
      'pass --new-attempt to open a fresh attempt directory (or --new-attempt --attempt <id> to name it)',
    ]);
  }
  if (flatEvidence.length && !newAttempt) {
    refuse([
      `run root ${runRoot} holds un-attributed (pre-layout) evidence: ${flatEvidence.join(', ')}`,
      'a new attempt directory written beside it would be indistinguishable from those files, and the probe never mixes layout generations in one run root',
      'pass --new-attempt --attempt <id> to state explicitly that the new attempt is separate (the existing files are never read and never touched), or use a fresh --out',
    ]);
  }
  if (flatEvidence.length && newAttempt) {
    console.log(`NOTE: run root ${runRoot} holds un-attributed evidence (${flatEvidence.join(', ')}) — left untouched by this attempt.`);
  }
  if (existing !== null) {
    console.log(`ATTEMPT: ${attemptId} (existing empty directory, reused) -> ${attemptDir}`);
  } else {
    try { fs.mkdirSync(attemptDir); }
    catch (e) {
      if (e?.code === 'EEXIST') refuse([`${attemptDir} appeared while this run was starting; refusing to share an attempt directory`]);
      throw e;
    }
    console.log(`ATTEMPT: ${attemptId} (new) -> ${attemptDir}`);
  }
}
if (agentCmd !== 'claude') {
  console.log(`WARNING: --agent-cmd ${JSON.stringify(agentCmd)} is not the real harness — this run is NOT real-world evidence.`);
}

// Every write is create-or-fail (`wx`): an existing byte anywhere in the attempt
// directory is a refusal, not a truncation.
const writtenArtifacts = [];
const writtenPaths = [];
function writeArtifact(name, bytes) {
  const p = path.join(attemptDir, name);
  try {
    fs.writeFileSync(p, bytes, { flag: 'wx' });
  } catch (e) {
    if (e?.code === 'EEXIST') refuse([`${p} already exists; refusing to overwrite an existing artifact`]);
    throw e;
  }
  writtenArtifacts.push(name);
  writtenPaths.push(p);
  return p;
}
function streamArtifact(name) {
  const p = path.join(attemptDir, name);
  writtenArtifacts.push(name);
  writtenPaths.push(p);
  return fs.createWriteStream(p, { flags: 'wx' });
}

let failures = 0;
const checkResults = [];
const check = (name, fn) => {
  try { fn(); console.log(`PASS ${name}`); checkResults.push({ name, ok: true, detail: null }); }
  catch (e) {
    failures++;
    const detail = String(e?.message ?? e).split('\n').join('\n     ');
    console.log(`FAIL ${name}\n     ${detail}`);
    checkResults.push({ name, ok: false, detail: String(e?.message ?? e) });
  }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

const agentCommand = [agentCmd, ...agentExtraArgs].join(' ');

// ---------------------------------------------------------------- git facts
const git = (...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 120_000 });
const gitOut = (...args) => (git(...args).stdout ?? '').trim();
const before = {
  head: gitOut('rev-parse', 'HEAD'),
  tree: gitOut('rev-parse', 'HEAD^{tree}'),
  status: gitOut('status', '--porcelain'),
  tracked: gitOut('ls-files').split('\n').filter(Boolean).length,
};

// ---------------------------------------------------------------- start metadata (first)
/**
 * Written BEFORE anything is measured, so a reader can tell from the attempt directory
 * alone which attempt it is looking at, which repository it started from, and which
 * command produced it — even if the probe dies mid-run.
 */
const startedAt = nowIso();
writeArtifact('attempt.json', `${JSON.stringify({
  layout: LAYOUT_VERSION,
  probe: PROBE,
  attemptId,
  requestedAttemptId: attemptArg,
  openedWithNewAttempt: newAttempt,
  runRoot,
  attemptDir,
  taskId: label,
  arm,
  repo,
  agentCommand,
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  startedAt,
  startingRepoIdentity: before,
}, null, 2)}\n`);
writeArtifact('git-before.json', `${JSON.stringify(before, null, 2)}\n`);

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
  ...agentExtraArgs,
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
 *
 * `{ flags: 'wx' }` on the sinks is the provenance rule, not a style choice: the raw
 * stream of an attempt may never be reopened for writing.
 */
const stdoutPath = path.join(attemptDir, 'agent.stream.raw.txt');
const stderrPath = path.join(attemptDir, 'agent.stderr.raw.txt');
const stdoutSink = streamArtifact('agent.stream.raw.txt');
const stderrSink = streamArtifact('agent.stderr.raw.txt');

const t0 = Date.now();
const run = await new Promise((resolve) => {
  const child = spawn(agentCmd, args, {
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
writeArtifact('agent.stream.jsonl', redact(rawStream));
writeArtifact('agent.stderr.txt', redact(rawErr));

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
  layout: LAYOUT_VERSION, attemptId, runRoot, attemptDir,
  label, arm, repo, agentCommand, startedAt, wallSeconds,
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
writeArtifact('ledger.json', `${JSON.stringify(ledger, null, 2)}\n`);

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
    transcript_path: path.join(attemptDir, 'agent.stream.jsonl'),
    cwd: repo,
    hook_event_name: 'Stop',
    stop_hook_active: false,
  };
  writeArtifact('hook-input.json', `${JSON.stringify(hookInput, null, 2)}\n`);
  const cp = spawnSync(process.execPath, [CLI, 'checkpoint'], {
    cwd: repo, input: JSON.stringify(hookInput), encoding: 'utf8', timeout: 1_800_000,
    env: { ...process.env, PATH: agentEnv.PATH },
  });
  driven = { exitCode: cp.status, stdout: (cp.stdout ?? '').trim(), stderr: (cp.stderr ?? '').trim() };
  writeArtifact('checkpoint-manual.stdout.txt', `${driven.stdout}\n`);
  writeArtifact('checkpoint-manual.stderr.txt', `${driven.stderr}\n`);
}

/**
 * The checkpoint EVENTS of THIS attempt, with the timestamps that decide provenance:
 * `checkpointBefore` is this attempt's starting state, and it is read from the measured
 * repository — never from another attempt's directory (the R1 mixing bug made attempt 2
 * inherit attempt 1's manually driven checkpoint as its "before" state).
 */
writeArtifact('checkpoint-events.json', `${JSON.stringify({
  layout: LAYOUT_VERSION,
  attemptId,
  checkpointPath,
  startedAt,
  before: { raw: checkpointBefore, mtimeMs: checkpointMtimeBefore },
  after: { raw: checkpointAfter, mtimeMs: checkpointMtimeAfter },
  hookFiredDuringRun,
  checkpointDrivenManually: driven !== null,
  manual: driven,
}, null, 2)}\n`);

// ---------------------------------------------------------------- diff + record
const after = {
  head: gitOut('rev-parse', 'HEAD'),
  status: gitOut('status', '--porcelain'),
  diff: git('diff', 'HEAD').stdout ?? '',
  untracked: gitOut('ls-files', '--others', '--exclude-standard'),
};
writeArtifact('git-after.json', `${JSON.stringify({ head: after.head, status: after.status, untracked: after.untracked }, null, 2)}\n`);
writeArtifact('agent.diff', redact(after.diff));

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
writeArtifact('record.json', `${JSON.stringify(record, null, 2)}\n`);

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
check('every artifact of this attempt was written INSIDE its own attempt directory', () => {
  const outside = writtenPaths.filter((p) => path.dirname(path.resolve(p)) !== path.resolve(attemptDir));
  assert(outside.length === 0, `wrote outside the attempt directory: ${outside.join(', ')}`);
  assert(writtenPaths.length === writtenArtifacts.length, `${writtenPaths.length} paths for ${writtenArtifacts.length} artifacts`);
});

// ---------------------------------------------------------------- final result + identity
const probeExitCode = failures === 0 ? 0 : 1;
writeArtifact('attempt-result.json', `${JSON.stringify({
  layout: LAYOUT_VERSION,
  attemptId,
  runRoot,
  attemptDir,
  taskId: label,
  arm,
  agentCommand,
  startedAt,
  finishedAt: nowIso(),
  status: failures === 0 ? 'complete' : 'incomplete',
  failures,
  probeExitCode,
  checks: checkResults,
  artifacts: [...writtenArtifacts].sort(),
}, null, 2)}\n`);

/**
 * The attempt's own hash manifest. It is what makes "the identity of each attempt is
 * separately recoverable" checkable later: two attempts that were merged (the R1 defect)
 * cannot produce two consistent manifests, and any later edit to one attempt's bytes
 * shows up here.
 */
const sums = fs.readdirSync(attemptDir).filter((n) => n !== 'SHA256SUMS').sort()
  .map((n) => `${sha256(fs.readFileSync(path.join(attemptDir, n)))}  ${n}`);
fs.writeFileSync(path.join(attemptDir, 'SHA256SUMS'), `${sums.join('\n')}\n`, { flag: 'wx' });

console.log(`--- ${label}/${attemptId}: ${hookFiredDuringRun ? 'HOOK FIRED during the agent run' : 'HOOK DID NOT FIRE — checkpoint driven MANUALLY'}`);
console.log(`--- wall ${wallSeconds}s, turns ${ledger.numTurns}, usage ${JSON.stringify(usage)}`);
console.log(`--- attempt directory: ${attemptDir}`);
if (agentCmd !== 'claude') console.log('--- STUB AGENT: this attempt is a provenance/harness measurement, NOT real-world evidence.');
console.log(`--- ${failures === 0 ? 'RUN COMPLETE' : `RUN INCOMPLETE (${failures} failure(s))`}`);
process.exit(probeExitCode);
