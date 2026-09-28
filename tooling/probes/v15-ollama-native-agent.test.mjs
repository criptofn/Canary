import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { canaryHookDecision, executeWorkspaceTool, hasOllamaNativeUsageEvidence, isCanaryStopGuard, resolveWorkspacePath } from './v15-ollama-native-agent.mjs';

test('native local agent reads and writes only files below its workspace', (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-ollama-agent-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, 'target.txt'), 'OLD');

  const read = executeWorkspaceTool(workspace, 'read_file', { path: 'target.txt' });
  assert.equal(read.content, 'OLD');
  const written = executeWorkspaceTool(workspace, 'write_file', { path: 'src/target.txt', content: 'NEW' });
  assert.equal(written.bytes, 3);
  assert.equal(fs.readFileSync(path.join(workspace, 'src', 'target.txt'), 'utf8'), 'NEW');
  assert.throws(() => resolveWorkspacePath(workspace, '../outside.txt'), /stay below/);
  assert.throws(() => resolveWorkspacePath(workspace, '.canary/plan.json'), /protected/);
});

test('native local agent file listing excludes private and generated project state', (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-ollama-list-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  for (const directory of ['src', '.canary', '.git', 'node_modules', 'build']) fs.mkdirSync(path.join(workspace, directory));
  fs.writeFileSync(path.join(workspace, 'src', 'main.js'), 'export {};');
  for (const directory of ['.canary', '.git', 'node_modules', 'build']) fs.writeFileSync(path.join(workspace, directory, 'hidden.txt'), 'private');

  const { files } = executeWorkspaceTool(workspace, 'list_files', {});
  assert.deepEqual(files, ['src/main.js']);
});

test('native Ollama usage needs actual token counts and a model digest', () => {
  const usage = { input_tokens: 21, output_tokens: 4 };
  const digest = 'a'.repeat(64);
  assert.equal(hasOllamaNativeUsageEvidence(usage, { match: { digest } }), true);
  assert.equal(hasOllamaNativeUsageEvidence({ ...usage, input_tokens: 0 }, { digest }), false);
  assert.equal(hasOllamaNativeUsageEvidence(usage, { digest: 'missing' }), false);
});

test('a Canary one-repair stop guard ends the agent session without claiming a pass', () => {
  assert.equal(isCanaryStopGuard({ systemMessage: 'Canary: NOT PROVEN — after one repair attempt. Stopping anyway.' }), true);
  assert.equal(isCanaryStopGuard({ decision: 'allow', systemMessage: 'Checks passed.' }), false);
});

test('silent Canary hook output allows only a recorded pass', () => {
  assert.equal(canaryHookDecision({ exitCode: 0, stdout: '', response: null }, { source: 'checkpoint', status: 'pass' }), 'allow');
  assert.throws(() => canaryHookDecision({ exitCode: 0, stdout: '', response: null }, { source: 'checkpoint', status: 'fail' }), /without a passing checkpoint/);
  assert.throws(() => canaryHookDecision({ exitCode: 0, stdout: '', response: null }, null), /without a passing checkpoint/);
  assert.equal(canaryHookDecision({ exitCode: 0, stdout: '{"decision":"block"}', response: { decision: 'block' } }, null), 'block');
});
