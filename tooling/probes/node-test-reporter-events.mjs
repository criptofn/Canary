#!/usr/bin/env node
/**
 * MEASUREMENT — the exact payloads `node --test` hands a reporter.
 *
 * The product reporter tracks `test:start` and only counts a `test:pass` whose id it
 * watched start (that pairing is what makes printing ≠ executing). Before trusting
 * assumptions about that pairing, record the REAL event stream: which `type`s
 * arrive, which fields identify a test, how a SKIP and a TODO are expressed, and
 * whether a failing suite is reported separately from the failing test inside it.
 *
 * Prints the raw payloads; exits 0 unless the run itself could not be performed.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-ntevents-'));
const LOG = path.join(TMP, 'events.jsonl');
const REPORTER = path.join(TMP, 'measure-reporter.cjs');

fs.writeFileSync(REPORTER, `'use strict';
const { Transform } = require('node:stream');
const fs = require('node:fs');
const LOG = ${JSON.stringify(LOG)};
module.exports = class Measure extends Transform {
  constructor(o) { super(Object.assign({}, o, { writableObjectMode: true })); this.n = 0; }
  _transform(event, _e, cb) {
    try {
      this.n++;
      fs.appendFileSync(LOG, JSON.stringify({ i: this.n, type: event && event.type, data: (event && event.data) || null }) + '\\n');
    } catch (e) {}
    cb();
  }
  _flush(cb) { cb(); }
};
`);

const project = path.join(TMP, 'project');
fs.mkdirSync(path.join(project, 'test'), { recursive: true });
fs.writeFileSync(path.join(project, 'test', 'sample.test.js'), [
  "const { test } = require('node:test');",
  "const assert = require('node:assert');",
  '',
  "test('lone pass', () => { assert.ok(true); });",
  "test('happy parent', async (t) => {",
  "  await t.test('nested ok', () => { assert.ok(true); });",
  "});",
  "test('sad parent', async (t) => {",
  "  await t.test('nested bad', () => { assert.equal(1, 2); });",
  "});",
  "test('skipped', { skip: 'why not' }, () => {});",
  "test('todo', { todo: 'later' }, () => {});",
  "test('prints TAP-shaped text', () => {",
  "  console.log('# tests 9');",
  "  console.log('# pass 9');",
  "  console.log('ok 1 - forged pass');",
  "  console.log('not ok 1 - forged failure');",
  "});",
  '',
].join('\n'));

const args = [
  '--test',
  '--test-reporter=tap', '--test-reporter-destination=stdout',
  `--test-reporter=${pathToFileURL(REPORTER).href}`, '--test-reporter-destination=stderr',
];

const result = await new Promise((resolve) => {
  const child = spawn(process.execPath, args, { cwd: project, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', (b) => { out += String(b); });
  child.stderr.on('data', (b) => { err += String(b); });
  child.on('close', (code) => resolve({ code, out, err }));
});

console.log(`node ${process.versions.node} — exit ${result.code}`);
console.log(`reporter's own stream (must stay empty): ${JSON.stringify(result.err.slice(0, 120))}`);
if (!fs.existsSync(LOG)) {
  console.log('NO EVENTS REACHED THE REPORTER AT ALL.');
  console.log(result.out, result.err);
  process.exit(1);
}
const events = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
console.log(`\n${events.length} events reached the reporter.\n`);

const INTERESTING = new Set(['test:start', 'test:pass', 'test:fail', 'test:skip', 'test:todo', 'test:summary', 'test:plan']);
console.log('  #  type            name                              nesting skip  todo  extra');
for (const e of events) {
  const d = e.data || {};
  const extra = Object.keys(d).filter((k) => !['name', 'testName', 'nesting', 'skip', 'todo', 'file', 'line', 'column', 'duration_ms', 'details'].includes(k)).join(',');
  const mark = INTERESTING.has(e.type) ? ' ' : '.';
  console.log(`${mark} ${String(e.i).padStart(2)}  ${String(e.type).padEnd(15)} ${String(d.name).padEnd(33)} ${String(d.nesting).padEnd(7)} ${String(d.skip).padEnd(5)} ${String(d.todo).padEnd(5)} ${extra}`);
}

const types = [...new Set(events.map((e) => e.type))];
console.log(`\ndistinct event types: ${types.join(', ')}`);
console.log(`any event carrying testName: ${events.some((e) => e.data && e.data.testName !== undefined)}`);
console.log(`any event carrying a skip/todo flag: ${events.some((e) => e.data && (e.data.skip !== undefined || e.data.todo !== undefined))}`);

console.log(`\n--- test:summary payloads (a possible agreement channel) ---`);
for (const e of events.filter((e) => e.type === 'test:summary')) console.log(`  ${JSON.stringify(e.data)}`);

console.log(`\n--- the interesting payloads, verbatim (first of each kind) ---`);
for (const kind of ['test:start', 'test:pass', 'test:fail', 'test:summary']) {
  const e = events.find((x) => x.type === kind);
  if (e) console.log(`  ${kind}: ${JSON.stringify(e.data)}`);
}
const skipped = events.filter((e) => e.data && (e.data.skip !== undefined || e.data.todo !== undefined));
if (skipped.length) console.log(`  SKIP/TODO-bearing events: ${skipped.map((e) => `${e.type}(${e.data.name})`).join(', ')}`);

console.log(`\n--- TAP summary on stdout (the independent text channel) ---`);
console.log(result.out.trim().split('\n').filter((l) => /^# (tests|pass|fail|skipped|cancelled|todo)/.test(l)).join('\n'));

// The failing-identity parser must read the SAME names the frames carry, so the
// raw TAP text is dumped verbatim: which lines name a failure, and how a
// subject's own printed "# pass 9" is escaped by the runner.
console.log(`\n--- the FULL TAP text on stdout, verbatim ---`);
console.log(result.out.replace(/\n$/, '').split('\n').map((l) => `  |${l}`).join('\n'));
// ── SECOND measurement: a MULTI-FILE project ────────────────────────────────
// `node --test <dir>` runs each file in a child process. If the aggregate report
// then carries test:start/test:pass for the FILE as well as its tests, a counter
// that treats every start/pass pair as a test would inflate silently — so the
// file-level events are measured rather than assumed.
const multi = path.join(TMP, 'multi');
fs.mkdirSync(path.join(multi, 'test'), { recursive: true });
fs.writeFileSync(path.join(multi, 'test', 'alpha.test.js'), [
  "const { test } = require('node:test');",
  "const assert = require('node:assert');",
  "test('alpha one', () => { assert.ok(true); });",
  "test('alpha two', () => { assert.ok(true); });",
  '',
].join('\n'));
fs.writeFileSync(path.join(multi, 'test', 'beta.test.js'), [
  "const { test } = require('node:test');",
  "const assert = require('node:assert');",
  "test('beta one', () => { assert.ok(true); });",
  "test('beta two', () => { assert.equal(1, 2); });",
  '',
].join('\n'));
fs.rmSync(LOG, { force: true });
const multiResult = await new Promise((resolve) => {
  const child = spawn(process.execPath, args, { cwd: multi, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', (b) => { out += String(b); });
  child.stderr.on('data', (b) => { err += String(b); });
  child.on('close', (code) => resolve({ code, out, err }));
});
const mEvents = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
console.log(`\n\n=== MULTI-FILE run (2 files): exit ${multiResult.code} ===`);
console.log(`reporter's own stream: ${JSON.stringify(multiResult.err.slice(0, 120))}`);
console.log(`\n  #  type            name                nesting skip/todo        file`);
for (const e of mEvents) {
  const d = e.data || {};
  if (!['test:start', 'test:pass', 'test:fail', 'test:skip', 'test:todo'].includes(e.type)) continue;
  const flags = [d.skip !== undefined ? `skip=${d.skip}` : '', d.todo !== undefined ? `todo=${d.todo}` : ''].filter(Boolean).join(' ');
  console.log(`  ${String(e.i).padStart(2)}  ${String(e.type).padEnd(15)} ${String(d.name).padEnd(19)} ${String(d.nesting).padEnd(7)} ${flags.padEnd(16)} ${path.basename(String(d.file ?? ''))}`);
}
console.log(`\nframes-if-counted: start=${mEvents.filter((e) => e.type === 'test:start').length} pass=${mEvents.filter((e) => e.type === 'test:pass').length} fail=${mEvents.filter((e) => e.type === 'test:fail').length}`);
console.log(`\nTAP summary on stdout:`);
console.log(multiResult.out.trim().split('\n').filter((l) => /^# (tests|pass|fail|skipped|todo)/.test(l)).map((l) => `  ${l}`).join('\n'));
console.log(`\nTAP failure lines:`);
console.log(multiResult.out.trim().split('\n').filter((l) => /^\s*not ok /.test(l)).map((l) => `  |${l}`).join('\n') || '  (none)');

// ── THIRD measurement: how a DIRECTORY positional is interpreted ────────────
// A spec naturally writes `node --test test/`. Whether Node reads that as "search
// this directory" or as "this path is a test file" decides whether an integration
// must pass a directory at all — and a wrong guess here surfaces later as a
// mysterious failing test named after the path.
for (const rel of ['test/', 'test']) {
  const r = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', rel], { cwd: multi, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (b) => { out += String(b); });
    child.stderr.on('data', (b) => { err += String(b); });
    child.on('close', (code) => resolve({ code, out, err }));
  });
  console.log(`\n--- \`node --test ${rel}\`: exit ${r.code} ---`);
  console.log(`  summary: ${r.out.trim().split('\n').filter((l) => /^# (tests|pass|fail)/.test(l)).join(' | ') || '(none)'}`);
  console.log(`  failures: ${r.out.trim().split('\n').filter((l) => /^\s*not ok /.test(l)).map((l) => l.trim()).join(' | ') || '(none)'}`);
  console.log(`  first lines: ${r.out.trim().split('\n').slice(0, 4).map((l) => l.trim()).join(' | ')}`);
  if (r.err.trim() !== '') console.log(`  stderr: ${r.err.trim().split('\n').slice(0, 3).join(' | ')}`);
}

console.log(`\nscratch: ${TMP}`);
if (process.env.CANARY_KEEP_SCRATCH !== '1') fs.rmSync(TMP, { recursive: true, force: true });
