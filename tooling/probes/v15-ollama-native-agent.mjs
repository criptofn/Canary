#!/usr/bin/env node
/** Small, local-only tool loop for evaluating Ollama models without a provider adapter. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SKIP_DIRS = new Set(['.git', '.canary', '.claude', '.repowise', 'node_modules', '.gradle', 'build', 'dist']);
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOOL_CALLS = 24;
const totals = { inputTokens: 0, outputTokens: 0, toolCalls: 0, requests: 0, digest: null, started: Date.now(), checkpoints: [] };
let transcriptPath = null;

export function resolveWorkspacePath(workspace, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath.trim() || path.isAbsolute(relativePath)) {
    throw new Error('path must be a non-empty relative path');
  }
  const root = fs.realpathSync(workspace);
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);
  if (!relative || relative === '.' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('path must stay below the workspace root');
  }
  const segments = relative.split(path.sep);
  if (segments.some((segment) => SKIP_DIRS.has(segment.toLowerCase()))) {
    throw new Error('path points into a protected workspace directory');
  }
  let cursor = root;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('symbolic links are not accessible');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      break;
    }
  }
  return target;
}

function walkFiles(root, relative = '', out = []) {
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink() || (entry.isDirectory() && SKIP_DIRS.has(entry.name.toLowerCase()))) continue;
    const next = path.join(relative, entry.name);
    if (entry.isDirectory()) walkFiles(root, next, out);
    else if (entry.isFile()) out.push(next.split(path.sep).join('/'));
    if (out.length >= 800) return out;
  }
  return out;
}

export function executeWorkspaceTool(workspace, name, input) {
  if (name === 'list_files') return { files: walkFiles(workspace) };
  if (name === 'read_file') {
    const target = resolveWorkspacePath(workspace, input.path);
    const stat = fs.statSync(target);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error(`file is not regular or exceeds ${MAX_FILE_BYTES} bytes`);
    return { path: input.path, content: fs.readFileSync(target, 'utf8') };
  }
  if (name === 'write_file') {
    const target = resolveWorkspacePath(workspace, input.path);
    if (typeof input.content !== 'string' || Buffer.byteLength(input.content, 'utf8') > MAX_FILE_BYTES) {
      throw new Error(`content must be a string no larger than ${MAX_FILE_BYTES} bytes`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, input.content, 'utf8');
    return { path: input.path, bytes: Buffer.byteLength(input.content, 'utf8'), sha256: crypto.createHash('sha256').update(input.content).digest('hex') };
  }
  throw new Error(`unknown tool: ${name}`);
}

export function hasOllamaNativeUsageEvidence(usage, runtime) {
  const digest = runtime?.digest ?? runtime?.match?.digest;
  return usage !== null && typeof usage === 'object'
    && Number.isFinite(usage.input_tokens) && usage.input_tokens > 0
    && Number.isFinite(usage.output_tokens) && usage.output_tokens >= 0
    && /^[0-9a-f]{64}$/i.test(digest ?? '');
}

export function isCanaryStopGuard(response) {
  return typeof response?.systemMessage === 'string'
    && /after one repair attempt[\s\S]*stopping anyway/i.test(response.systemMessage);
}

export function canaryHookDecision(checkpoint, record) {
  if (checkpoint.exitCode !== 0 || (checkpoint.stdout && !checkpoint.response)) {
    throw new Error('Canary checkpoint did not return a valid hook response');
  }
  if (!checkpoint.stdout) {
    if (record?.source !== 'checkpoint' || record?.status !== 'pass') {
      throw new Error('Canary was silent without a passing checkpoint');
    }
    return 'allow';
  }
  return checkpoint.response.decision ?? null;
}

const TOOL_DEFINITIONS = [
  { type: 'function', function: { name: 'list_files', description: 'List project files. Generated, dependency, and protected Canary state directories are omitted.', parameters: { type: 'object', properties: {}, additionalProperties: false } } },
  { type: 'function', function: { name: 'read_file', description: 'Read one UTF-8 project file by relative path.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } } },
  { type: 'function', function: { name: 'write_file', description: 'Create or replace one UTF-8 project file by relative path.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false } } },
];

function emit(event) {
  const line = `${JSON.stringify(event)}\n`;
  process.stdout.write(line);
  if (transcriptPath) fs.appendFileSync(transcriptPath, line);
}
function cliArg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
}
function modelDigest(tags, model) {
  const match = (tags.models ?? []).find((entry) => entry.name === model || entry.model === model);
  return match?.digest ?? null;
}

async function main() {
  const model = cliArg('model', 'qwen3.5:9b');
  const workspaceArg = cliArg('workspace', process.cwd());
  const promptFile = cliArg('prompt-file');
  const arm = cliArg('arm', 'plain');
  const canaryCli = cliArg('canary-cli');
  const sessionId = cliArg('session-id', 'ollama-native-session');
  const transcriptArg = cliArg('transcript-path');
  const maxRequests = Number(cliArg('max-requests', '24'));
  const apiUrl = process.env.OLLAMA_API_URL ?? 'http://127.0.0.1:11434/api/chat';
  if (!promptFile || !fs.existsSync(promptFile) || !Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > MAX_TOOL_CALLS) {
    throw new Error('usage: --prompt-file <file> [--workspace <directory>] [--model <local model>] [--max-requests 1..24]');
  }
  const workspace = fs.realpathSync(workspaceArg);
  if (!['plain', 'canary'].includes(arm)) throw new Error('arm must be plain or canary');
  if (arm === 'canary') {
    if (!canaryCli || !fs.statSync(canaryCli, { throwIfNoEntry: false })?.isFile() || !transcriptArg) {
      throw new Error('the Canary arm requires --canary-cli and --transcript-path');
    }
    transcriptPath = path.resolve(transcriptArg);
    const relativeTranscript = path.relative(workspace, transcriptPath);
    if (!relativeTranscript.startsWith(`..${path.sep}`) && relativeTranscript !== '..' && !path.isAbsolute(relativeTranscript)) {
      throw new Error('transcript path must remain outside the measured workspace');
    }
    if (!fs.statSync(transcriptPath, { throwIfNoEntry: false })?.isFile()) throw new Error('transcript file must be pre-created by the probe');
  }
  const endpoint = new URL(apiUrl);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) throw new Error('OLLAMA_API_URL must point to this machine');
  const prompt = fs.readFileSync(promptFile, 'utf8').trim();
  if (!prompt) throw new Error('prompt file is empty');
  const tagsResponse = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(5_000) });
  if (!tagsResponse.ok) throw new Error(`local Ollama model inventory returned HTTP ${tagsResponse.status}`);
  const digest = modelDigest(await tagsResponse.json(), model);
  if (!/^[0-9a-f]{64}$/i.test(digest ?? '')) throw new Error(`requested local Ollama model is not installed: ${model}`);
  totals.digest = digest;

  const messages = [
    { role: 'system', content: 'You are a coding agent working in one disposable project copy. Use the available tools to inspect and change files. Make the smallest correct change that satisfies the request and preserves unrelated behavior. Do not claim a change unless you made it with a tool. Do not edit .git, .canary, dependency, generated, or unrelated files. When finished, give a short factual summary.' },
    { role: 'user', content: prompt },
  ];
  emit({ type: 'system', subtype: 'init', model, local_model_digest: digest, workspace });

  for (; totals.requests < maxRequests; totals.requests++) {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages, tools: TOOL_DEFINITIONS, stream: false, options: { temperature: 0, num_ctx: 8192 }, keep_alive: '5m' }),
      signal: AbortSignal.timeout(600_000),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(`local Ollama chat returned HTTP ${response.status}: ${JSON.stringify(body).slice(0, 1000)}`);
    const assistant = body.message;
    if (!assistant || assistant.role !== 'assistant') throw new Error('local Ollama response has no assistant message');
    totals.inputTokens += Number.isFinite(body.prompt_eval_count) ? body.prompt_eval_count : 0;
    totals.outputTokens += Number.isFinite(body.eval_count) ? body.eval_count : 0;
    const calls = Array.isArray(assistant.tool_calls) ? assistant.tool_calls : [];
    const text = typeof assistant.content === 'string' ? assistant.content : '';
    const content = [];
    if (text) content.push({ type: 'text', text });
    for (const [index, call] of calls.entries()) {
      content.push({ type: 'tool_use', id: call.id ?? `ollama-${totals.requests}-${index}`, name: call.function?.name ?? '', input: call.function?.arguments ?? {} });
    }
    emit({ type: 'assistant', message: { role: 'assistant', model, content, usage: { input_tokens: body.prompt_eval_count ?? 0, output_tokens: body.eval_count ?? 0 } } });
    messages.push(assistant);
    if (calls.length === 0) {
      if (arm === 'canary') {
        const hookInput = {
          session_id: sessionId,
          transcript_path: transcriptPath,
          cwd: workspace,
          hook_event_name: 'Stop',
          stop_hook_active: totals.checkpoints.length > 0,
        };
        const checkpointRun = spawnSync(process.execPath, [canaryCli, 'checkpoint'], {
          cwd: workspace, input: JSON.stringify(hookInput), encoding: 'utf8', timeout: 1_800_000,
          windowsHide: true, maxBuffer: 32 * 1024 * 1024,
        });
        const checkpoint = {
          input: hookInput,
          exitCode: checkpointRun.status ?? null,
          stdout: (checkpointRun.stdout ?? '').trim(),
          stderr: (checkpointRun.stderr ?? '').trim(),
        };
        try { checkpoint.response = checkpoint.stdout ? JSON.parse(checkpoint.stdout) : null; } catch { checkpoint.response = null; }
        totals.checkpoints.push(checkpoint);
        emit({ type: 'system', subtype: 'canary_checkpoint', checkpoint });
        let checkpointRecord = null;
        try { checkpointRecord = JSON.parse(fs.readFileSync(path.join(workspace, '.canary', 'last-checkpoint.json'), 'utf8')); } catch { /* checked below for silent allow */ }
        const decision = canaryHookDecision(checkpoint, checkpointRecord);
        if (isCanaryStopGuard(checkpoint.response)) {
          emit({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'canary_stop_guard', usage: { input_tokens: totals.inputTokens, output_tokens: totals.outputTokens, cached_input_tokens: 0, reasoning_output_tokens: 0 }, num_turns: totals.requests + 1, duration_ms: Date.now() - totals.started, total_cost_usd: null, local_model_digest: digest, tool_calls: totals.toolCalls, manual_checkpoints: totals.checkpoints });
          return;
        }
        if (decision === 'block' && totals.checkpoints.length === 1) {
          const feedback = `Stop hook feedback: ${checkpoint.response.systemMessage ?? checkpoint.response.reason ?? checkpoint.stdout}`;
          messages.push({ role: 'user', content: feedback });
          emit({ type: 'user', message: { role: 'user', content: feedback } });
          continue;
        }
        if (decision === 'block' && totals.checkpoints.length > 1) throw new Error('Canary still blocked after the single allowed repair pass');
        if (decision !== 'allow' && !checkpoint.response?.systemMessage) throw new Error(`Canary returned unexpected completion decision: ${String(decision)}`);
      }
      emit({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', usage: { input_tokens: totals.inputTokens, output_tokens: totals.outputTokens, cached_input_tokens: 0, reasoning_output_tokens: 0 }, num_turns: totals.requests + 1, duration_ms: Date.now() - totals.started, total_cost_usd: null, local_model_digest: digest, tool_calls: totals.toolCalls, manual_checkpoints: totals.checkpoints });
      return;
    }

    for (const [index, call] of calls.entries()) {
      totals.toolCalls++;
      if (totals.toolCalls > MAX_TOOL_CALLS) throw new Error(`tool-call limit reached (${MAX_TOOL_CALLS})`);
      const name = call.function?.name;
      let result;
      try {
        const input = typeof call.function?.arguments === 'string' ? JSON.parse(call.function.arguments) : (call.function?.arguments ?? {});
        result = executeWorkspaceTool(workspace, name, input);
      } catch (error) {
        result = { error: String(error?.message ?? error) };
      }
      const toolResult = JSON.stringify(result);
      messages.push({ role: 'tool', tool_name: name, content: toolResult });
      emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id ?? `ollama-${totals.requests}-${index}`, content: toolResult }] } });
    }
  }
  throw new Error(`model did not finish within ${maxRequests} local API requests`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--version')) {
    process.stdout.write('ollama-native-agent 1.0.0\n');
    process.exit(0);
  }
  main().catch((error) => {
    console.error(String(error?.stack ?? error));
    emit({ type: 'result', subtype: 'error', is_error: true, stop_reason: 'error', usage: { input_tokens: totals.inputTokens, output_tokens: totals.outputTokens, cached_input_tokens: 0, reasoning_output_tokens: 0 }, num_turns: totals.requests, duration_ms: Date.now() - totals.started, total_cost_usd: null, local_model_digest: totals.digest, tool_calls: totals.toolCalls, manual_checkpoints: totals.checkpoints });
    process.exitCode = 1;
  });
}
