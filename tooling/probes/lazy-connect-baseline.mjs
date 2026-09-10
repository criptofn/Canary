#!/usr/bin/env node
/**
 * lazy-connect-baseline — PART VII measurement harness (run identically BEFORE
 * and AFTER the master-pass changes; the METRIC lines are the real deltas).
 *
 * Measures, per CLI phase, on a fresh real-git fixture: wall clock, stdout+err
 * bytes (the bytes an agent must read back — our token-cost proxy; the product
 * owns zero model calls, verified separately), and subprocess counts via an
 * in-process preload counter (NODE_OPTIONS --require) wrapping
 * child_process.spawnSync/spawn inside the CLI, logging every spawn. The old
 * PATH-shim method is structurally unreachable from the product after the
 * Blocker-1 hardened execution environment — itself proof of the fix — so the
 * pre-hardening 221->125 git/process-spawn comparison stands on the old
 * method, and this harness measures the current design honestly.
 * Also: setup idempotence (manifest of .canary/.git/hooks/.claude
 * byte-compared across setup #1 / #2 / #3, canary-hook marker counts) and
 * re-entry sanity (verify after promotion).
 *
 * Exits 0 when the run completes; FAIL lines mark measurement anomalies
 * (a crash, a non-reproducible phase), not product verdicts — verdicts are
 * printed as evidence, never laundered into PASS.
 *
 *   node tooling/probes/lazy-connect-baseline.mjs [--cli <path/to/main.js>]
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const argv = process.argv.slice(2);
const arg = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
const CLI = arg('--cli') ?? path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');
if (!fs.existsSync(CLI)) { console.error(`FAIL cli-missing ${CLI} (build first)`); process.exit(2); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-baseline-'));
const LOG = path.join(TMP, 'calls.log');

// In-process spawn counter: a Node preload that wraps child_process
// spawnSync/spawn inside the CLI process and logs "<basename> <args...>" per
// spawn. The product's hardenedEnv drops NODE_OPTIONS for its children (that
// is the Blocker-1 fix), so the CLI's OWN spawn calls are counted — once per
// child, no double-counting from grandchildren — and no PATH trust is needed.
// Bundled npm runs as `node <npm-cli.js>` (node-entry resolution), so it
// lands in the node bucket; npm/pnpm/yarn/corepack/bun binaries land in npm.
const COUNTER = path.join(TMP, 'counter.cjs');
fs.writeFileSync(COUNTER, [
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  'function line(f, a) {',
  '  try {',
  "    const b = path.basename(String(f)).replace(/\\.exe$/, '');",
  "    fs.appendFileSync(process.env.CANARY_BASELINE_LOG, b + ' ' + (a || []).join(' ') + '\\n');",
  '  } catch { /* measurement must never break the product */ }',
  '}',
  "const cp = require('node:child_process');",
  "for (const k of ['spawnSync', 'spawn']) {",
  '  const orig = cp[k];',
  '  cp[k] = function (file, ...rest) {',
  '    line(file, Array.isArray(rest[0]) ? rest[0] : []);',
  '    return orig.call(this, file, ...rest);',
  '  };',
  '}',
].join('\n'));
const ENV = { ...process.env, CANARY_BASELINE_LOG: LOG, NODE_OPTIONS: `--require=${COUNTER}` };

function countCalls() {
  const out = { git: 0, npm: 0, node: 0, other: 0, total: 0 };
  if (fs.existsSync(LOG)) {
    for (const line of fs.readFileSync(LOG, 'utf8').split('\n')) {
      const name = line.split(' ')[0];
      const k = !name ? null
        : name === 'git' ? 'git'
        : ['npm', 'pnpm', 'yarn', 'corepack', 'bun'].includes(name) ? 'npm'
        : name === 'node' ? 'node'
        : 'other';
      if (k) { out[k]++; out.total++; }
    }
  }
  return out;
}
const metrics = [];
function measure(label, args, cwd) {
  fs.writeFileSync(LOG, '');
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', timeout: 300_000, env: ENV, maxBuffer: 64 * 1024 * 1024 });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const c = countCalls();
  const m = { label, ms: Math.round(ms), bytes: Buffer.byteLength(out), exit: r.status, ...c };
  metrics.push(m);
  console.log(`METRIC phase=${label} ms=${m.ms} bytes=${m.bytes} exit=${m.exit} git=${m.git} npm=${m.npm} node=${m.node} other=${m.other} spawns=${m.total}`);
  if (r.error) console.log(`FAIL phase ${label} crashed: ${r.error.message}`);
  return { r, out };
}

// fixture identical in shape to the M10.2 repro (marker repo, node-only test)
// The probe's own process is NOT preloaded, so fixture setup never enters a
// measured window (LOG is also cleared before each phase).
function git(dir, ...a) {
  const r = spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8', timeout: 60_000 });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr?.trim()}`);
  return r.stdout.trim();
}
const root = path.join(TMP, 'repo');
fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
fs.mkdirSync(path.join(root, 'checks'), { recursive: true });
fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'baseline-fixture', private: true, scripts: { test: 'node checks/verify.js' } }, null, 2) + '\n');
fs.writeFileSync(path.join(root, 'checks', 'verify.js'), "const fs = require('node:fs');\nprocess.exit(fs.readFileSync('marker.txt', 'utf8').includes('FAIL') ? 1 : 0);\n");
fs.writeFileSync(path.join(root, 'marker.txt'), 'ok\n');
fs.writeFileSync(LOG, '');
git(root, 'init', '-b', 'main');
git(root, 'config', 'user.email', 'baseline@canary.local');
git(root, 'config', 'user.name', 'Canary Baseline');
git(root, 'add', '-A'); git(root, 'commit', '-m', 'initial');

