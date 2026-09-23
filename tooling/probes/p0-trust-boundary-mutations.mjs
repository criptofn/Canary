#!/usr/bin/env node
/** Behavioral mutation checks against isolated compiled modules. No source
 * edits, no network, no product repo fixtures. Compile/syntax/crash failures
 * are not kills; every kill needs a node:test assertion failure. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-p0-mutants-'));
const modules = ['authority-envelope', 'trust-store', 'authorization', 'broker', 'platform-boundary'];
const tests = ['trust-store', 'trust-store-attacks', 'broker', 'platform-boundary'];
const mutations = [
  ['ledger-equality', 'trust-store', 'if (seq !== env.seq)', 'if (false)'],
  ['cas', 'trust-store', 'expectedSeq !== undefined && expectedSeq !== previous', 'false'],
  ['all-json-keys', 'authority-envelope', 'out[k] = visit(v[k], depth + 1);', "if (k !== '__proto__') out[k] = visit(v[k], depth + 1);"],
  ['hardened-refusal', 'platform-boundary', "if (level !== 'LOCAL')", 'if (false)'],
  ['signature', 'broker', 'verifySeal(r.receipt, key)', 'true'],
  ['receipt-project', 'broker', 'r.receipt.projectId === this.#projectId', 'true'],
  ['receipt-domain', 'broker', 'r.receipt.kind === kind', 'true'],
  ['run-identity', 'broker', 'body[k] === state.run[k]', 'true'],
  ['consume-once', 'broker', "state.phase === 'running', 'verification already consumed'", "true, 'verification already consumed'"],
  ['objective-proof', 'broker', "return !!state.verification?.clean && state.verification.objectiveResults.every(x => x.status === 'met');", 'return true;'],
  ['subjective-proof', 'broker', "!state.enrollment.subject.subjectiveDuties.length || state.phase === 'accepted'", 'true'],
  ['promotion-subject', 'broker', 'subjectDigest(live) === state.run.subjectDigest', 'true'],
  ['promotion-target', 'broker', 'targetId === state.enrollment.policy.targetId', 'true'],
  ['fresh-promotion', 'broker', "state.run.purpose === 'promotion'", 'true'],
];
let killed = 0;
function prepare(name) {
  // The mutant tree MIRRORS the repo layout (apps/cli/dist/{src,test}): the
  // merged trust-store suite locates its concurrency fixture as
  // <repo>/tooling/test-support/fixtures/trust-seal-once.mjs, four levels above
  // its own test dir. Mirroring keeps that path inside the mutant, and the
  // fixture then imports ../../../apps/cli/dist/src/trust-store.js — the MUTANT
  // module — exactly as it imports the built one in the real repo. No mutant is
  // skipped and no assertion is relaxed.
  const dir = path.join(temp, name, 'apps', 'cli', 'dist');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'test'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  for (const mod of modules) fs.copyFileSync(path.join(root, `apps/cli/dist/src/${mod}.js`), path.join(dir, `src/${mod}.js`));
  for (const test of tests) fs.copyFileSync(path.join(root, `apps/cli/dist/test/${test}.test.js`), path.join(dir, `test/${test}.test.js`));
  const fixtures = path.join(temp, name, 'tooling', 'test-support', 'fixtures');
  fs.mkdirSync(fixtures, { recursive: true });
  fs.copyFileSync(path.join(root, 'tooling/test-support/fixtures/trust-seal-once.mjs'), path.join(fixtures, 'trust-seal-once.mjs'));
  // v1.4 — MIRROR MODULE RESOLUTION TOO. MEASURED FAILURE: the mirrored tree had no
  // node_modules, so as soon as a copied module gained a legitimate internal import edge
  // (`trust-store.js` -> `@canary-rn/support`, added with the Windows path-canonicalisation
  // helper) the CONTROL crashed with
  //   Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@canary-rn/support' imported from
  //   <temp>/control/apps/cli/dist/src/trust-store.js
  // and this probe reported `actual 1, expected 0` — i.e. it blamed the mutant when its own
  // isolated tree could not load the module at all. A harness that copies code must copy the
  // resolution context with it, or every future internal import becomes a false red.
  // The workspace packages are NOT mutation targets: they are dependencies, so they are linked
  // to the REAL built output, exactly as the real tree resolves them.
  const scope = path.join(root, 'node_modules', '@canary-rn');
  const mirrorScope = path.join(temp, name, 'node_modules', '@canary-rn');
  fs.mkdirSync(mirrorScope, { recursive: true });
  for (const entry of fs.readdirSync(scope)) {
    const from = path.join(scope, entry), to = path.join(mirrorScope, entry);
    try {
      fs.symlinkSync(process.platform === 'win32' ? path.resolve(from) : fs.realpathSync(from), to, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      // A host that refuses links must not silently lose resolution: fall back to a real copy.
      fs.cpSync(fs.realpathSync(from), to, { recursive: true });
    }
  }
  return dir;
}
function run(dir) {
  return spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...tests.map(t => `test/${t}.test.js`)], { cwd: dir, encoding: 'utf8', timeout: 60000, windowsHide: true });
}
try {
  const control = run(prepare('control'));
  assert.equal(control.status, 0, control.stdout + control.stderr);
  console.log('PASS unmodified control');
  for (const [name, mod, from, to] of mutations) {
    const dir = prepare(name), file = path.join(dir, `src/${mod}.js`);
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.includes(from), `${name}: mutation anchor missing`);
    // Some guards intentionally occur at both start and reservation. Remove
    // the complete defense for this mutant, not only one redundant check.
    fs.writeFileSync(file, text.replaceAll(from, to));
    const syntax = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', windowsHide: true });
    assert.equal(syntax.status, 0, `${name}: syntax failure is not a kill`);
    const result = run(dir), output = result.stdout + result.stderr;
    assert.equal(result.status, 1, `${name}: survived or crashed\n${output}`);
    assert.match(output, /code: 'ERR_ASSERTION'/, `${name}: no behavioral assertion failure\n${output}`);
    assert.doesNotMatch(output, /ERR_MODULE_NOT_FOUND|SyntaxError|ReferenceError/, `${name}: infrastructure failure is not a kill`);
    console.log(`PASS killed ${name}`);
    killed++;
  }
  console.log(`PASS ${killed}/${mutations.length} behavioral mutants killed`);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
