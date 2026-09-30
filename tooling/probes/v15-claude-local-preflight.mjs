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
import { parseAnthropicUsage } from './v15-anthropic-usage.mjs';

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? null : process.argv[i + 1]; };
const cli = arg('cli'), claude = arg('claude'), ollama = arg('ollama'), out = arg('out');
for (const [name, value] of Object.entries({ cli, claude, ollama, out })) assert.ok(value && path.isAbsolute(value), `absolute --${name} required`);
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
});
const metadata = { startedAt: new Date().toISOString(), node: process.version, model, modelDigest: digest,
  cli, cliSha256: sha(fs.readFileSync(cli)), claude, claudeSha256: sha(fs.readFileSync(claude)),
  ollama, ollamaSha256: sha(fs.readFileSync(ollama)), backend, contextLength: 65536,
  instrumentSha256: sha(fs.readFileSync(fileURLToPath(import.meta.url))), workspace, profile };
save('instrument.mjs', fs.readFileSync(fileURLToPath(import.meta.url), 'utf8'));
save('v15-anthropic-usage.mjs', fs.readFileSync(new URL('./v15-anthropic-usage.mjs', import.meta.url), 'utf8'));
metadata.usageParserSha256 = sha(fs.readFileSync(new URL('./v15-anthropic-usage.mjs', import.meta.url)));
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
async function session(name, prompt, hooks) {
  const dir = path.join(out, name); fs.mkdirSync(dir);
  const checkpointFile = path.join(workspace, '.canary/last-checkpoint.json');
  const before = fs.existsSync(checkpointFile) ? fs.readFileSync(checkpointFile, 'utf8') : null;
  const start = requests.length;
  const args = ['-p', prompt, '--model', model, '--settings', path.join(out, 'local-settings.json'),
    '--setting-sources', hooks ? 'project,local' : '', '--tools', '', '--strict-mcp-config',
    '--mcp-config', path.join(out, 'empty-mcp.json'), '--output-format', 'stream-json', '--verbose',
    '--system-prompt', 'Reply with one short sentence. This is a local completion-hook control. No tools are available.'];
  let stdout = '', stderr = '', timedOut = false;
  const startedAt = new Date().toISOString();
  const child = spawn(claude, args, { cwd: workspace, env: { ...safeEnv, ...localEnv }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const finished = new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
  });
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', (text) => { stdout += text; fs.appendFileSync(path.join(dir, 'claude.jsonl'), text); });
  child.stderr.on('data', (text) => { stderr += text; fs.appendFileSync(path.join(dir, 'claude.stderr.txt'), text); });
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 180_000);
  let result;
  try { result = await finished; } finally { clearTimeout(timer); }
  const events = stdout.split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  const terminal = events.findLast((event) => event.type === 'result');
  const after = fs.existsSync(checkpointFile) ? fs.readFileSync(checkpointFile, 'utf8') : null;
  const checkpoint = after ? JSON.parse(after) : null;
  const calls = requests.slice(start).filter((r) => r.route === '/v1/messages');
  const nativeComplete = calls.length > 0 && calls.every((r) => r.httpStatus === 200 && r.complete
    && Number.isSafeInteger(r.usage.input_tokens) && r.usage.input_tokens >= 0
    && Number.isSafeInteger(r.usage.output_tokens) && r.usage.output_tokens >= 0);
  const nativeUsage = nativeComplete ? calls.reduce((sum, r) => ({ input_tokens: sum.input_tokens + r.usage.input_tokens,
    output_tokens: sum.output_tokens + r.usage.output_tokens }), { input_tokens: 0, output_tokens: 0 }) : null;
  const accountingMatches = nativeUsage !== null && terminal?.usage?.input_tokens === nativeUsage.input_tokens
    && terminal?.usage?.output_tokens === nativeUsage.output_tokens;
  const record = { name, args, startedAt, finishedAt: new Date().toISOString(), ...result, timedOut,
    terminal: terminal ?? null, nativeUsage, accountingMatches, calls: calls.map((r) => r.number),
    checkpoint, checkpointChanged: after !== before, hookFired: after !== before && checkpoint?.source === 'checkpoint',
    modelRuntime: await api('/api/ps') };
  fs.writeFileSync(path.join(dir, 'record.json'), `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
  const evidence = path.join(workspace, '.canary/evidence');
  if (hooks && fs.existsSync(evidence)) fs.cpSync(evidence, path.join(dir, 'product-evidence'), { recursive: true });
  sessions.push(record);
  console.log(`OBSERVED ${name}: exit=${result.exitCode}, nativeUsage=${JSON.stringify(nativeUsage)}, accountingMatches=${accountingMatches}, hook=${record.hookFired}, status=${checkpoint?.status ?? 'none'}`);
  assert.equal(result.exitCode, 0, `${name}: CLI failed`); assert.ok(!timedOut, `${name}: timeout`);
  assert.ok(terminal && !terminal.is_error, `${name}: no successful terminal event`);
  assert.ok(nativeComplete, `${name}: missing native API usage`);
  assert.ok(accountingMatches, `${name}: CLI usage differs from the captured API usage`);
  return record;
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
  await session('connection', 'Reply PROBE_OK.', false);
  fs.mkdirSync(path.join(workspace, '.claude'));
  fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ name: 'native-hook-control', scripts: { test: 'node check.cjs' } }));
  fs.writeFileSync(path.join(workspace, 'value.cjs'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(workspace, 'check.cjs'), 'require("node:assert/strict").equal(require("./value.cjs"), 1);\n');
  for (const args of [['init'], ['config', 'user.name', 'Canary control'], ['config', 'user.email', 'control@localhost'], ['add', '-A'], ['commit', '-m', 'base']]) run(`git-${commands.length}`, 'git', args);
  run('canary-setup', process.execPath, [cli, 'setup', '--yes']);
  run('git-add-setup', 'git', ['add', '-A']); run('git-commit-setup', 'git', ['commit', '-m', 'setup']);
  const positive = await session('hook-positive', 'Reply PROBE_OK. Do not modify files.', true);
  assert.ok(positive.hookFired && positive.checkpoint.status === 'pass', 'native positive Stop hook did not pass');
  fs.writeFileSync(path.join(workspace, 'value.cjs'), 'module.exports = 2;\n');
  const negative = await session('hook-negative', 'Reply with the current completion status. Do not modify files.', true);
  assert.ok(negative.hookFired && negative.checkpoint.status === 'fail', 'native negative Stop hook did not retain failure');
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
    status: !failure && sessions.length === 3 ? 'complete' : 'incomplete', providerUsdCharge: 0,
    caveat: 'Local same-user controls; tools/MCP disabled; no agent task efficacy or adversarial isolation measured.' });
  const files = fs.readdirSync(out, { recursive: true }).filter((file) => fs.statSync(path.join(out, file)).isFile()).sort();
  save('SHA256SUMS', `${files.map((file) => `${sha(fs.readFileSync(path.join(out, file)))}  ${file.replaceAll('\\', '/')}`).join('\n')}\n`);
  const contained = path.relative(os.tmpdir(), temp);
  assert.ok(contained && !contained.startsWith('..') && !path.isAbsolute(contained));
  fs.rmSync(temp, { recursive: true, force: true });
  console.log(`${failure ? 'FAIL' : 'PASS'} native local preflight; ${sessions.length}/3 captured; ${out}`);
  process.exitCode = failure ? 1 : 0;
}
