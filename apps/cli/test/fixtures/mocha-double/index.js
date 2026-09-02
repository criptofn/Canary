'use strict';
// ── The Canary mocha-API DOUBLE ─────────────────────────────────────────────
// Why this exists (post-GLM panel K): the execution-observation channel's
// happy path must be testable OFFLINE, without an npm install of real mocha.
// This is the only runner the offline suite lets Canary inject into — it is
// authored in THIS repo and pinned by CONTENT HASH (KNOWN_RUNNER_RELEASES,
// origin 'canary-double'). It implements exactly the surfaces the observer
// preload binds to, and nothing more:
//   * exports Runner + Runnable (and Test/Mocha/describe/it/hooks) so the
//     preload's isMochaShape() finds it under its require.cache path anchor;
//   * Runnable#run(fn) executes the body and calls fn(err) — the ranSet
//     binding that makes an emitted pass MEAN an observed execution;
//   * Runner extends EventEmitter, dispatching 'pass'/'fail'/'pending'/'end'
//     with objects exposing .type ('test'|'hook'), .file and .titlePath();
//   * reporter output agrees with the lifecycle events BY CONSTRUCTION
//     (summary counts and failure-block identities are rendered FROM the
//     same events Canary watches), and stdout is byte-deterministic across
//     rounds (no timings printed) so proofs can pin normalized hashes.
// Deliberate NON-features (a gap fails loud instead of faking mocha): no
// timeouts, retries, grep, reporters, globs. A hook FAILURE aborts the run
// with no summary printed — capture-wise that is INVALID/INFRA territory,
// never a strong verdict, matching how seriously the validator takes
// hook-contradicted text.
// NOT a release artifact; never shipped to any registry.

const { EventEmitter } = require('node:events');
const path = require('node:path');

class Suite {
  constructor(title, parent) {
    this.type = 'suite'; this.title = title; this.parent = parent || null;
    this.suites = []; this.tests = [];
    this.hooks = { before: [], beforeEach: [], afterEach: [], after: [] };
  }
  titlePath() { return (this.parent ? this.parent.titlePath() : []).concat(this.title === '' ? [] : [this.title]); }
}
class Runnable {
  constructor(title) { this.title = title; this.file = null; this._fn = null; this._parent = null; }
  // Contract with the preload: run(fn) invokes fn(err|null) EXACTLY when the
  // body settles — the wrapper around fn is what records "Canary watched this
  // Runnable execute" (ranSet). Emitting pass/fail without this never happens
  // in this double by construction, but the REJECT defense stays load-bearing.
  run(fn) {
    const self = this;
    let settled = false;
    const done = (err) => { if (!settled) { settled = true; fn(err || null); } };
    try {
      const r = self._fn ? self._fn.call(self, done) : undefined;
      if (r && typeof r.then === 'function') {
        r.then(() => done(null), (e) => done(e || new Error('Promise rejected without a reason')));
      } else if (self._fn && self._fn.length > 0) {
        /* callback-style body: done() arrives when the body calls it */
      } else {
        done(null);
      }
    } catch (e) { done(e || new Error('Test failed without an error object')); }
  }
}
class Test extends Runnable {
  constructor(title, fn) { super(title); this.type = 'test'; this._fn = fn || null; }
  titlePath() { return this._parent.titlePath().concat(this.title); }
}
class Hook extends Runnable {
  constructor(title, fn) { super(title); this.type = 'hook'; this._fn = fn; }
  titlePath() { return this._parent.titlePath().concat(this.title); }
}
class Runner extends EventEmitter { constructor(suite) { super(); this.suite = suite; } }

const root = new Suite('', null);
let currentSuite = root;
let currentFile = null;

