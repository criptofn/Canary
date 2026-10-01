#!/usr/bin/env node
/** Audit recorded auxiliary usage and add explicitly post-pilot fractional-age controls. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { claudeUsageMatchesNative } from './v15-anthropic-usage.mjs';
const arg = (key) => { const i = process.argv.indexOf(`--${key}`); return i < 0 ? null : process.argv[i + 1]; };
const evidence = arg('evidence'), out = arg('out');
assert.ok(evidence && out && path.isAbsolute(evidence) && path.isAbsolute(out) && !fs.existsSync(out));
fs.mkdirSync(out, { recursive: true });
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const read = (file) => JSON.parse(fs.readFileSync(path.join(evidence, file), 'utf8'));
const save = (file, value) => fs.writeFileSync(path.join(out, file), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
const summary = read('summary.json');
const oracle = path.resolve(import.meta.dirname, 'v15-validation-oracle.mjs');
for (const file of [fileURLToPath(import.meta.url), oracle, path.resolve(import.meta.dirname, 'v15-anthropic-usage.mjs')]) fs.copyFileSync(file, path.join(out, path.basename(file)));
const audited = summary.sessions.map((record) => ({ name: record.name,
  matchesAllModelUsage: claudeUsageMatchesNative(record.terminal, record.nativeUsage, summary.model),
  mainUsage: record.terminal?.usage ?? null, modelUsage: record.terminal?.modelUsage ?? null, nativeUsage: record.nativeUsage }));
assert.ok(audited.every((record) => record.matchesAllModelUsage), 'not all recorded native totals reconcile');
const r1 = summary.sessions.find((r) => r.name === 'R1-canary'); assert.ok(r1);
const omitted = { input_tokens: r1.nativeUsage.input_tokens - r1.terminal.usage.input_tokens,
  output_tokens: r1.nativeUsage.output_tokens - r1.terminal.usage.output_tokens };
const matching = summary.requests.filter((r) => r1.calls.includes(r.number) && r.usage.input_tokens === omitted.input_tokens && r.usage.output_tokens === omitted.output_tokens);
assert.equal(matching.length, 1, 'the auxiliary request cannot be identified uniquely');
const number = matching[0].number;
const request = read(`api-${number}.request.json`);
const lastMessage = JSON.stringify(request.messages.at(-1));
const events = fs.readFileSync(path.join(evidence, 'R1-canary/claude.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
const compactEvents = events.filter((event) => event.subtype === 'compact_boundary');
const requestElapsedMs = Date.parse(matching[0].finishedAt) - Date.parse(matching[0].startedAt);
assert.ok(compactEvents.some((event) => Math.abs(event.compact_metadata.duration_ms - requestElapsedMs) < 5000), 'matching compaction timing not observed');
save('accounting-audit.json', { audited, omitted, requestNumber: number, compactEvents,
  auxiliaryRequestLastMessage: lastMessage, requestElapsedMs, requestSha256: hash(fs.readFileSync(path.join(evidence, `api-${number}.request.json`))),
  responseSha256: hash(fs.readFileSync(path.join(evidence, `api-${number}.response.txt`))) });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-native-age-control-'));
const controls = [];
try {
  const canary = summary.sessions.find((r) => r.name === 'H1-canary'); assert.ok(canary);
  const preparation = read('preparation-summary.json');
  const base = preparation.records.find((r) => r.label === 'H1' && r.arm === 'canary').source.baseCommit;
  const old = spawnSync('git', ['-C', canary.cwd, 'show', `${base}:src/workflows/fileOrganizer.js`], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  assert.equal(old.status, 0);
  const marker = 'if (options.maxAgeDays && ageDays > options.maxAgeDays) continue;';
  assert.equal(old.stdout.split(marker).length, 2);
  for (const [name, source] of [['baseline', old.stdout], ['golden', old.stdout.replace(marker, 'if (typeof options.maxAgeDays === "number" && ageDays > options.maxAgeDays) continue;')]]) {
    const repo = path.join(temp, name); fs.mkdirSync(path.join(repo, 'src/workflows'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'package.json'), '{"type":"module"}\n');
    fs.writeFileSync(path.join(repo, 'src/workflows/fileOrganizer.js'), source);
  }
  const run = (name, repo, strictAge) => {
    const args = [oracle, '--label', 'H1', '--repo', repo, '--expected', 'pass', '--out', path.join(out, name)];
    if (strictAge) args.push('--strict-age');
    const r = spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true, timeout: 120000 });
    save(`${name}-process.json`, { args, exitCode: r.status, error: r.error?.message ?? null, stdout: r.stdout, stderr: r.stderr });
    const result = JSON.parse(fs.readFileSync(path.join(out, name, 'oracle-result.json'), 'utf8'));
    controls.push({ name, strictAge, testPassed: result.testPassed, resultDirectory: path.join(out, name) });
    return result;
  };
  assert.equal(run('baseline-strict', path.join(temp, 'baseline'), true).testPassed, false);
  assert.equal(run('golden-strict', path.join(temp, 'golden'), true).testPassed, true);
  for (const arm of ['plain', 'canary']) {
    const record = summary.sessions.find((r) => r.name === `H1-${arm}`); assert.ok(record);
    const original = read(`oracle-H1-${arm}-final/oracle-result.json`);
    assert.equal(hash(fs.readFileSync(path.join(record.cwd, 'src/workflows/fileOrganizer.js'))), original.sourceFiles[0].sha256, 'worker source changed after capture');
    assert.equal(run(`H1-${arm}-original`, record.cwd, false).testPassed, true);
    run(`H1-${arm}-strict`, record.cwd, true);
  }
  assert.equal(controls.find((c) => c.name === 'H1-canary-strict').testPassed, false, 'rounding error was not observed');
  save('followup-summary.json', { status: 'complete', controls, accountingAudited: audited.length,
    evidence, oracleSha256: hash(fs.readFileSync(oracle)), note: 'Additional H1 cases are post-pilot checks, not predeclared pilot oracle results. Original outcomes remain unchanged.' });
} finally {
  const relative = path.relative(os.tmpdir(), temp); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  fs.rmSync(temp, { recursive: true, force: true });
}
const files = fs.readdirSync(out, { recursive: true }).filter((file) => fs.statSync(path.join(out, file)).isFile()).sort();
save('SHA256SUMS', `${files.map((file) => `${hash(fs.readFileSync(path.join(out, file)))}  ${file.replaceAll('\\', '/')}`).join('\n')}\n`);
console.log(`PASS follow-up: ${audited.length} native ledgers; auxiliary request ${number}; H1 controls ${JSON.stringify(controls.map(({ name, testPassed }) => ({ name, testPassed })))}`);