function manifest() {
  const m = new Map();
  for (const walk of [['.canary'], ['.git', 'hooks'], ['.claude']]) {
    const base = path.join(root, ...walk);
    if (!fs.existsSync(base)) continue;
    const stack = [base];
    while (stack.length) {
      const d = stack.pop();
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) stack.push(p);
        else m.set(path.relative(root, p).replaceAll('\\', '/'), crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'));
      }
    }
  }
  return m;
}
function canaryHookMarkers() {
  let n = 0; const hits = [];
  for (const dir of [path.join(root, '.git', 'hooks'), path.join(root, '.claude')]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (!fs.statSync(p).isFile()) continue;
      const t = fs.readFileSync(p, 'utf8').toLowerCase();
      const k = (t.match(/canary/g) ?? []).length;
      if (k) { n += k; hits.push(`${path.relative(root, p)}:${k}`); }
    }
  }
  return { n, hits };
}
// CORE state must be byte-stable across re-setup; LEDGER paths (evidence,
// backups, checkpoint) are append-only by design — counted, never judged.
const LEDGER = (k) => k.startsWith('.canary/evidence/') || k.startsWith('.canary/backups/') || k.endsWith('last-checkpoint.json');
function diffManifest(a, b, tag) {
  const stat = (pred) => {
    const added = [...b.keys()].filter((k) => pred(k) && !a.has(k));
    const removed = [...a.keys()].filter((k) => pred(k) && !b.has(k));
    const changed = [...a.keys()].filter((k) => pred(k) && b.has(k) && a.get(k) !== b.get(k));
    return { added, removed, changed };
  };
  const core = stat((k) => !LEDGER(k));
  const ledger = stat((k) => LEDGER(k));
  const dup = core.added.length + core.removed.length + core.changed.length;
  console.log(`${dup === 0 ? 'IDEMPOTENT' : 'MUTATED'} ${tag} core added=${core.added.length} removed=${core.removed.length} changed=${core.changed.length} | ledger new=${ledger.added.length} removed=${ledger.removed.length} changed=${ledger.changed.length}`);
  for (const k of [...core.added, ...core.removed, ...core.changed].slice(0, 12)) console.log(`  ${tag} CORE ${k}`);
  return dup;
}

console.log(`=== lazy-connect-baseline cli=${CLI} tmp=${TMP} method=in-process-preload-counter ===`);
const s1 = measure('setup#1-fresh', ['setup', '--yes', root], root);
fs.writeFileSync(path.join(TMP, 'setup1.out'), s1.out);
const snapA = manifest(); const markA = canaryHookMarkers();

measure('task-register', ['task', 'validate the marker file', '--kind', 'refactor'], root);
measure('isolate', ['isolate', 'b1', root], root);

// agent work inside the candidate worktree — direct git, outside any phase window
const c = path.join(root, '.canary', 'candidates', 'b1');
fs.writeFileSync(path.join(c, 'src-extra.js'), '// agent work\n');
fs.writeFileSync(LOG, '');
git(c, 'add', '-A'); git(c, 'commit', '-m', 'work');

const v = measure('verify', ['isolate', '--verify', 'b1', root], root);
const verdict = (v.out.match(/CANDIDATE (?:PASS|NOT PROVEN|FAIL|BLOCKED)[^\n]*/) ?? ['(none)'])[0];
console.log(`EVIDENCE verify verdict: ${verdict}`);
const p = measure('promote', ['isolate', '--promote', 'b1', root], root);
console.log(`EVIDENCE promote line: ${(p.out.match(/(ACCEPTED|REFUSED|BLOCKED|PROMOTION)[^\n]*/i) ?? ['(none)'])[0]}`);

const s2 = measure('setup#2-reconnect', ['setup', '--yes', root], root);
fs.writeFileSync(path.join(TMP, 'setup2.out'), s2.out);
const snapB = manifest(); const markB = canaryHookMarkers();
const churn = diffManifest(snapA, snapB, 'setup#2');
console.log(`MARKERS canary-hook-mentions setup#1=${markA.n} [${markA.hits.join(' ')}] setup#2=${markB.n} [${markB.hits.join(' ')}]`);

measure('verify-after-promote-reentry', ['isolate', '--verify', 'b1', root], root);
const s3 = measure('setup#3-third-time', ['setup', '--yes', root], root);
const snapC = manifest(); const markC = canaryHookMarkers();
const churn2 = diffManifest(snapB, snapC, 'setup#3');
console.log(`MARKERS setup#3=${markC.n}`);

const phases = metrics.map((m) => m.ms).sort((a, b) => a - b);
console.log(`SUMMARY phases=${metrics.length} total_ms=${metrics.reduce((a, m) => a + m.ms, 0)} slowest=${phases[phases.length - 1]} total_git=${metrics.reduce((a, m) => a + m.git, 0)} total_spawns=${metrics.reduce((a, m) => a + m.total, 0)} total_bytes=${metrics.reduce((a, m) => a + m.bytes, 0)}`);
console.log(`BASELINE: COMPLETE${churn || churn2 ? ' (setup NOT idempotent — see MUTATED lines)' : ' (setup idempotent on this fixture)'}`);
