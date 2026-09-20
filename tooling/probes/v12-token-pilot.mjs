// Paired token pilot: PLAIN vs the REAL Canary confined production path.
//
//   node tooling/probes/v12-token-pilot.mjs --task <fixture> [--label <name>]
//
// The Canary arm is the executable production path, not an imitation of it:
//   trusted preflight (`canary setup` + `canary task` with the fixture's own requirements)
//   -> operator enrollment -> REAL Claude transport with the REAL model
//   -> every file edit, shell command and Git operation crosses the confined executor
//   -> broker-owned review and promotion of the worker's bytes
//   -> the hidden oracle runs on the PROMOTED bytes, from outside the project.
//
// The Plain arm is the repository's own benchmark record for the same fixture, model and
// CLI (`--plain-record`, default results/<label>-<task>-plain-1.json), so both arms are
// measured by the same harness on the same starting bytes and the same oracle.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { removeMeasurementAuthority } from '../../apps/cli/dist/src/provider/production-measurement.js';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const repo = path.resolve(import.meta.dirname, '../..');
const cli = path.join(repo, 'apps/cli/dist/src/main.js');
const fixtures = path.join(repo, 'tooling/benchmark/fixtures');
const results = path.join(repo, 'tooling/benchmark/results');
const gitExe = 'C:\\Program Files\\Git\\cmd\\git.exe';
const claude = path.join(os.homedir(), '.local/bin/claude.exe');
const task = arg('task', 'bound-requirements');
const label = arg('label', 'v12pilot');
const model = arg('model', 'qwen3.8-flash');
const timeoutMin = Number(arg('timeout-min', 25));
const plainRecordPath = arg('plain-record', path.join(results, `v12tok-main-${task}-plain-1.json`));
const outRecord = arg('out', path.join(results, `${label}-${task}-canary-1.json`));
if (fs.existsSync(outRecord)) { console.error(`refusing to overwrite existing evidence: ${outRecord}`); process.exit(2); }

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-token-pilot-'));
const base = path.join(temp, 'project'), work = path.join(temp, 'candidate'), store = path.join(temp, 'store');
const promptFile = path.join(temp, 'prompt.txt');
let enrolled, broker, stub, failure = null;
const env = { ...process.env, CANARY_TRUST_STORE: path.join(temp, 'local-trust') };
const run = (exe, args, cwd = base, expect = 0, timeout = 300000) => {
  const r = spawnSync(exe, args, { cwd, env, encoding: 'utf8', windowsHide: true, timeout });
  if (expect !== null) assert.equal(r.status, expect, `${exe} ${args.join(' ')}\n${r.stdout}${r.stderr}`); return r;
};
const canary = (args, expect = 0) => run(process.execPath, [cli, ...args], base, expect);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const meta = JSON.parse(fs.readFileSync(path.join(fixtures, task, 'fixture.json'), 'utf8'));
const taskText = fs.readFileSync(path.join(fixtures, task, 'TASK.md'), 'utf8');

