#!/usr/bin/env node
/** Observe a failed external baseline assertion; restore the owned copy byte-for-byte. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? null : process.argv[i + 1]; };
const attemptFile = arg('attempt'), out = arg('out');
assert.ok([attemptFile, out].every((file) => file && path.isAbsolute(file)) && !fs.existsSync(out));
const attempt = JSON.parse(fs.readFileSync(attemptFile, 'utf8'));
const repo = fs.realpathSync.native(attempt.repo);
const relative = path.relative(fs.realpathSync.native(os.tmpdir()), repo);
assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative));
assert.match(relative.split(path.sep)[0], /^canary-improved-six-task-/);
assert.equal(path.basename(repo), 'plain'); assert.equal(attempt.label, 'R1');
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
let env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|AUTH|CLAUDE|OPENAI|ANTHROPIC|CODEX)/i.test(key)));
env.CANARY_TRUST_STORE = attempt.trustStore;
env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
env.PATH = [...attempt.toolchainDirectories, process.env.PATH ?? ''].filter(Boolean).join(path.delimiter);
const sanitized = process.argv.includes('--sanitized');
const environmentProgram = new URL('../../packages/support/dist/src/index.js', import.meta.url);
let environmentProgramSha256 = null;
if (sanitized) {
  const { sanitizedEnv } = await import(environmentProgram.href);
  environmentProgramSha256 = hash(fs.readFileSync(environmentProgram));
  env = sanitizedEnv({ ws: { root: os.tmpdir(), fixture: repo }, nodeDir: path.dirname(process.execPath), extraPathDirs: attempt.toolchainDirectories });
}
const git = (...args) => {
  const result = spawnSync('git', ['-C', repo, ...args], { env, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  assert.equal(result.status, 0); return result.stdout.trim();
};
assert.equal(git('rev-parse', 'HEAD'), attempt.expectedHead);
assert.equal(git('status', '--porcelain'), '');
const workerTrace = process.argv.includes('--worker-trace');
const testFile = path.join(repo, workerTrace ? 'node_modules/tinypool/dist/index.js' : 'tests/integration/verify-diff.test.ts');
const original = fs.readFileSync(testFile), text = original.toString('utf8');
const title = 'a changed BLANK line does not make an untested change read as covered';
let instrumented;
if (workerTrace) {
  const send = 'if (!this.isTerminating) this.process.send(message);';
  const exit = 'this.process.on("exit", this.onUnexpectedExit);';
  assert.equal(text.split(send).length, 2);
  assert.equal(text.split(exit).length, 2);
  instrumented = text.replace(exit, `${exit}\nthis.process.on("exit", (code, signal) => console.error("CANARY_OPERATOR_WORKER_EXIT", JSON.stringify({pid:this.process.pid, code, signal, terminating:this.isTerminating})));`)
    .replace(send, `if (!this.isTerminating) { if (!this.process.connected) console.error("CANARY_OPERATOR_WORKER_DISCONNECTED_SEND", JSON.stringify({pid:this.process.pid, exitCode:this.process.exitCode, signalCode:this.process.signalCode, connected:this.process.connected})); this.process.send(message); }`);
} else {
const start = text.indexOf(`'${title}'`), end = text.indexOf('    it.skipIf(NO_COVERAGE)', start);
assert.ok(start >= 0 && end > start);
const block = text.slice(start, end);
const assertion = "        expect(report.coverage.uncovered).toEqual([{ file: 'mod.py', line: 12 }]);";
assert.equal(block.split(assertion).length, 2, 'pin the existing assertion; never remove or replace it');
instrumented = text.slice(0, start) + block.replace(assertion,
  `        console.log('CANARY_OPERATOR_BASELINE_REPORT', JSON.stringify(report));\n${assertion}`) + text.slice(end);
}
fs.mkdirSync(out);
fs.copyFileSync(import.meta.filename, path.join(out, 'instrument.mjs'), fs.constants.COPYFILE_EXCL);
fs.writeFileSync(path.join(out, 'original-test.ts'), original, { flag: 'wx' });
const full = workerTrace || process.argv.includes('--full');
const npm = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const args = [npm, 'run', 'test', ...(full ? [] : ['--', '--testNamePattern', title])];
const metadata = { repo, baseline: attempt.expectedHead, full, workerTrace, sanitized, environmentProgramSha256, instrumentedFile: testFile, executable: process.execPath, args,
  projectScript: JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).scripts.test,
  originalTestSha256: hash(original), instrumentedTestSha256: hash(instrumented),
  instrumentSha256: hash(fs.readFileSync(import.meta.filename)), attemptSha256: hash(fs.readFileSync(attemptFile)),
  toolchainDirectories: attempt.toolchainDirectories, environmentKeyNames: Object.keys(env).sort(),
  startedAt: new Date().toISOString(), scope: 'external project diagnostic, not a Canary verdict or agent session' };
let result, failure = null;
try {
  fs.writeFileSync(testFile, instrumented);
  result = spawnSync(process.execPath, args, { cwd: repo, env, encoding: 'utf8', windowsHide: true, timeout: full ? 300000 : 180000, maxBuffer: 16 * 1024 * 1024 });
  fs.writeFileSync(path.join(out, 'stdout.log'), result.stdout ?? '');
  fs.writeFileSync(path.join(out, 'stderr.log'), result.stderr ?? '');
  assert.equal(result.error, undefined);
} catch (error) { failure = error.stack ?? String(error); }
finally {
  fs.writeFileSync(testFile, original);
  assert.equal(hash(fs.readFileSync(testFile)), hash(original));
  assert.equal(git('status', '--porcelain'), '');
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ ...metadata, finishedAt: new Date().toISOString(),
    exitCode: result?.status ?? null, signal: result?.signal ?? null, error: result?.error?.message ?? null, failure,
    originalRestored: true, stdoutSha256: hash(result?.stdout ?? ''), stderrSha256: hash(result?.stderr ?? '') }, null, 2));
}
console.log(`${!failure && result?.status === 0 ? 'PASS' : 'FAIL'} external project diagnostic; original test restored; ${out}`);
process.exitCode = failure ? 1 : result?.status === 0 ? 0 : 1;
