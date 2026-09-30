import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { canaryEvidenceStatus, canaryHookDecision, createVerificationTools, executeWorkspaceTool, hasOllamaNativeUsageEvidence, isCanaryStopGuard, ollamaResponseUsage, pilotSessionComplete, resolveWorkspacePath } from './v15-ollama-native-agent.mjs';

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
  assert.deepEqual(ollamaResponseUsage({ prompt_eval_count: 21, eval_count: 4 }), usage);
  assert.throws(() => ollamaResponseUsage({ prompt_eval_count: 21 }), /incomplete/);
  assert.throws(() => ollamaResponseUsage({ prompt_eval_count: NaN, eval_count: 4 }), /incomplete/);
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

test('final Canary evidence follows its current record and response, independently of earlier blocks', () => {
  const record = { source: 'checkpoint', status: 'pass' };
  assert.equal(canaryEvidenceStatus({ systemMessage: 'Canary: the sealed checks passed — with a caveat.' }, record), 'passed_with_evidence_caveat');
  assert.equal(canaryEvidenceStatus(null, record), 'passed');
  assert.equal(canaryEvidenceStatus({ reason: 'NOT PROVEN' }, record), 'unverified_or_unproven');
  assert.equal(canaryEvidenceStatus({ systemMessage: 'after one repair attempt. Stopping anyway.' }, { ...record, status: 'fail' }), 'stopped_after_repair_attempt');
  assert.equal(canaryEvidenceStatus(null, { source: 'doctor', status: 'pass' }), 'unknown');
});

const capturedSession = { protocol: 'ollama-native', runExitCode: 0, runTimeout: false,
  attemptStatus: 'complete', agentSessionOutcome: 'completed', correctnessStatus: 'pass', localModelUnload: { exitCode: 0 } };

test('a failed capture process cannot complete a pilot despite an earlier complete record', () => {
  assert.equal(pilotSessionComplete({ ...capturedSession, runExitCode: 1 }), false);
  assert.equal(pilotSessionComplete({ ...capturedSession, runExitCode: null, runTimeout: true }), false);
  assert.equal(pilotSessionComplete({ ...capturedSession, runTimeout: true }), false);
});

test('a captured incorrect solution remains a complete measurement; missing oracles do not', () => {
  assert.equal(pilotSessionComplete(capturedSession), true);
  assert.equal(pilotSessionComplete({ ...capturedSession, correctnessStatus: 'fail' }), true);
  assert.equal(pilotSessionComplete({ ...capturedSession, correctnessStatus: 'incomplete' }), false);
  assert.equal(pilotSessionComplete({ ...capturedSession, localModelUnload: { exitCode: 1 } }), false);
});

test('local agent executes only operator-listed checks and reads their complete saved output', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-ollama-checks-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'project');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'check.mjs'), 'console.log("x".repeat(18000)); console.error("ASSERTION FAILED"); process.exitCode = 1;');
  const checksFile = path.join(root, 'checks.json');
  fs.writeFileSync(checksFile, JSON.stringify({ checks: [{ id: 'test', executable: process.execPath, args: ['check.mjs'] }] }));
  const tools = createVerificationTools(workspace, checksFile, path.join(root, 'output'));
  assert.deepEqual(tools.execute('list_checks', {}).checks.map((c) => c.id), ['test']);
  assert.throws(() => tools.execute('run_check', { id: 'unlisted' }), /unknown check/);
  const result = tools.execute('run_check', { id: 'test', args: ['-e', 'process.exit(0)'] });
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stderr, 'ASSERTION FAILED\n');
  const tail = tools.execute('read_check_output', { path: result.stdoutPath, offset: 16000 });
  assert.equal(tail.totalChars, 18001);
  assert.equal(tail.content, `${'x'.repeat(2000)}\n`);
  assert.equal(tail.nextOffset, null);
  assert.throws(() => tools.execute('read_check_output', { path: checksFile }), /output/);
  assert.throws(() => tools.execute('read_check_output', { path: result.stdoutPath, offset: -1 }), /offset/);
});

test('Canary output is readable while authority and external linked files remain inaccessible', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-ollama-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'project');
  const bundle = path.join(workspace, '.canary', 'evidence', 'checkpoint');
  fs.mkdirSync(bundle, { recursive: true });
  fs.writeFileSync(path.join(bundle, '1-tests.log'), 'assertion detail');
  fs.writeFileSync(path.join(workspace, '.canary', 'canary.local.json'), 'sealed authority');
  const checksFile = path.join(root, 'checks.json');
  fs.writeFileSync(checksFile, JSON.stringify({ checks: [{ id: 'test', executable: process.execPath, args: ['--version'] }] }));
  const fakeCli = path.join(root, 'cli.mjs');
  fs.writeFileSync(fakeCli, 'console.log(JSON.stringify(process.argv.slice(2)));');
  const tools = createVerificationTools(workspace, checksFile, path.join(root, 'output'), { canaryCli: fakeCli });
  assert.deepEqual(JSON.parse(tools.execute('canary_doctor', { id: 'front end::test' }).stdout), ['doctor', '--json', '--check', 'front end::test']);
  assert.deepEqual(JSON.parse(tools.execute('canary_doctor', {}).stdout), ['doctor', '--json']);
  assert.equal(tools.execute('read_check_output', { path: path.join(bundle, '1-tests.log') }).content, 'assertion detail');
  assert.throws(() => tools.execute('read_check_output', { path: '.canary/canary.local.json' }), /output/);
  assert.throws(() => executeWorkspaceTool(workspace, 'write_file', { path: '.canary/evidence/checkpoint/1-tests.log', content: 'fake' }), /protected/);
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.log'), 'not evidence');
  fs.symlinkSync(outside, path.join(bundle, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => tools.execute('read_check_output', { path: path.join(bundle, 'linked', 'secret.log') }), /symbolic/);
  const plain = createVerificationTools(workspace, checksFile, path.join(root, 'plain-output'));
  assert.throws(() => plain.execute('read_check_output', { path: path.join(bundle, '1-tests.log') }), /output/);
  assert.throws(() => plain.execute('canary_doctor', {}), /unknown tool/);
});

test('local checks configuration and output directories must be outside the measured workspace', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-ollama-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'project');
  fs.mkdirSync(workspace);
  const checksFile = path.join(workspace, 'checks.json');
  fs.writeFileSync(checksFile, JSON.stringify({ checks: [{ id: 'test', executable: process.execPath, args: ['--version'] }] }));
  assert.throws(() => createVerificationTools(workspace, checksFile, path.join(root, 'output')), /outside/);
  fs.renameSync(checksFile, path.join(root, 'checks.json'));
  assert.throws(() => createVerificationTools(workspace, path.join(root, 'checks.json'), path.join(workspace, 'output')), /outside/);
});
