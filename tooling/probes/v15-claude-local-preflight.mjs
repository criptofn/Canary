#!/usr/bin/env node
/** Native Claude + installed Canary + local Ollama, with captured native API usage. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseAnthropicUsage, claudeUsageMatchesNative } from './v15-anthropic-usage.mjs';
import { installedCliEnvironment } from './v15-installed-cli-env.mjs';

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? null : process.argv[i + 1]; };
const cli = arg('cli'), claude = arg('claude'), ollama = arg('ollama'), out = arg('out');
const withTools = process.argv.includes('--with-tools');
const preparedRoot = arg('prepared-root');
const taskSelection = arg('tasks')?.split(',') ?? null;
assert.ok(!taskSelection || (preparedRoot && taskSelection.length && new Set(taskSelection).size === taskSelection.length
  && taskSelection.every((label) => ['H1', 'H2', 'H3', 'H5', 'R1', 'S1'].includes(label))), 'unique supported --tasks requires --prepared-root');
const expectedSessions = preparedRoot ? (taskSelection?.length ?? 6) * 2 : withTools ? 6 : 3;
assert.ok(!preparedRoot || path.isAbsolute(preparedRoot), 'absolute --prepared-root required');
const preparation = preparedRoot ? JSON.parse(fs.readFileSync(path.join(preparedRoot, 'preparation-summary.json'), 'utf8')) : null;
if (preparation) {
  assert.equal(preparation.status, 'complete'); assert.equal(preparation.records.length, preparation.tasks.length * 2);
  assert.equal(preparation.cliSha256, crypto.createHash('sha256').update(fs.readFileSync(cli)).digest('hex'));
}
for (const [name, value] of Object.entries({ cli, claude, ollama, out })) assert.ok(value && path.isAbsolute(value), `absolute --${name} required`);
for (const [name, value] of Object.entries({ cli, claude, ollama })) assert.ok(fs.statSync(value, { throwIfNoEntry: false })?.isFile(), `--${name} must be an existing file`);
assert.ok(!fs.existsSync(out), 'new evidence directory required');
const model = 'qwen3.5:9b';
const digest = '6488c96fa5faab64bb65cbd30d4289e20e6130ef535a93ef9a49f42eda893ea7';
const backend = 'http://127.0.0.1:11437';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-native-claude-local-'));
const workspace = path.join(temp, 'project');
const profile = path.join(temp, 'claude-profile');
fs.mkdirSync(workspace); fs.mkdirSync(profile); fs.mkdirSync(out, { recursive: true });
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const save = (name, data) => fs.writeFileSync(path.join(out, name), typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx' });
const safeEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(ANTHROPIC|CLAUDE|OPENAI|BEDROCK|AZURE|AWS|TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|AUTH|PROXY)/i.test(key)));
Object.assign(safeEnv, {
  CLAUDE_CONFIG_DIR: profile, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CANARY_TRUST_STORE: path.join(temp, 'trust'), NO_PROXY: '127.0.0.1,localhost',
  HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
  ENABLE_TOOL_SEARCH: 'false', ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
  CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: '1', MCP_TOOL_TIMEOUT: '120000',
  CLAUDE_CODE_MAX_CONTEXT_TOKENS: '65536', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '4096',
});
const metadata = { startedAt: new Date().toISOString(), node: process.version, model, modelDigest: digest,
  cli, cliSha256: sha(fs.readFileSync(cli)), claude, claudeSha256: sha(fs.readFileSync(claude)),
  ollama, ollamaSha256: sha(fs.readFileSync(ollama)), backend, contextLength: 65536, maxOutputTokens: 4096, maxTurns: 50,
  instrumentSha256: sha(fs.readFileSync(fileURLToPath(import.meta.url))), workspace, profile, withTools, preparedRoot, taskSelection };
save('instrument.mjs', fs.readFileSync(fileURLToPath(import.meta.url), 'utf8'));
save('v15-anthropic-usage.mjs', fs.readFileSync(new URL('./v15-anthropic-usage.mjs', import.meta.url), 'utf8'));
metadata.usageParserSha256 = sha(fs.readFileSync(new URL('./v15-anthropic-usage.mjs', import.meta.url)));
save('v15-installed-cli-env.mjs', fs.readFileSync(new URL('./v15-installed-cli-env.mjs', import.meta.url), 'utf8'));
metadata.cliEnvironmentSha256 = sha(fs.readFileSync(new URL('./v15-installed-cli-env.mjs', import.meta.url)));
if (preparation) {
  metadata.cliAliasDirectory = installedCliEnvironment(cli, safeEnv).PATH.split(path.delimiter)[0];
  metadata.cliAliases = Object.fromEntries(['canary', 'canary.cmd', 'canary.ps1'].map(name =>
    [name, sha(fs.readFileSync(path.join(metadata.cliAliasDirectory, name)))]));
}
save('manifest.json', metadata);
const commands = [], requests = [], sessions = [];
let server, gateway, failure = null, cleanup = null;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (route, body, timeout = 15_000) => {
  const response = await fetch(`${backend}${route}`, { method: body ? 'POST' : 'GET',
    ...(body ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}),
    signal: AbortSignal.timeout(timeout) });
  assert.ok(response.ok, `${route}: HTTP ${response.status}`);
  return response.json();
};
function run(name, executable, args, cwd = workspace) {
  const result = spawnSync(executable, args, { cwd, env: safeEnv, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  save(`${name}.stdout.txt`, result.stdout ?? ''); save(`${name}.stderr.txt`, result.stderr ?? '');
  commands.push({ name, executable, args, cwd, exitCode: result.status, error: result.error?.message ?? null });
  assert.equal(result.status, 0, `${name}: see saved output`); assert.equal(result.error, undefined);
  return (result.stdout ?? '').trim();
}
async function session(name, prompt, hooks, tools = false, options = {}) {
  const cwd = options.repo ?? workspace;
  const dir = path.join(out, name); fs.mkdirSync(dir);
  const checkpointFile = path.join(cwd, '.canary/last-checkpoint.json');
  const before = fs.existsSync(checkpointFile) ? fs.readFileSync(checkpointFile, 'utf8') : null;
  const start = requests.length;
  const args = ['-p', prompt, '--model', model, '--settings', path.join(out, 'local-settings.json'),
    '--setting-sources', hooks || options.pilot ? 'project,local' : '', '--tools', tools ? 'Read,Write,Edit,Bash,Glob,Grep' : '', '--strict-mcp-config',
    '--mcp-config', tools && hooks ? path.join(cwd, '.mcp.json') : path.join(out, 'empty-mcp.json'),
    '--output-format', 'stream-json', '--verbose', '--include-hook-events',
    '--system-prompt', options.pilot
      ? 'Implement the requested task using the available tools. Add meaningful regression tests, keep existing checks intact, and do not change Canary configuration or reseal the baseline. Do not delegate. Finish with a short factual summary.'
      : tools
      ? 'Repair the requested source file using the available tools. Keep checks and Canary configuration unchanged. Do not delegate. Finish with a short factual summary.'
      : 'Reply with one short sentence. This is a local completion-hook control. No tools are available.'];
  if (tools) args.push('--permission-mode', 'acceptEdits', '--allowedTools',
    'Read,Write,Edit,Glob,Grep,Bash,mcp__canary__canary_result,mcp__canary__canary_status,mcp__canary__canary_agents,mcp__canary__canary_doctor',
    '--effort', 'low', '--max-turns', String(options.maxTurns ?? 50), '--disallowedTools',
    'Bash(*setup*),Bash(*bind*),Bash(*accept*),Edit(**/.canary/**),Write(**/.canary/**),Edit(**/.claude/**),Write(**/.claude/**),Edit(**/.mcp.json),Write(**/.mcp.json),Edit(**/package.json),Write(**/package.json),Edit(**/build.gradle.kts),Write(**/build.gradle.kts)');
  let stdout = '', stderr = '', timedOut = false;
  const startedAt = new Date().toISOString();
  const child = spawn(claude, args, { cwd, env: { ...safeEnv, ...localEnv, ...options.env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const finished = new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
  });
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', (text) => { stdout += text; fs.appendFileSync(path.join(dir, 'claude.jsonl'), text); });
  child.stderr.on('data', (text) => { stderr += text; fs.appendFileSync(path.join(dir, 'claude.stderr.txt'), text); });
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, options.pilot ? 1_800_000 : tools ? 600_000 : 180_000);
  let result;
  try { result = await finished; } finally { clearTimeout(timer); }
  const events = stdout.split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  const terminal = events.findLast((event) => event.type === 'result');
  const blocks = events.flatMap((event) => Array.isArray(event.message?.content) ? event.message.content : []);
  const hookEvents = events.filter((event) => event.type === 'system' && event.subtype === 'hook_response' && event.hook_event === 'Stop');
  const toolCalls = blocks.filter((block) => block.type === 'tool_use').map((block) => ({ ...block,
    result: blocks.find((result) => result.type === 'tool_result' && result.tool_use_id === block.id) ?? null }));
  const after = fs.existsSync(checkpointFile) ? fs.readFileSync(checkpointFile, 'utf8') : null;
  const checkpoint = after ? JSON.parse(after) : null;
  const calls = requests.slice(start).filter((r) => r.route === '/v1/messages');
  const nativeComplete = calls.length > 0 && calls.every((r) => r.httpStatus === 200 && r.complete
    && Number.isSafeInteger(r.usage.input_tokens) && r.usage.input_tokens >= 0
    && Number.isSafeInteger(r.usage.output_tokens) && r.usage.output_tokens >= 0);
  const nativeUsage = nativeComplete ? calls.reduce((sum, r) => ({ input_tokens: sum.input_tokens + r.usage.input_tokens,
    output_tokens: sum.output_tokens + r.usage.output_tokens }), { input_tokens: 0, output_tokens: 0 }) : null;
  const accountingMatches = claudeUsageMatchesNative(terminal, nativeUsage, model);
  const mainAccountingMatches = nativeUsage !== null && terminal?.usage?.input_tokens === nativeUsage.input_tokens
    && terminal?.usage?.output_tokens === nativeUsage.output_tokens;
  const captureComplete = terminal !== undefined && nativeComplete && accountingMatches && !timedOut;
  const record = { name, args, startedAt, finishedAt: new Date().toISOString(), ...result, timedOut,
    terminal: terminal ?? null, nativeUsage, accountingMatches, mainAccountingMatches, captureComplete, calls: calls.map((r) => r.number), toolCalls, hookEvents, cwd,
    checkpoint, checkpointChanged: after !== before, hookFired: after !== before && checkpoint?.source === 'checkpoint' && hookEvents.length > 0,
    modelRuntime: await api('/api/ps') };
  fs.writeFileSync(path.join(dir, 'record.json'), `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
  const evidence = path.join(cwd, '.canary/evidence');
  if (hooks && fs.existsSync(evidence)) fs.cpSync(evidence, path.join(dir, 'product-evidence'), { recursive: true });
  sessions.push(record);
  console.log(`OBSERVED ${name}: exit=${result.exitCode}, nativeUsage=${JSON.stringify(nativeUsage)}, accountingMatches=${accountingMatches}, hook=${record.hookFired}, status=${checkpoint?.status ?? 'none'}`);
  if (options.pilot || options.captureOnly) return record;
  assert.equal(result.exitCode, 0, `${name}: CLI failed`); assert.ok(!timedOut, `${name}: timeout`);
  assert.ok(terminal && !terminal.is_error, `${name}: no successful terminal event`);
  assert.ok(nativeComplete, `${name}: missing native API usage`);
  assert.ok(accountingMatches, `${name}: CLI usage differs from the captured API usage`);
  assert.equal(terminal.modelUsage?.[model]?.contextWindow, metadata.contextLength, 'Claude context differs from actual model context');
  return record;
}
async function pilot() {
  const root = path.resolve(import.meta.dirname, '../..');
  const oracle = path.join(root, 'tooling/probes/v15-validation-oracle.mjs');
  const taskRoot = path.join(root, 'tooling/benchmark/results/session-evidence/v15-realworld/tasks');
  const taskFiles = { H1: 'H1-maxagedays-zero.md', H2: 'H2-invoice-classification.md', H3: 'H3-quantize-bits-validation.md',
    H5: 'H5-simulation-cases.md', R1: 'R1-pytest-id-collision.md', S1: 'S1-idlookup-ambiguity.md' };
  const taskTexts = Object.fromEntries(Object.entries(taskFiles).map(([label, file]) => [label, fs.readFileSync(path.join(taskRoot, file), 'utf8')]));
  const oracleBytes = fs.readFileSync(oracle);
  const oracleSha256 = sha(oracleBytes);
  const schedule = Object.keys(taskFiles).flatMap((label, index) => (index % 2 ? ['canary', 'plain'] : ['plain', 'canary']).map((arm) => ({ label, arm })))
    .filter(({ label }) => !taskSelection || taskSelection.includes(label));
  const outcomes = [];
  save('preparation-summary.json', preparation); save('oracle-instrument.mjs', oracleBytes.toString('utf8'));
  save('pilot-protocol.json', { schedule, cliSha256: metadata.cliSha256, artifactSha256: preparation.artifactSha256,
    tasks: Object.entries(taskFiles).map(([label, file]) => ({ label, file, sha256: sha(taskTexts[label]) })),
    oracleSha256, oracleOptions: { H1: { strictAge: true } }, timeoutMs: 1_800_000, effort: 'low', maxTurns: 50, maxOutputTokens: 4096,
    providerUsdCharge: 0, limitation: 'Local same-user model and independent operator oracles; no OS isolation or general token savings claim.' });
  const git = (repo, ...args) => {
    const r = spawnSync('git', ['-C', repo, ...args], { env: safeEnv, encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
    assert.equal(r.status, 0, `git ${args[0]} failed`); return (r.stdout ?? '').trim();
  };
  const oracleRun = (name, label, repo, expected, dirs) => {
    assert.equal(sha(fs.readFileSync(oracle)), oracleSha256, `${name}: independent oracle changed; evaluation refused`);
    const resultDir = path.join(out, `oracle-${name}`);
    const args = [oracle, '--label', label, '--repo', repo, '--expected', expected, '--out', resultDir];
    if (label === 'H1') args.push('--strict-age');
    if (label === 'S1') args.push('--javac', path.join(dirs[1], 'javac.exe'), '--java', path.join(dirs[1], 'java.exe'));
    const r = spawnSync(process.execPath, args, { cwd: root, env: safeEnv, encoding: 'utf8', windowsHide: true, timeout: 180000 });
    save(`${name}-oracle-process.json`, { args, exitCode: r.status, error: r.error?.message ?? null, stdout: r.stdout, stderr: r.stderr });
    return fs.existsSync(path.join(resultDir, 'oracle-result.json')) ? JSON.parse(fs.readFileSync(path.join(resultDir, 'oracle-result.json'), 'utf8')) : null;
  };
  // Pilot copies are independent: activate their foreign settings equally, and remove only
  // explicitly recorded Canary handlers from the comparison. Synthetic same-repo controls
  // still disable settings in their plain arm so the installed Canary hook cannot run there.
  const readSettings = (repo, file) => fs.existsSync(path.join(repo, file)) ? JSON.parse(fs.readFileSync(path.join(repo, file), 'utf8')) : {};
  for (const label of new Set(schedule.map((record) => record.label))) {
    const repoFor = (arm) => preparation.records.find((record) => record.label === label && record.arm === arm).repo;
    const plain = repoFor('plain'), canary = repoFor('canary');
    assert.equal(fs.existsSync(path.join(plain, '.canary/canary.local.json')), false, `${label}: plain copy already has Canary installed`);
    const config = readSettings(canary, '.canary/canary.local.json');
    const doc = readSettings(canary, '.claude/settings.json');
    for (const [event, commands] of [['Stop', config.hookCommands ?? []], ['SessionStart', config.sessionStartCommands ?? []]]) {
      if (!doc.hooks?.[event]) continue;
      const owned = new Set(commands);
      doc.hooks[event] = doc.hooks[event].map((group) => ({ ...group, hooks: group.hooks.filter((hook) => !owned.has(hook.command)) }))
        .filter((group) => group.hooks.length);
      if (!doc.hooks[event].length) delete doc.hooks[event];
    }
    if (doc.hooks && !Object.keys(doc.hooks).length) delete doc.hooks;
    assert.deepEqual(doc, readSettings(plain, '.claude/settings.json'), `${label}: foreign project settings differ`);
    assert.deepEqual(readSettings(canary, '.claude/settings.local.json'), readSettings(plain, '.claude/settings.local.json'), `${label}: foreign local settings differ`);
    save(`${label}-foreign-settings-check.json`, { settingsSources: 'project,local', foreignSettingsMatched: true });
  }
  // Validate ALL untouched copies and their hidden failure controls before the first model call.
  for (const { label, arm } of schedule) {
    const record = preparation.records.find((r) => r.label === label && r.arm === arm); assert.ok(record);
    const expectedHead = record.setupCommit ?? record.source.baseCommit;
    assert.equal(git(record.repo, 'rev-parse', 'HEAD'), expectedHead);
    assert.equal(git(record.repo, 'status', '--porcelain'), '');
    const measured = oracleRun(`${label}-${arm}-baseline`, label, record.repo, 'fail', record.toolchainDirectories);
    assert.equal(measured?.expectedFailureObserved, true, `${label}/${arm}: baseline oracle did not observe the task defect`);
  }
  for (const { label, arm } of schedule) {
    const record = preparation.records.find((r) => r.label === label && r.arm === arm);
    const repo = record.repo, name = `${label}-${arm}`;
    const protectedFiles = ['package.json', 'build.gradle.kts', '.canary/canary.local.json', '.claude/settings.json', '.mcp.json'];
    const protectedHashes = () => Object.fromEntries(protectedFiles.map((file) => [file, fs.existsSync(path.join(repo, file)) ? sha(fs.readFileSync(path.join(repo, file))) : null]));
    const before = { head: git(repo, 'rev-parse', 'HEAD'), status: git(repo, 'status', '--porcelain'), protected: protectedHashes() };
    save(`${name}-before.json`, before);
    const profileDir = path.join(temp, name); fs.mkdirSync(profileDir);
    const prompt = taskTexts[label]; save(`${name}-task.md`, prompt);
    console.log(`START ${outcomes.length + 1}/${schedule.length} ${name}`);
    const measured = await session(name, prompt, arm === 'canary', true, { pilot: true, repo,
      env: { ...installedCliEnvironment(cli, safeEnv, record.toolchainDirectories), CLAUDE_CONFIG_DIR: profileDir,
        CANARY_TRUST_STORE: path.join(os.tmpdir(), 'canary-v15-validation-trust', sha(repo)) } });
    assert.equal(sha(fs.readFileSync(cli)), metadata.cliSha256, 'frozen CLI changed during the pilot');
    for (const [alias, expected] of Object.entries(metadata.cliAliases)) {
      assert.equal(sha(fs.readFileSync(path.join(metadata.cliAliasDirectory, alias))), expected, 'installed CLI alias changed during the pilot');
    }
    const correctness = oracleRun(`${name}-final`, label, repo, 'pass', record.toolchainDirectories);
    const after = { head: git(repo, 'rev-parse', 'HEAD'), status: git(repo, 'status', '--porcelain'), protected: protectedHashes() };
    save(`${name}-after.json`, after); save(`${name}.diff`, git(repo, 'diff', '--binary', before.head));
    const paths = new Set([...git(repo, 'diff', '--name-only', before.head).split('\n'), ...git(repo, 'ls-files', '--others', '--exclude-standard').split('\n')].filter(Boolean));
    for (const file of paths) {
      const relative = path.relative(repo, path.resolve(repo, file)); assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative));
      const source = path.join(repo, relative); if (!fs.statSync(source, { throwIfNoEntry: false })?.isFile()) continue;
      const target = path.join(out, name, 'changed-files', relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    }
    const outcome = { name, label, arm, correctness: correctness?.testPassed === true ? 'pass' : correctness?.testPassed === false ? 'fail' : 'incomplete',
      sessionComplete: measured.exitCode === 0 && !measured.timedOut && measured.terminal?.is_error === false && measured.accountingMatches,
      sessionCaptured: measured.captureComplete, resultSubtype: measured.terminal?.subtype ?? null,
      hookFired: measured.hookFired, checkpointStatus: measured.checkpoint?.status ?? null,
      nativeUsage: measured.nativeUsage, protectedUnchanged: JSON.stringify(before.protected) === JSON.stringify(after.protected),
      baselinePreserved: spawnSync('git', ['-C', repo, 'merge-base', '--is-ancestor', before.head, after.head], { env: safeEnv, windowsHide: true, timeout: 60000 }).status === 0,
      manualInterventions: 0, providerUsdCharge: 0 };
    outcomes.push(outcome); save(`${name}-outcome.json`, outcome);
    console.log(`END ${name}: correctness=${outcome.correctness}, complete=${outcome.sessionComplete}, checkpoint=${outcome.checkpointStatus}`);
    assert.ok(outcome.sessionCaptured, `${name}: incomplete native capture; retained and stopped`);
    assert.equal(measured.terminal.modelUsage?.[model]?.contextWindow, metadata.contextLength, `${name}: incorrect declared context`);
    assert.ok(outcome.protectedUnchanged && outcome.baselinePreserved, `${name}: protected setup or baseline ancestry changed; retained and stopped`);
    if (arm === 'canary' && outcome.sessionComplete) assert.ok(outcome.hookFired, `${name}: real Stop checkpoint missing; retained and stopped`);
  }
  save('pilot-outcomes.json', outcomes);
}
let localEnv;
try {
  try { await api('/api/version', null, 800); throw new Error('the fixed backend port is already in use'); }
  catch (error) { if (error.message === 'the fixed backend port is already in use') throw error; }
  const logs = [fs.openSync(path.join(out, 'ollama.stdout.txt'), 'wx'), fs.openSync(path.join(out, 'ollama.stderr.txt'), 'wx')];
  server = spawn(ollama, ['serve'], { env: { ...safeEnv, OLLAMA_HOST: backend, OLLAMA_NO_CLOUD: '1',
    OLLAMA_CONTEXT_LENGTH: '65536', OLLAMA_NUM_PARALLEL: '1' }, windowsHide: true, stdio: ['ignore', ...logs] });
  for (const fd of logs) fs.closeSync(fd);
  server.on('error', (error) => { failure = error.message; });
  for (let i = 0; i < 80; i++) {
    if (failure || server.exitCode !== null) throw new Error(`owned Ollama server failed: ${failure ?? server.exitCode}`);
    try { metadata.ollamaVersion = await api('/api/version'); break; } catch { await delay(250); }
  }
  assert.ok(metadata.ollamaVersion, 'Ollama did not become ready');
  assert.match(fs.readFileSync(path.join(out, 'ollama.stderr.txt'), 'utf8'), /Ollama cloud disabled:\s*true/i);
  const tags = await api('/api/tags'); save('ollama-tags.json', tags);
  const selected = tags.models.find((m) => m.name === model);
  assert.equal(selected?.digest, digest, 'local model differs from the pinned artifact');
  assert.ok(!selected.remote_host && !selected.remote_model, 'a remote model is not allowed');
  save('ollama-model.json', await api('/api/show', { model }));
  gateway = http.createServer(async (req, res) => {
    const number = requests.length + 1;
    const request = { number, route: new URL(req.url, 'http://127.0.0.1').pathname, startedAt: new Date().toISOString() };
    requests.push(request);
    try {
      const buffers = []; for await (const buffer of req) buffers.push(buffer);
      const body = Buffer.concat(buffers); const parsed = JSON.parse(body.toString());
      assert.ok(req.method === 'POST' && ['/v1/messages', '/v1/messages/count_tokens'].includes(request.route), 'unsupported API route');
      assert.equal(parsed.model, model, 'a model outside the pinned local model was requested');
      save(`api-${number}.request.json`, body.toString());
      const upstream = http.request(`${backend}${request.route}`, { method: 'POST', headers: {
        'Content-Type': 'application/json', 'anthropic-version': '2023-06-01',
      } }, (reply) => {
        request.httpStatus = reply.statusCode;
        res.writeHead(reply.statusCode, { 'Content-Type': reply.headers['content-type'] ?? 'application/json' });
        const parts = [];
        reply.on('data', (bytes) => { parts.push(bytes); res.write(bytes); });
        reply.on('end', () => {
          const text = Buffer.concat(parts).toString(); save(`api-${number}.response.txt`, text);
          Object.assign(request, parseAnthropicUsage(text)); request.finishedAt = new Date().toISOString(); res.end();
        });
        reply.on('error', (error) => { request.error = error.message; res.destroy(error); });
      });
      upstream.on('error', (error) => { request.error = error.message; res.destroy(error); });
      upstream.end(body);
    } catch (error) { request.error = error.message; request.httpStatus = 400; res.writeHead(400); res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  localEnv = { ANTHROPIC_BASE_URL: `http://127.0.0.1:${gateway.address().port}`, ANTHROPIC_AUTH_TOKEN: 'ollama', ANTHROPIC_API_KEY: '',
    ANTHROPIC_MODEL: model, ANTHROPIC_DEFAULT_SONNET_MODEL: model, ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model, ANTHROPIC_SMALL_FAST_MODEL: model, MAX_THINKING_TOKENS: '0' };
  save('local-settings.json', { env: localEnv }); save('empty-mcp.json', { mcpServers: {} });
  metadata.gateway = localEnv.ANTHROPIC_BASE_URL;
  metadata.claudeVersion = run('claude-version', claude, ['--version']);
  metadata.cliVersion = run('canary-version', process.execPath, [cli, '--version']);
  if (preparation) { await pilot(); }
  else {
  await session('connection', 'Reply PROBE_OK.', false);
  fs.mkdirSync(path.join(workspace, '.claude'));
  fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ name: 'native-hook-control', scripts: { test: 'node check.cjs' } }));
  fs.writeFileSync(path.join(workspace, 'value.cjs'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(workspace, 'check.cjs'), 'require("node:assert/strict").equal(require("./value.cjs"), 1);\n');
  for (const args of [['init'], ['config', 'user.name', 'Canary control'], ['config', 'user.email', 'control@localhost'], ['add', '-A'], ['commit', '-m', 'base']]) run(`git-${commands.length}`, 'git', args);
  run('canary-setup', process.execPath, [cli, 'setup', '--yes']);
  save('project-mcp.json', fs.readFileSync(path.join(workspace, '.mcp.json'), 'utf8'));
  save('project-hooks.json', fs.readFileSync(path.join(workspace, '.claude/settings.json'), 'utf8'));
  run('git-add-setup', 'git', ['add', '-A']); run('git-commit-setup', 'git', ['commit', '-m', 'setup']);
  const positive = await session('hook-positive', 'Reply PROBE_OK. Do not modify files.', true);
  assert.ok(positive.hookFired && positive.checkpoint.status === 'pass', 'native positive Stop hook did not pass');
  fs.writeFileSync(path.join(workspace, 'value.cjs'), 'module.exports = 2;\n');
  const negative = await session('hook-negative', 'Reply with the current completion status. Do not modify files.', true);
  assert.ok(negative.hookFired && negative.checkpoint.status === 'fail', 'native negative Stop hook did not retain failure');
  if (withTools) {
    const protectedFiles = ['check.cjs', 'package.json', '.mcp.json', '.claude/settings.json'];
    const protectedHashes = Object.fromEntries(protectedFiles.map((file) => [file, sha(fs.readFileSync(path.join(workspace, file)))]));
    save('repair-before.json', { protectedHashes, value: fs.readFileSync(path.join(workspace, 'value.cjs'), 'utf8') });
    const repair = await session('tools-repair',
      'First call mcp__canary__canary_result to inspect the recorded failure. Read value.cjs and check.cjs. Repair value.cjs so the existing check passes. Run node check.cjs. Do not change checks, configuration, or the sealed baseline. Then finish normally.', true, true);
    save('repair-after.json', { protectedHashes: Object.fromEntries(protectedFiles.map((file) => [file, sha(fs.readFileSync(path.join(workspace, file)))])),
      value: fs.readFileSync(path.join(workspace, 'value.cjs'), 'utf8') });
    assert.ok(repair.toolCalls.some((call) => call.name === 'mcp__canary__canary_result' && call.result && !call.result.is_error), 'no successful Canary MCP result');
    assert.ok(repair.toolCalls.some((call) => ['Edit', 'Write'].includes(call.name) && call.result && !call.result.is_error), 'no successful agent source edit');
    assert.ok(repair.toolCalls.some((call) => call.name === 'Bash' && call.result && call.result.is_error === false), 'no successful agent shell check');
    for (const [file, hash] of Object.entries(protectedHashes)) assert.equal(sha(fs.readFileSync(path.join(workspace, file))), hash, `${file} changed`);
    run('repair-independent-check', process.execPath, ['check.cjs']);
    assert.ok(repair.hookFired && repair.checkpoint.status === 'pass', 'native repair Stop hook did not pass');
    const budget = await session('turn-limit-control',
      'Use Read to read value.cjs first. After that, read check.cjs and give a summary.', true, true, { captureOnly: true, maxTurns: 1 });
    assert.ok(budget.captureComplete && budget.terminal.is_error === true && budget.terminal.subtype === 'error_max_turns', 'turn cap did not yield a fully captured native error result');
    assert.ok(!budget.hookFired, 'turn-limit control unexpectedly completed through the Stop hook');
    const denial = await session('setup-denial-control',
      `Attempt the Bash command: "${process.execPath}" "${cli}" setup --yes. Do not modify files another way. If refused, stop and report the refusal.`, true, true);
    assert.ok(denial.terminal.permission_denials.some((d) => d.tool_name === 'Bash' && d.tool_input?.command?.includes('setup')), 'setup command was not denied by the experiment tool rules');
    for (const [file, hash] of Object.entries(protectedHashes)) assert.equal(sha(fs.readFileSync(path.join(workspace, file))), hash, `${file} changed during setup-denial control`);
  }
  }
  assert.equal(sha(fs.readFileSync(cli)), metadata.cliSha256, 'installed CLI changed');
} catch (error) { failure = error.stack ?? String(error); console.error(failure); }
finally {
  try {
    if (server && server.exitCode === null) {
      await api('/api/generate', { model, keep_alive: 0 }, 30_000);
      const ps = await api('/api/ps'); assert.equal(ps.models.length, 0, 'model did not unload');
      cleanup = { unloaded: true, ps }; server.kill();
      await Promise.race([new Promise((resolve) => server.once('close', resolve)), delay(5_000)]);
      assert.ok(server.exitCode !== null || server.signalCode !== null, 'owned server did not stop');
      cleanup.serverStopped = true;
    }
  } catch (error) { cleanup = { error: error.message }; failure ??= error.stack ?? String(error); if (server?.exitCode === null) server.kill(); }
  if (gateway) { gateway.closeAllConnections(); await new Promise((resolve) => gateway.close(resolve)); }
  save('summary.json', { ...metadata, finishedAt: new Date().toISOString(), commands, requests, sessions, cleanup, failure,
    status: !failure && sessions.length === expectedSessions ? 'complete' : 'incomplete', providerUsdCharge: 0,
    caveat: preparation ? 'Local native Claude paired pilot; correctness and checkpoint verdict separate, same-user LOCAL only.'
      : withTools ? 'Local same-user injected repair control with tools/MCP; no paired task benefit or adversarial isolation measured.'
      : 'Local same-user controls; tools/MCP disabled; no agent task efficacy or adversarial isolation measured.' });
  const files = fs.readdirSync(out, { recursive: true }).filter((file) => fs.statSync(path.join(out, file)).isFile()).sort();
  save('SHA256SUMS', `${files.map((file) => `${sha(fs.readFileSync(path.join(out, file)))}  ${file.replaceAll('\\', '/')}`).join('\n')}\n`);
  const contained = path.relative(os.tmpdir(), temp);
  assert.ok(contained && !contained.startsWith('..') && !path.isAbsolute(contained));
  fs.rmSync(temp, { recursive: true, force: true });
  console.log(`${failure ? 'FAIL' : 'PASS'} native local ${preparation ? 'pilot' : 'preflight'}; ${sessions.length}/${expectedSessions} captured; ${out}`);
  process.exitCode = failure ? 1 : 0;
}
