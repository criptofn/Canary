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
 *     --cli <installed main.js> --artifact-sha256 <published tgz SHA-256> \
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
import { parseCodexJsonl } from './v15-codex-jsonl.mjs';
import { canaryEvidenceStatus, hasOllamaNativeUsageEvidence } from './v15-ollama-native-agent.mjs';

const PROBE = 'tooling/probes/v15-realworld-run-task.mjs';
const LAYOUT_VERSION = 1;
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

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
const cliArg = arg('cli');
const artifactSha256 = arg('artifact-sha256');
const newAttempt = process.argv.includes('--new-attempt');
const arm = arg('arm', 'canary');
const timeoutMin = Number(arg('timeout-min', '20'));
const maxBudgetArg = arg('max-budget-usd');
const pilotBudgetUsd = maxBudgetArg === null ? null : Number(maxBudgetArg);
const extraPath = arg('extra-path', '');
const agentCmd = arg('agent-cmd', 'claude');
const agentExtraArgs = argAll('agent-arg');
const agentProtocol = arg('agent-protocol', 'claude');
const agentModel = arg('model');
const agentEntryArg = arg('agent-entry');
const agentEntry = agentEntryArg ? path.resolve(agentEntryArg) : null;
if (!repo || !taskFile || !label || !outDir) {
  console.error('usage: --repo <dir> --task-file <file> --label <id> --out <run root> --cli <installed main.js> --artifact-sha256 <package tgz SHA-256> [--attempt <id>] [--new-attempt] [--arm canary|plain] [--agent-protocol claude|codex-local|ollama-native] [--model <model>] [--agent-entry <local runner>] [--timeout-min N] [--extra-path <dirs>] [--agent-cmd <exe>] [--agent-arg <arg> ...]');
  process.exit(2);
}
if (!Number.isFinite(timeoutMin) || timeoutMin <= 0 || timeoutMin > 30) {
  console.error('usage error: --timeout-min must be greater than zero and no greater than 30');
  process.exit(2);
}
if (agentProtocol === 'claude' && maxBudgetArg !== null && (!Number.isFinite(pilotBudgetUsd) || pilotBudgetUsd <= 0 || pilotBudgetUsd > 2.5)) {
  console.error('usage error: --max-budget-usd must be a finite positive number no greater than 2.50');
  process.exit(2);
}
if (!['claude', 'codex-local', 'ollama-native'].includes(agentProtocol)) {
  console.error('usage error: --agent-protocol must be claude, codex-local, or ollama-native');
  process.exit(2);
}
if (agentProtocol === 'codex-local' && (!agentModel || agentExtraArgs.length < 1 || maxBudgetArg !== null)) {
  console.error('usage error: Codex local requires --model and a Codex JS entry in --agent-arg; USD caps do not apply');
  process.exit(2);
}
if (agentProtocol === 'codex-local' && agentExtraArgs.includes('--max-budget-usd')) {
  console.error('usage error: Codex local does not accept Claude USD budget arguments');
  process.exit(2);
}
if (agentProtocol === 'ollama-native' && (!agentModel || !agentEntry || !fs.statSync(agentEntry, { throwIfNoEntry: false })?.isFile() || maxBudgetArg !== null)) {
  console.error('usage error: Ollama native requires --model and --agent-entry; USD caps do not apply');
  process.exit(2);
}
if (pilotBudgetUsd !== null && agentExtraArgs.includes('--max-budget-usd')) {
  console.error('usage error: use --max-budget-usd for the enforced per-session cap; do not pass it again with --agent-arg');
  process.exit(2);
}
if (!cliArg || !artifactSha256 || !/^[0-9a-f]{64}$/i.test(artifactSha256)) {
  console.error('usage error: --cli and a 64-hex --artifact-sha256 are required; the development build is never selected implicitly');
  process.exit(2);
}
const CLI = path.resolve(cliArg);
if (!fs.statSync(CLI, { throwIfNoEntry: false })?.isFile()) {
  console.error(`usage error: --cli is not a file: ${CLI}`);
  process.exit(2);
}
const cliSha256 = sha256(fs.readFileSync(CLI));
const versionRun = spawnSync(process.execPath, [CLI, '--version'], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
if (versionRun.status !== 0 || !/^canary 1\.5\.0\s*$/m.test(versionRun.stdout ?? '')) {
  console.error(`usage error: --cli must report canary 1.5.0 (exit ${String(versionRun.status)}): ${(versionRun.stdout ?? '').trim()}`);
  process.exit(2);
}
const cliVersion = (versionRun.stdout ?? '').trim();

const nowIso = () => new Date().toISOString();
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

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
const knownAgent = agentProtocol === 'codex-local'
  ? path.basename(agentExtraArgs[0] ?? '').toLowerCase() === 'codex.js'
  : agentProtocol === 'ollama-native'
    ? path.basename(agentEntry ?? '').toLowerCase() === 'v15-ollama-native-agent.mjs'
    : path.parse(agentCmd).name.toLowerCase() === 'claude';
if (!knownAgent) console.log(`WARNING: --agent-cmd ${JSON.stringify(agentCmd)} is not the real harness — this run is NOT real-world evidence.`);

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
  maxBudgetUsd: pilotBudgetUsd,
  repo,
  agentCommand,
  agentExtraArgs,
  agentEntry,
  agentEntrySha256: agentEntry ? sha256(fs.readFileSync(agentEntry)) : null,
  agentProtocol,
  agentModel,
  cliPath: CLI,
  cliVersion,
  cliSha256,
  artifactSha256: artifactSha256.toLowerCase(),
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
const agentEnv = { ...process.env };
if (agentProtocol === 'claude') agentEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
if (agentProtocol === 'codex-local' || agentProtocol === 'ollama-native') {
  for (const key of Object.keys(agentEnv)) {
    if (/(API[_-]?KEY|(?:^|_)TOKEN(?:_|$)|SECRET|PASSWORD|BEARER)/i.test(key)) delete agentEnv[key];
  }
  Object.assign(agentEnv, {
    CODEX_OSS_BASE_URL: 'http://127.0.0.1:11434/v1',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    ALL_PROXY: '',
    OLLAMA_API_URL: 'http://127.0.0.1:11434/api/chat',
  });
}
if (extraPath) agentEnv.PATH = `${extraPath};${process.env.PATH ?? ''}`;
if (agentProtocol === 'claude') {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8'));
    for (const [k, v] of Object.entries(settings.env ?? {})) {
      if (typeof v !== 'string' || v === '') continue;
      if (agentEnv[k] === undefined || agentEnv[k] === '') { agentEnv[k] = v; forwardedKeys.push(k); }
    }
  } catch { /* no user settings: use the CLI's own environment */ }
}
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
const promptPath = path.join(attemptDir, 'agent-prompt.txt');
if (agentProtocol === 'ollama-native') writeArtifact('agent-prompt.txt', `${prompt}\n`);

