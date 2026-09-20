// v1.3 §D — the `edit` primitive, measured through the REAL confined boundary.
//
// WHY A PROBE AND NOT A UNIT TEST: `apply()` lives in the file that runs ONLY inside the AppContainer, and
// the property that matters is not "does string replacement work" — it is that a new mutation primitive
// grants no new reach. `write` already accepted arbitrary content for the same path, so `edit` must be
// denied by the OS exactly where `write` is denied, and it must never resolve an ambiguous anchor by
// guessing. Those are boundary facts, so they are measured at the boundary.
//
// It also measures the thing the primitive EXISTS for, deterministically and without model tokens: what a
// caller has to SEND for a representative change, as `write` versus as `edit`. The model's own output is
// the measured dominant term in the confined arm's token cost (~70% on a long task, and the previous tool
// set could only express a change by re-emitting the whole file).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { productionTool } from '../../apps/cli/dist/src/provider/production.js';

const repo = path.resolve(import.meta.dirname, '../..');
const cli = path.join(repo, 'apps/cli/dist/src/main.js');
const git = 'C:\\Program Files\\Git\\cmd\\git.exe';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-edit-'));
const base = path.join(root, 'base'), work = path.join(root, 'work'), store = path.join(root, 'store');
const outside = path.join(root, 'outside');
let passed = 0, failed = 0;
const check = (name, fn) => {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${String(e?.message ?? e).split('\n').join('\n     ')}`); }
};
const run = (exe, args, cwd) => {
  const r = spawnSync(exe, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 300000 });
  assert.equal(r.status, 0, `${exe} ${args.join(' ')}\n${r.stdout}${r.stderr}`);
  return r.stdout;
};

/** A ~1 KB source file, so the payload measurement is representative rather than degenerate. */
const SOURCE = [
  "'use strict';",
  '// A small ledger used only to measure what a caller must SEND to change it.',
  'class Ledger {',
  '  constructor() { this.rows = new Map(); this.cache = new Map(); }',
  '  put(tenant, id, value) {',
  '    const key = `${tenant}:${id}`;',
  '    this.rows.set(key, value);',
  '    this.cache.set(key, value);',
  '    return value;',
  '  }',
  '  get(tenant, id) {',
  '    const key = `${tenant}:${id}`;',
  '    if (this.cache.has(key)) return this.cache.get(key);',
  '    const v = this.rows.get(key);',
  '    if (v !== undefined) this.cache.set(key, v);',
  '    return v;',
  '  }',
  '  remove(tenant, id) {',
  '    const key = `${tenant}:${id}`;',
  '    this.rows.delete(key);',
  '    return this.rows.has(key);',
  '  }',
  ...Array.from({ length: 18 }, (_, i) => `  // padding line ${i} keeps this file at a realistic size`),
  '}',
  'module.exports = { Ledger };',
  '',
].join('\n');