function describe(title, fn) {
  const s = new Suite(title, currentSuite);
  currentSuite.suites.push(s);
  const prev = currentSuite; currentSuite = s;
  try { if (fn) fn(); } finally { currentSuite = prev; }
  return s;
}
function it(title, fn) {
  const t = new Test(title, fn);
  t._parent = currentSuite; t.file = currentFile;
  currentSuite.tests.push(t);
  return t;
}
function addHook(kind, fn) {
  const h = new Hook('"' + kind + '" hook', fn);
  h._parent = currentSuite; h.file = currentFile;
  currentSuite.hooks[kind].push(h);
}
const before = (fn) => addHook('before', fn);
const beforeEach = (fn) => addHook('beforeEach', fn);
const afterEach = (fn) => addHook('afterEach', fn);
const after = (fn) => addHook('after', fn);

const runSettled = (r) => new Promise((res) => r.run((err) => res(err || null)));

async function execSuite(suite, runner, ctx) {
  const chain = [];
  for (let s = suite; s; s = s.parent) chain.unshift(s);
  for (const h of suite.hooks.before) {
    const e = await runSettled(h);
    if (e) { runner.emit('fail', h, e); ctx.hookFailed = true; return; }
  }
  for (const t of suite.tests) {
    if (ctx.hookFailed) return;
    if (!t._fn) { runner.emit('pending', t); continue; }
    for (const s of chain) for (const h of s.hooks.beforeEach) {
      const e = await runSettled(h);
      if (e) { runner.emit('fail', h, e); ctx.hookFailed = true; return; }
    }
    const err = await runSettled(t);
    for (const s of chain.slice().reverse()) for (const h of s.hooks.afterEach) {
      const e = await runSettled(h);
      if (e) { runner.emit('fail', h, e); ctx.hookFailed = true; return; }
    }
    if (err) { runner.emit('fail', t, err); ctx.failures.push({ t, err }); }
    else runner.emit('pass', t);
  }
  for (const child of suite.suites) { await execSuite(child, runner, ctx); if (ctx.hookFailed) return; }
  for (const h of suite.hooks.after) {
    const e = await runSettled(h);
    if (e) { runner.emit('fail', h, e); ctx.hookFailed = true; return; }
  }
}

class Mocha {
  constructor() { this.suite = root; this.files = []; }
  addFile(f) { this.files.push(path.resolve(f)); }
  loadFiles() { for (const f of this.files) { currentFile = f; require(f); } }
  async run() {
    const runner = new Runner(this.suite);
    const ctx = { failures: [], hookFailed: false };
    let passing = 0; let pending = 0;
    runner.on('pass', () => { passing += 1; });
    runner.on('pending', () => { pending += 1; });
    await execSuite(this.suite, runner, ctx);
    if (ctx.hookFailed) {
      // Honest abort: no summary printed — the round cannot read as a
      // completed run, which is exactly the direction Canary requires.
      console.log('mocha-double: hook failure aborted the run');
      runner.emit('end');
      return 1;
    }
    if (passing > 0) console.log('  ' + passing + ' passing');
    if (pending > 0) console.log('  ' + pending + ' pending');
    if (ctx.failures.length > 0) console.log('  ' + ctx.failures.length + ' failing');
    ctx.failures.forEach((f, i) => {
      const segs = f.t.titlePath();
      if (segs.length === 1) console.log('  ' + (i + 1) + ') ' + segs[0] + ':');
      else {
        console.log('  ' + (i + 1) + ') ' + segs[0]);
        for (let k = 1; k < segs.length; k++) {
          const pad = ' '.repeat(7 + 2 * (k - 1));
          console.log(pad + segs[k] + (k === segs.length - 1 ? ':' : ''));
        }
      }
      console.log('     Error: ' + ((f.err && f.err.message) || String(f.err)));
    });
    runner.emit('end'); // bye frame after every lifecycle event
    return Math.min(ctx.failures.length, 255);
  }
}

module.exports = { Mocha, Runner, Runnable, Test, Suite, Hook, describe, it, before, after, beforeEach, afterEach };