try {
  // ── the trusted starting bytes: the fixture project, committed ──
  fs.cpSync(path.join(fixtures, task, 'project'), base, { recursive: true });
  run(gitExe, ['init', '-b', 'main']); run(gitExe, ['config', 'user.name', 'Pilot']); run(gitExe, ['config', 'user.email', 'pilot@localhost']);
  run(gitExe, ['add', '-A']); run(gitExe, ['commit', '-m', 'baseline']);
  const startingBytes = run(gitExe, ['rev-parse', 'HEAD']).stdout.trim();

  // ── trusted preflight: seal the plan, declare the fixture's own requirements ──
  // MEASURED product behaviour the harness itself records: on a repository whose own
  // checks currently FAIL, `canary setup` exits 2 with NEEDS ATTENTION and still seals
  // the plan and installs the wiring. Exit 0 is therefore not the condition for a usable
  // arm; a sealed plan plus a registered task record is.
  const setup = canary(['setup', '--yes'], null);
  const sealedPath = path.join(base, '.canary', 'canary.local.json');
  assert.ok(fs.existsSync(sealedPath), `the plan was not sealed (setup exit ${setup.status})`);
  const setupState = { exitCode: setup.status, readme: /READY/.test(setup.stdout) ? 'READY' : (/NEEDS ATTENTION/.test(setup.stdout) ? 'NEEDS ATTENTION' : 'other') };
  // No --kind: the declared requirements are the duty, and inference is the documented
  // default (an unknown kind is REFUSED, exit 3, per the verbatim-or-refused rule).
  const requirements = Array.isArray(meta.requirements) ? meta.requirements : [];
  canary(['task', meta.intent ?? task, ...requirements.flatMap(r => ['--requirement', r])]);
  // The operator commits their own wiring, exactly as the production probe does: the
  // broker's promotion readback requires the trusted base to be CLEAN, and an uncommitted
  // `.canary`/`.claude` would make it refuse to CONFIRM a promotion it had applied.
  run(gitExe, ['add', '-A']); run(gitExe, ['commit', '--allow-empty', '-m', 'operator wiring']);
  enrolled = JSON.parse(canary(['provider', 'enroll', base, store]).stdout);
  // The candidate is the same starting bytes the Plain arm gets: the fixture project.
  fs.cpSync(path.join(fixtures, task, 'project'), work, { recursive: true });
  run(gitExe, ['init', '-b', 'main'], work); run(gitExe, ['config', 'user.name', 'Pilot'], work);
  run(gitExe, ['config', 'user.email', 'pilot@localhost'], work);
  run(gitExe, ['add', '-A'], work); run(gitExe, ['commit', '-m', 'baseline'], work);
  fs.writeFileSync(promptFile, taskText);

  // ── the broker that owns review and promotion ──
  const { challenge } = JSON.parse(canary(['provider', 'measurement-begin', store]).stdout);
  broker = spawn(process.execPath, [cli, 'provider', 'serve-production', store], { cwd: temp, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let brokerLog = ''; broker.stdout.on('data', x => brokerLog += x); broker.stderr.on('data', x => brokerLog += x);
  let ready = false;
  for (let i = 0; i < 120 && !ready; i++) {
    ready = await new Promise(resolve => { const s = net.connect('\\\\.\\pipe\\' + enrolled.pipe); s.on('connect', () => s.write('{"verb":"hello"}\n')); s.on('data', () => { s.destroy(); resolve(true); }); s.on('error', () => resolve(false)); });
    if (!ready) await sleep(250);
  }
  assert.ok(ready, `broker unavailable: ${brokerLog}`);

  // ── the REAL model, through the REAL confined transport ──
  // Credentials travel in the transport's own environment (the confined worker never
  // receives them) and are never printed.
  const settings = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8'));
  const transportEnv = { ...env, ...(settings.env ?? {}) };
  assert.ok(transportEnv.ANTHROPIC_AUTH_TOKEN || transportEnv.ANTHROPIC_API_KEY, 'no model credential in the harness settings');
  // `--stub` replaces the model with a local deterministic server. It validates the
  // PILOT'S PLUMBING (stream parsing, broker call, oracle) at zero token cost and is
  // never a measurement: a stub cannot implement the task.
  if (process.argv.includes('--stub')) {
    stub = http.createServer((req, res) => {
      let body = ''; req.on('data', c => body += c);
      req.on('end', () => {
        if (!req.url.startsWith('/v1/messages')) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const event = v => res.write(`event: ${v.type}\ndata: ${JSON.stringify(v)}\n\n`);
        event({ type: 'message_start', message: { id: 'stub-1', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 } } });
        event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'stub: no implementation performed' } });
        event({ type: 'content_block_stop', index: 0 });
        event({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } });
        event({ type: 'message_stop' }); res.end();
      });
    });
    await new Promise(r => stub.listen(0, '127.0.0.1', r));
    transportEnv.ANTHROPIC_BASE_URL = `http://127.0.0.1:${stub.address().port}`;
    transportEnv.ANTHROPIC_API_KEY = 'stub-key';
    console.log('STUB MODE: plumbing validation only; these numbers are NOT a measurement');
  }
  const startedAt = new Date().toISOString(), t0 = Date.now();
  const child = spawn(process.execPath, [cli, 'provider', 'model-transport', store, work, promptFile, model, claude],
    { cwd: temp, env: transportEnv, windowsHide: true });
  let stdout = '', stderr = '';
  child.stdout.on('data', x => stdout += x); child.stderr.on('data', x => stderr += x);
  const code = await Promise.race([new Promise(r => child.once('exit', r)), sleep(timeoutMin * 60000).then(() => 'timeout')]);
  if (code === 'timeout') child.kill();
  const durationMs = Date.now() - t0;
  fs.writeFileSync(path.join(os.tmpdir(), `canary-token-pilot-${task}-transport.log`), stdout + stderr);

  // The transport streams the CLI's own stream-json: token accounting is the CLI's own.
  const events = stdout.split('\n').filter(l => l.trim().startsWith('{')).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const resultEvent = [...events].reverse().find(e => e.type === 'result');
  const u = resultEvent?.usage ?? {};
  const usage = {
    inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0, cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
  };
  usage.totalTokens = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
  /**
   * v1.3 §29 — DID A MODEL SESSION ACTUALLY HAPPEN?
   *
   * The confined transport refuses on an unbound requirement BEFORE spawning anything
   * (`model-transport.ts:27`), so the CLI exits 3 with no result event and zero tokens. Recording that as
   * `workerLaunches: 1` made an UNBOUND fixture look like a worker that ran and failed — which is a
   * different fact, and the wrong one: the benchmark's rule is that unbound fixtures get 0 launches,
   * 0 worker tokens and NO delivered-correctness credit. Measured across the six-fixture benchmark, the
   * three refused cells all carry 0 tokens and ~120 ms, and the three that ran all carry >0.
   */
  const workerRan = resultEvent !== undefined && usage.totalTokens > 0;
  const turns = resultEvent?.num_turns ?? null;
  const toolRequests = events.filter(e => e.type === 'assistant').flatMap(e => (e.message?.content ?? []).filter(c => c.type === 'tool_use')).length;

  // ── broker review + promotion of whatever the worker produced ──
  const changed = run(gitExe, ['status', '--porcelain'], work).stdout.split('\n').map(l => l.slice(3).trim()).filter(Boolean)
    // A rename or a path with a space would otherwise be read as one bogus filename.
    .map(f => (f.includes(' -> ') ? f.split(' -> ').pop() : f).replace(/^"|"$/g, ''))
    .filter(f => f && !f.endsWith('/') && fs.existsSync(path.join(work, f)) && fs.statSync(path.join(work, f)).isFile());
  const files = Object.fromEntries(changed.map(f => [f, fs.readFileSync(path.join(work, f)).toString('base64')]));
  const callerOut = path.join(work, 'caller.json');
  const config = path.join(work, 'request.json');
  fs.writeFileSync(config, JSON.stringify({ ...enrolled, challenge, candidate: 'pilot', output: callerOut,
    actions: [{ id: 'review', request: { verb: 'review', files } }, { id: 'promote', request: { verb: 'promote' }, useReview: true }] }));
  fs.copyFileSync(path.join(repo, 'tooling/test-support/fixtures/production-caller.cjs'), path.join(work, 'caller.cjs'));
  let brokerResult = null, promoteDetail = null;
  try {
    canary(['provider', 'launch', store, work, process.execPath, '--preserve-symlinks-main', path.join(work, 'caller.cjs'), config]);
    const rows = JSON.parse(fs.readFileSync(callerOut, 'utf8'));
    brokerResult = Object.fromEntries(rows.map(x => [x.id, x.response]));
    promoteDetail = brokerResult.promote?.detail ?? null;
  } catch (e) { brokerResult = { error: e.message.split('\n')[0] }; }
  // Independently confirm whether the TRUSTED project actually received the worker bytes.
  const promotedBytes = Object.fromEntries(changed.map(f => {
    const inBase = fs.existsSync(path.join(base, f)), inWork = fs.existsSync(path.join(work, f));
    if (!inWork) return [f, { deletedByWorker: true, stillInBase: inBase }];
    if (!inBase) return [f, { addedByWorker: true, deliveredToBase: false }];
    return [f, { identical: fs.readFileSync(path.join(base, f)).equals(fs.readFileSync(path.join(work, f))) }];
  }));

  // ── correctness: the hidden oracle, from OUTSIDE, on the promoted project bytes ──
  const oracle = cwd => {
    const r = run(process.execPath, [path.join(fixtures, task, 'hidden', 'check.cjs'), cwd], path.join(repo, 'tooling/benchmark'), null, 120000);
    const m = /hidden oracle: (\d+)\/(\d+) behaviour checks passed/.exec(r.stdout);
    return { exitCode: r.status, passing: Number(m?.[1] ?? -1), total: Number(m?.[2] ?? -1), oracleError: m === null, tail: r.stdout.split('\n').slice(-3).join('\n') };
  };
  const visible = cwd => { const r = run(process.execPath, [path.join(cwd, 'run-tests.js')], cwd, null, 120000); return { exitCode: r.status, tail: (r.stdout + r.stderr).split('\n').slice(-3).join('\n') }; };
  const promotedOracle = oracle(base), candidateOracle = oracle(work), candidateVisible = visible(work);

  const plain = fs.existsSync(plainRecordPath) ? JSON.parse(fs.readFileSync(plainRecordPath, 'utf8')) : null;
  const record = {
    schema: 'canary-token-pilot/1', label, task, arm: 'canary-confined-transport', variant: 'normal',
    model, transport: 'canary provider model-transport (real Claude CLI, real AppContainer, real model)',
    startedAt, finishedAt: new Date().toISOString(), durationMs, startingBytes,
    requirements, workerLaunches: workerRan ? 1 : 0, refusedBeforeModel: !workerRan, setup: setupState,
    agentResult: { exitCode: code, usage, turns, toolRequests, parseFailure: resultEvent === undefined, costUsd: resultEvent?.total_cost_usd ?? null },
    candidate: { files: changed, visible: candidateVisible, hidden: candidateOracle },
    broker: { review: brokerResult?.review?.status ?? null, promote: brokerResult?.promote?.status ?? null,
      reviewDetail: brokerResult?.review?.detail ?? null, promoteDetail, promotedBytes,
      detail: brokerResult?.review?.detail ?? brokerResult?.error ?? null },
    promoted: { hidden: promotedOracle },
    deliveredCorrect: promotedOracle.total > 0 && promotedOracle.passing === promotedOracle.total && candidateVisible.exitCode === 0,
  };
  fs.mkdirSync(path.dirname(outRecord), { recursive: true });
  fs.writeFileSync(outRecord, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });

  console.log(`Canary confined transport: exit=${code} turns=${turns} tokens=${usage.totalTokens} (in ${usage.inputTokens} / out ${usage.outputTokens} / cacheRead ${usage.cacheReadTokens} / cacheWrite ${usage.cacheCreationTokens})`);
  console.log(`changed=${JSON.stringify(changed)} broker review=${record.broker.review} promote=${record.broker.promote}`);
  console.log(`hidden on promoted bytes: ${promotedOracle.passing}/${promotedOracle.total} (exit ${promotedOracle.exitCode}); visible suite exit ${candidateVisible.exitCode}`);
  if (plain) {
    const p = plain.agentResult;
    const delta = usage.totalTokens - p.usage.totalTokens;
    console.log(`PLAIN (recorded, same fixture/model/CLI): turns=${p.numTurns} tokens=${p.usage.totalTokens} hidden=${plain.hidden.passing}/${plain.hidden.total} visible=${plain.visible.exitCode === 0}`);
    console.log(`DELTA: ${delta} tokens (${((delta / p.usage.totalTokens) * 100).toFixed(1)}%)  turns ${p.numTurns} -> ${turns}`);
    console.log(`CORRECTNESS: plain ${plain.hidden.passing}/${plain.hidden.total} vs canary ${promotedOracle.passing}/${promotedOracle.total}`);
  } else {
    console.log(`no plain record at ${plainRecordPath}; Canary arm recorded only`);
  }
  console.log(`record: ${outRecord}`);
} catch (e) { failure = e; } finally {
  if (broker) { broker.kill(); broker.stdout?.destroy(); broker.stderr?.destroy(); }
  if (stub) await new Promise(r => stub.close(r));
  if (enrolled) {
    try { removeMeasurementAuthority(store, enrolled.id); } catch { }
    for (const name of [enrolled.profile, enrolled.profile + '.Verifier']) {
      const file = path.join(temp, 'cleanup.json');
      fs.writeFileSync(file, JSON.stringify({ mode: 'identity', name, delete: true, result: path.join(temp, 'deleted.json') }));
      spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(repo, 'tools/windows-boundary/production-native.ps1'), '-Request', file], { windowsHide: true });
    }
  }
  await sleep(500);
  if (!process.argv.includes('--keep')) fs.rmSync(temp, { recursive: true, force: true });
  else console.log(`kept: ${temp}`);
}
// Deterministic termination: a measurement probe must not depend on every child handle
// being released before it can report its exit code.
if (failure) { console.error(failure.stack ?? String(failure)); process.exit(1); }
process.exit(0);