try {
  fs.mkdirSync(base, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'trusted bytes outside the boundary\n');
  fs.writeFileSync(path.join(base, 'package.json'), JSON.stringify({ name: 'edit-probe', private: true, scripts: { test: 'node -e "process.exit(0)"' } }, null, 2) + '\n');
  run(git, ['init', '-b', 'main', base]);
  run(git, ['-C', base, 'config', 'user.email', 'edit@canary.local']);
  run(git, ['-C', base, 'config', 'user.name', 'Edit Probe']);
  run(git, ['-C', base, 'add', '-A']);
  run(git, ['-C', base, 'commit', '-m', 'base']);

  run(process.execPath, [cli, 'setup', '--yes', base], base);
  run(process.execPath, [cli, 'task', 'confined edit primitive audit'], base);
  const enrolled = JSON.parse(run(process.execPath, [cli, 'provider', 'enroll', base, store], base));
  console.log(`enrolled as ${enrolled.package}`);

  const inside = (name, text = SOURCE) => {
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(work, name), text);
    return path.join(work, name);
  };
  const tool = (request) => productionTool(store, work, request);
  const readTrusted = (p) => fs.readFileSync(p, 'utf8');

  // ── 1. the primitive works, and nothing but the anchor moved ──
  check('1. edit applies an anchored change, and touches nothing else', () => {
    const target = inside('ledger.cjs');
    const before = readTrusted(target);
    const r = tool({ op: 'edit', path: 'ledger.cjs', find: '    this.rows.delete(key);\n', replace: '    this.rows.delete(key);\n    this.cache.delete(key);\n' });
    assert.equal(r.output.result, 'edited', JSON.stringify(r.output));
    const after = readTrusted(target);
    assert.match(after, /this\.cache\.delete\(key\);/);
    // exactly one insertion, and every other byte identical
    assert.equal(after.length, before.length + '    this.cache.delete(key);\n'.length);
    assert.equal(after.replace('    this.cache.delete(key);\n', ''), before);
  });

  // ── 2. an ambiguous anchor is REFUSED, never guessed ──
  // This is the safety property of the primitive: "the first match" would be a quiet wrong-place
  // mutation, invisible to a diff that only shows the file changed.
  check('2. an ambiguous anchor is refused and the file is untouched', () => {
    const target = inside('ambiguous.cjs');
    const before = readTrusted(target);
    const r = tool({ op: 'edit', path: 'ambiguous.cjs', find: 'this.cache', replace: 'this.CACHE' });
    assert.match(JSON.stringify(r), /more than once/, JSON.stringify(r));
    assert.equal(readTrusted(target), before, 'a refusal must not write');
  });

  check('3. a missing anchor is refused and the file is untouched', () => {
    const target = inside('missing.cjs');
    const before = readTrusted(target);
    const r = tool({ op: 'edit', path: 'missing.cjs', find: 'no such snippet anywhere in this file', replace: 'x' });
    assert.match(JSON.stringify(r), /does not occur/, JSON.stringify(r));
    assert.equal(readTrusted(target), before);
  });

  check('4. a no-op edit is refused rather than reported as a change', () => {
    inside('noop.cjs');
    const r = tool({ op: 'edit', path: 'noop.cjs', find: 'class Ledger {', replace: 'class Ledger {' });
    assert.match(JSON.stringify(r), /identical/, JSON.stringify(r));
  });

  check('5. find:"" replaces the whole file, so wholesale regeneration is still possible', () => {
    const target = inside('regenerate.cjs');
    const r = tool({ op: 'edit', path: 'regenerate.cjs', find: '', replace: 'module.exports = 1;\n' });
    assert.equal(r.output.result, 'edited', JSON.stringify(r.output));
    assert.equal(readTrusted(target), 'module.exports = 1;\n');
  });

  // ── 6. containment: `edit` reaches exactly as far as `write`, and no further ──
  const DENIED = /permission denied|access is denied|EPERM|EACCES|operation not permitted|ENOENT/i;
  check('6a. edit cannot reach a trusted file outside the sandbox (absolute path)', () => {
    const victim = path.join(outside, 'secret.txt');
    const before = readTrusted(victim);
    const r = tool({ op: 'edit', path: victim, find: 'trusted', replace: 'OWNED' });
    assert.match(JSON.stringify(r), DENIED, JSON.stringify(r));
    assert.equal(readTrusted(victim), before, 'the trusted file must be byte-unchanged');
  });
  check('6b. edit cannot reach it by traversal, and the refusal is the same one', () => {
    const victim = path.join(outside, 'secret.txt');
    const before = readTrusted(victim);
    const r = tool({ op: 'edit', path: path.join('..', '..', 'outside', 'secret.txt'), find: 'trusted', replace: 'OWNED' });
    assert.match(JSON.stringify(r), DENIED, JSON.stringify(r));
    assert.equal(readTrusted(victim), before);
  });
  check('6c. edit cannot rewrite the sealed verification authority in the trusted base', () => {
    const victim = path.join(base, '.canary', 'canary.local.json');
    const before = readTrusted(victim);
    const r = tool({ op: 'edit', path: victim, find: '"planAuthority"', replace: '"planAuthority":{}, "x"' });
    assert.match(JSON.stringify(r), DENIED, JSON.stringify(r));
    assert.equal(readTrusted(victim), before);
  });

  // ── 7. the measurement the primitive exists for: what a caller must SEND ──
  check('7. for a representative change, `edit` sends a fraction of what `write` sends', () => {
    const anchor = '    this.rows.delete(key);\n';
    const replacement = '    this.rows.delete(key);\n    this.cache.delete(key);\n';
    const changed = SOURCE.replace(anchor, replacement);
    assert.notEqual(changed, SOURCE, 'the fixture change must actually apply');
    const writeCall = JSON.stringify({ op: 'write', path: 'ledger.cjs', text: changed });
    const editCall = JSON.stringify({ op: 'edit', path: 'ledger.cjs', find: anchor, replace: replacement });
    const pct = Math.round((editCall.length / writeCall.length) * 100);
    console.log(`     write call ${writeCall.length} B vs edit call ${editCall.length} B — ${pct}% (source ${SOURCE.length} B)`);
    assert.ok(editCall.length * 4 < writeCall.length,
      `edit must be materially smaller than a whole-file write, got ${pct}%`);
  });

  console.log(`\n=== edit primitive: ${failed === 0 ? `${passed} PASS` : `${failed} FAIL of ${passed + failed}`} ===`);
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
}