// ---------------------------------------------------------------- checkpoint state BEFORE
const checkpointPath = path.join(repo, '.canary', 'last-checkpoint.json');
const readCheckpointRaw = () => { try { return fs.readFileSync(checkpointPath, 'utf8'); } catch { return null; } };
const checkpointBefore = readCheckpointRaw();
const checkpointMtimeBefore = (() => { try { return fs.statSync(checkpointPath).mtimeMs; } catch { return null; } })();
async function readOllamaRuntime() {
  try {
    const response = await fetch('http://127.0.0.1:11434/api/ps', { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return { observedAt: nowIso(), error: 'HTTP ' + response.status, match: null };
    const body = await response.json();
    const match = (body.models ?? []).find((m) => m.name === agentModel || m.model === agentModel);
    return { observedAt: nowIso(), match: match ? { name: match.name ?? match.model, digest: match.digest ?? null, size: match.size ?? null, contextLength: match.context_length ?? null, parameterSize: match.details?.parameter_size ?? null, quantizationLevel: match.details?.quantization_level ?? null } : null };
  } catch (e) { return { observedAt: nowIso(), error: String(e?.message ?? e), match: null }; }
}
const usesOllama = agentProtocol === 'codex-local' || agentProtocol === 'ollama-native';
const localModelRuntimeBefore = usesOllama ? await readOllamaRuntime() : null;


// ---------------------------------------------------------------- run the agent
const mcpConfig = path.join(repo, '.mcp.json');
const args = agentProtocol === 'codex-local'
  ? [
      ...agentExtraArgs, '--ask-for-approval', 'never', '--disable', 'plugins',
      '--config', 'mcp_servers.brave-search.enabled=false', '--config', 'mcp_servers.filesystem.enabled=false',
      '--config', 'mcp_servers.github.enabled=false', '--config', 'mcp_servers.repowise.enabled=false',
      '--config', 'mcp_servers.node_repl.enabled=false', '--config', 'mcp_servers.serena.enabled=false',
      '--config', 'mcp_servers.context7.enabled=false', 'exec', '--oss', '--local-provider', 'ollama', '--model', agentModel,
      '--json', '--ephemeral', '--sandbox', 'workspace-write',
      '--config', 'model_reasoning_effort="low"', '--cd', repo, prompt,
    ]
  : agentProtocol === 'ollama-native'
    ? [
        agentEntry,
        '--model', agentModel,
        '--workspace', repo,
        '--prompt-file', promptPath,
        '--arm', arm,
        '--max-requests', '24',
        ...agentExtraArgs,
        ...(agentExtraArgs.includes('--checks-file') ? ['--tool-output-dir', attemptDir] : []),
        ...(arm === 'canary' ? [
          '--canary-cli', CLI,
          '--session-id', `ws5-${label}-${attemptId}`,
          '--transcript-path', path.join(attemptDir, 'agent.session.jsonl'),
        ] : []),
      ]
    : [
      ...agentExtraArgs,
      ...(pilotBudgetUsd === null ? [] : ['--max-budget-usd', String(pilotBudgetUsd)]),
      '-p', prompt,
      '--output-format', 'stream-json', '--verbose',
      '--permission-mode', 'acceptEdits',
      '--strict-mcp-config',
      '--setting-sources', 'project,local',
      '--allowedTools', 'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep',
    ];
if (agentProtocol === 'claude' && fs.existsSync(mcpConfig)) args.push('--mcp-config', mcpConfig);
if (agentProtocol === 'ollama-native' && arm === 'canary') writeArtifact('agent.session.jsonl', '');

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
const localModelRuntimeAfter = usesOllama ? await readOllamaRuntime() : null;

const rawStream = fs.readFileSync(stdoutPath, 'utf8');
const rawErr = fs.readFileSync(stderrPath, 'utf8');
writeArtifact('agent.stream.jsonl', redact(rawStream));
writeArtifact('agent.stderr.txt', redact(rawErr));

// ---------------------------------------------------------------- parse the stream
let parsedCodex = null;
const events = [];
let parseErrors = 0;
if (agentProtocol === 'codex-local') {
  parsedCodex = parseCodexJsonl(rawStream, agentModel);
  events.push(...parsedCodex.events);
  parseErrors = parsedCodex.parseErrors;
} else {
  for (const line of rawStream.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { parseErrors++; }
  }
}
const resultEvents = events.filter((e) => e.type === 'result');
const result = parsedCodex?.result ?? (resultEvents.length ? resultEvents[resultEvents.length - 1] : null);
const assistantEvents = parsedCodex
  ? parsedCodex.agentMessages.map((text) => ({ message: { model: agentModel, text } }))
  : events.filter((e) => e.type === 'assistant');
const model = parsedCodex ? (localModelRuntimeAfter?.match?.name ?? null) : (() => {
  for (const e of assistantEvents) { const m = e.message?.model; if (m) return m; }
  return null;
})();
const agentWarnings = parsedCodex?.warnings ?? [];
const streamText = rawStream;
const sawStopHookFeedback = /Stop hook feedback/i.test(streamText);
const sawCanaryBlockText = /Canary blocked completion/i.test(streamText);
const sawCanarySystemMessage = /Canary (could not|found|:)/i.test(streamText);
const sawStopGuardMessage = /after one repair attempt|stopping anyway/i.test(streamText);
/**
 * The `result` event's `usage` is the CLI's own provider-native session total.
 * `num_turns`, `duration_ms` and `total_cost_usd` come from the same event.
 * Nothing here is estimated: if a field is absent it stays null.
 */
const usage = result?.usage ?? null;
const nativeCostUsd = result?.total_cost_usd ?? null;
const localCheckpointEvents = result?.manual_checkpoints ?? [];
const agentSessionOutcome = (() => {
  if (run.spawnError) return 'spawn_error';
  if (run.timedOut) return 'timed_out';
  if (result === null) return 'missing_terminal_result';
  if (result.is_error === true || result.subtype !== 'success' || run.code !== 0) return 'ended_with_error';
  if (sawStopGuardMessage) return 'completed_after_canary_stop_guard';
  if (sawCanaryBlockText) return 'completed_after_block_and_repair';
  return 'completed';
})();
const ledger = {
  layout: LAYOUT_VERSION, attemptId, runRoot, attemptDir,
  label, arm, repo, agentCommand, agentProtocol, agentModel, agentWarnings, startedAt, wallSeconds,
  localModelRuntime: usesOllama ? { before: localModelRuntimeBefore, after: localModelRuntimeAfter } : null,
  canary: { path: CLI, version: cliVersion, binarySha256: cliSha256, artifactSha256: artifactSha256.toLowerCase() },
  agentExitCode: run.code ?? null, spawnError: run.spawnError ?? null, timedOut: run.timedOut === true,
  agentSessionOutcome,
  streamLines: rawStream.split(/\r?\n/).filter((l) => l.trim()).length,
  streamParseErrors: parseErrors,
  sawResultEvent: result !== null,
  resultSubtype: result?.subtype ?? null,
  resultIsError: result?.is_error ?? null,
  stopReason: result?.stop_reason ?? null,
  model,
  numTurns: result?.num_turns ?? null,
  durationMsProvider: result?.duration_ms ?? null,
  usage,
  totalCostUsdProvider: nativeCostUsd,
  perSessionBudgetUsd: pilotBudgetUsd,
  costWithinSessionBudget: pilotBudgetUsd === null ? null : (Number.isFinite(nativeCostUsd) && nativeCostUsd <= pilotBudgetUsd),
  sawStopHookFeedback, sawCanaryBlockText, sawCanarySystemMessage, sawStopGuardMessage,
  forwardedEnvKeys: forwardedKeys,
  assistantEvents: assistantEvents.length,
  agentWarnings,
};
writeArtifact('ledger.json', `${JSON.stringify(ledger, null, 2)}\n`);

// Did the model SEE a refusal? On this CLI a Stop-hook refusal reaches the model as
// user-role text ("Stop hook feedback: …"); hook events are not emitted for a
// project-level Stop hook. "The hook fired" and "the model was told why" are two
// different claims and both are recorded.
// ---------------------------------------------------------------- checkpoint state AFTER
const checkpointAfter = readCheckpointRaw();
const checkpointMtimeAfter = (() => { try { return fs.statSync(checkpointPath).mtimeMs; } catch { return null; } })();
const hookFiredDuringRun = agentProtocol !== 'ollama-native' && checkpointMtimeBefore !== checkpointMtimeAfter && checkpointMtimeAfter !== null;

// ---------------------------------------------------------------- drive checkpoint if needed
let driven = null;
if (agentProtocol === 'ollama-native' && localCheckpointEvents.length > 0) {
  const last = localCheckpointEvents.at(-1);
  driven = { exitCode: last.exitCode, stdout: last.stdout ?? '', stderr: last.stderr ?? '' };
  if (last.input) writeArtifact('hook-input.json', `${JSON.stringify(last.input, null, 2)}\n`);
  writeArtifact('checkpoint-manual.stdout.txt', `${driven.stdout}\n`);
  writeArtifact('checkpoint-manual.stderr.txt', `${driven.stderr}\n`);
}
if (!hookFiredDuringRun && arm === 'canary' && driven === null) {
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
const checkpointFinal = readCheckpointRaw();
const checkpointMtimeFinal = (() => { try { return fs.statSync(checkpointPath).mtimeMs; } catch { return null; } })();

function classifyVerification(manual, finalCheckpoint) {
  let response = null;
  try { response = manual?.stdout ? JSON.parse(manual.stdout) : null; } catch { /* output may be empty on silent success */ }
  let checkpoint = null;
  try { checkpoint = finalCheckpoint ? JSON.parse(finalCheckpoint) : null; } catch { /* preserve unknown */ }
  const responseText = String(response?.systemMessage ?? response?.reason ?? '');
  const decision = response?.decision ?? null;
  const checkpointStatus = checkpoint?.status ?? null;
  // Earlier blocks remain historical observations, never the final proof status.
  const evidenceStatus = canaryEvidenceStatus(response, checkpoint);
  return {
    checkpointStatus,
    blockDecisionObserved: decision === 'block' || sawCanaryBlockText,
    finalCheckpointDecision: decision,
    stopGuardMessageObserved: sawStopGuardMessage,
    evidenceStatus,
    message: responseText || null,
  };
}
const verification = arm === 'canary' ? classifyVerification(driven, checkpointFinal) : {
  checkpointStatus: null,
  blockDecisionObserved: false,
  finalCheckpointDecision: null,
  stopGuardMessageObserved: false,
  evidenceStatus: 'not_applicable_plain_arm',
  message: null,
};

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
  afterManual: { raw: checkpointFinal, mtimeMs: checkpointMtimeFinal },
  hookFiredDuringRun,
  checkpointDrivenManually: driven !== null,
  manual: driven,
  agentManualCheckpoints: localCheckpointEvents,
  verification,
  agentSessionOutcome,
  stopReason: result?.stop_reason ?? null,
  resultSubtype: result?.subtype ?? null,
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
  agentWarnings,
  localModelRuntime: usesOllama ? { before: localModelRuntimeBefore, after: localModelRuntimeAfter } : null,
  agentManualCheckpoints: localCheckpointEvents,
  checkpointBefore,
  checkpointAfter,
  checkpointFinal,
  hookFiredDuringRun,
  seenByModel: { sawStopHookFeedback, sawCanaryBlockText, sawCanarySystemMessage },
  checkpointDrivenManually: driven !== null,
  manuallyDriven: driven,
  verification,
  agentSessionOutcome,
  gitBefore: before,
  gitAfter: { head: after.head, status: after.status, untracked: after.untracked },
  claimedFilesTouchedOutsideRepo: null,
};
writeArtifact('record.json', `${JSON.stringify(record, null, 2)}\n`);

// ---------------------------------------------------------------- assertions (the probe's own bar)
check('agent process started and exited', () => assert(run.spawnError == null, `spawn error: ${run.spawnError}`));
check('stream is parseable NDJSON', () => assert(parseErrors <= 1, `${parseErrors} unparseable line(s) (at most one truncated trailing line is tolerated on a killed run)`));
check('agent produced a terminal result event', () => assert(result !== null, 'no `result` event in the stream'));
if (pilotBudgetUsd !== null) {
  check('native provider cost is present', () => assert(Number.isFinite(nativeCostUsd), 'result event has no finite total_cost_usd; pilot accounting is incomplete'));
  check('native provider cost stays within the enforced session cap', () => assert(Number.isFinite(nativeCostUsd) && nativeCostUsd <= pilotBudgetUsd,
    'native cost ' + String(nativeCostUsd) + ' exceeds per-session cap ' + pilotBudgetUsd));
  check('agent session ended successfully within its time limit', () => assert(agentSessionOutcome === 'completed' || agentSessionOutcome === 'completed_after_block_and_repair',
    'agent session outcome is ' + agentSessionOutcome + ', result=' + result?.subtype + ', exit=' + String(run.code) + ', timedOut=' + String(run.timedOut)));
}
if (agentProtocol === 'codex-local') {
  check('native Codex token usage is present', () => assert(usage && ['input_tokens', 'output_tokens', 'cached_input_tokens', 'reasoning_output_tokens'].every((key) => Number.isFinite(usage[key]) && usage[key] >= 0),
    'Codex turn.completed has incomplete token usage'));
  check('Ollama served the requested local model with a digest', () => assert(localModelRuntimeAfter?.match?.name === agentModel && /^[0-9a-f]{64}$/i.test(localModelRuntimeAfter.match.digest ?? ''),
    'requested ' + agentModel + '; runtime observation ' + JSON.stringify(localModelRuntimeAfter)));
  check('local Codex session ended successfully within its time limit', () => assert(agentSessionOutcome === 'completed' || agentSessionOutcome === 'completed_after_block_and_repair',
    'agent session outcome is ' + agentSessionOutcome));
  if (arm === 'canary') check('Canary Stop hook fired during the local Codex session', () => assert(hookFiredDuringRun, 'Canary Stop hook did not fire during the model session'));
}
if (agentProtocol === 'ollama-native') {
  check('native local token usage and model digest are present', () => assert(hasOllamaNativeUsageEvidence(usage, localModelRuntimeAfter),
    'Ollama local runtime or native token usage evidence is missing'));
  check('Ollama served the requested local model', () => assert(localModelRuntimeAfter?.match?.name === agentModel,
    'requested ' + agentModel + '; runtime observation ' + JSON.stringify(localModelRuntimeAfter)));
  check('local native tool session ended successfully within its time limit', () => assert(agentSessionOutcome === 'completed' || agentSessionOutcome === 'completed_after_block_and_repair' || agentSessionOutcome === 'completed_after_canary_stop_guard',
    'agent session outcome is ' + agentSessionOutcome));
  if (arm === 'canary') check('local session recorded a Canary completion decision', () => assert(localCheckpointEvents.length > 0,
    'native local agent did not drive a completion checkpoint'));
}
if (arm === 'canary') check('a Canary checkpoint decision was obtained (hook or manually driven)', () => {
  if (hookFiredDuringRun) return assert(checkpointAfter != null, 'hook fired but no checkpoint file');
  assert(driven != null, 'checkpoint was never driven');
  assert(driven.exitCode === 0, `checkpoint exit ${driven.exitCode}`);
  assert(driven.stdout.length > 0 || (verification.checkpointStatus === 'pass' && checkpointMtimeFinal !== checkpointMtimeBefore),
    'checkpoint produced neither a stdout decision nor a fresh passing checkpoint');
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
if (agentProtocol === 'codex-local') console.log('--- local Codex/Ollama inference; provider USD charge is not applicable');
else if (agentProtocol === 'ollama-native') console.log(`--- local Ollama native tool loop; provider USD charge is not applicable; Canary checks ${arm === 'canary' ? 'were driven by the harness' : 'not applicable in plain arm'}`);
else if (agentCmd !== 'claude') console.log('--- STUB AGENT: this attempt is a provenance/harness measurement, NOT real-world evidence.');
console.log(`--- ${failures === 0 ? 'RUN COMPLETE' : `RUN INCOMPLETE (${failures} failure(s))`}`);
process.exit(probeExitCode);
