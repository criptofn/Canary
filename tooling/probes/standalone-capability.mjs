#!/usr/bin/env node
/**
 * DIAGNOSTIC (not a gate): what can THIS Node build actually produce as a
 * standalone single executable, and does the result really run without Node on
 * PATH?
 *
 * v1.1 item C wants Canary to stop requiring a Node installation for ordinary
 * Python/Rust/Go users. Node's SEA (`--build-sea`) is the supported way, but its
 * schema and its module-format support change between releases, so this measures
 * the host instead of assuming:
 *   1. CommonJS main          — the classic SEA shape;
 *   2. ES-module main         — `mainFormat: 'module'`, if this build accepts it
 *                               (the CLI is ESM and uses `import.meta.url`);
 *   3. execution with Node REMOVED from PATH — the actual claim being tested.
 *
 * It writes only under the OS temp dir, touches nothing in the repo, and exits 0
 * always: the answer is data. A build failure is reported, never hidden.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-sea-capability-'));
const NODE = process.execPath;
const NODE_DIR = path.dirname(NODE);
const EXT = process.platform === 'win32' ? '.exe' : '';

const banner = (t) => console.log(`\n${'='.repeat(72)}\n${t}\n${'='.repeat(72)}`);
function show(label, r) {
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  console.log(`status=${r.status} error=${r.error ? r.error.code ?? r.error.message : 'none'}`);
  for (const l of out.split(/\r?\n/)) if (l.trim()) console.log(`| ${l}`);
  if (label) console.log(`(${label})`);
}

console.log(`node: ${NODE}`);
console.log(`platform: ${process.platform} ${process.arch}`);
console.log(`temp: ${TMP}`);

/** PATH with every Node directory removed — the "no Node installed" posture. */
function pathWithoutNode() {
  const sep = process.platform === 'win32' ? ';' : ':';
  const kept = (process.env.PATH ?? '').split(sep).filter((d) => {
    if (d.trim() === '') return false;
    return path.resolve(d).toLowerCase() !== path.resolve(NODE_DIR).toLowerCase();
  });
  return kept.join(sep);
}

function buildSea(label, mainFile, configExtra) {
  banner(label);
  const out = path.join(TMP, `canary-${label.replace(/[^a-z0-9]+/gi, '-')}${EXT}`);
  const cfgPath = path.join(TMP, `sea-${label.replace(/[^a-z0-9]+/gi, '-')}.json`);
  const cfg = { main: mainFile, output: out, disableExperimentalSEAWarning: true, ...configExtra };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  console.log(`config: ${JSON.stringify(cfg)}`);
  const b = spawnSync(NODE, [`--build-sea=${cfgPath}`], { encoding: 'utf8', timeout: 300_000, windowsHide: true });
  show('build', b);
  if (b.status !== 0 || !fs.existsSync(out)) return { built: false, out };
  console.log(`binary: ${out} (${fs.statSync(out).size} bytes)`);

  // 1. runs normally
  const r1 = spawnSync(out, ['--self-check'], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
  console.log('\n-- run with the normal environment --');
  show('', r1);

  // 2. runs with NO Node on PATH (and PATH emptied of the Node dir)
  const env = { ...process.env, PATH: pathWithoutNode() };
  const r2 = spawnSync(out, ['--self-check'], { encoding: 'utf8', timeout: 60_000, windowsHide: true, env });
  console.log('\n-- run with Node REMOVED from PATH --');
  console.log(`PATH = ${env.PATH}`);
  show('', r2);

  // 3. can it still spawn things? (the CLI spawns git/npm; a standalone binary
  //    must not depend on the Node dir for its own operation)
  const r3 = spawnSync(out, ['--report-path'], { encoding: 'utf8', timeout: 60_000, windowsHide: true, env });
  console.log('\n-- report-path with Node removed from PATH --');
  show('', r3);

  return { built: r1.status === 0 && r2.status === 0, out };
}

const cjsMain = path.join(TMP, 'main.cjs');
fs.writeFileSync(cjsMain, `
const path = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--self-check')) { console.log('SEA-CJS-OK argv0=' + path.basename(process.argv[0])); process.exit(0); }
if (args.includes('--report-path')) { console.log('SEA-CJS-PATH=' + (process.env.PATH || '').slice(0, 60)); process.exit(0); }
console.log('SEA-CJS-IDLE');
`);

const esmMain = path.join(TMP, 'main.mjs');
fs.writeFileSync(esmMain, `
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const args = process.argv.slice(2);
const here = path.dirname(fileURLToPath(import.meta.url));
if (args.includes('--self-check')) { console.log('SEA-ESM-OK here=' + here); process.exit(0); }
console.log('SEA-ESM-IDLE');
`);

const cjs = buildSea('commonjs', cjsMain, {});
if (!cjs.built) {
  console.log('\nNOTE: CommonJS SEA did not build/run — see output above.');
}
const esm = buildSea('esm', esmMain, { mainFormat: 'module' });
if (!esm.built) {
  console.log('\nNOTE: ES-module SEA did not build/run on this Node build. That matters because');
  console.log('the CLI is ESM and derives its own entry path from import.meta.url; the');
  console.log('standalone path would then need a CommonJS bundle (esbuild --format=cjs) with');
  console.log('import.meta.url replaced, which is a real, stated build step rather than a guess.');
}

banner('SUMMARY');
console.log(`commonjs main: ${cjs.built ? 'WORKS (runs with Node removed from PATH)' : 'did not work'}`);
console.log(`module   main: ${esm.built ? 'WORKS (runs with Node removed from PATH)' : 'did not work'}`);
console.log(`temp kept: ${TMP}`);
if (process.env.CANARY_SEA_CLEAN === '1') { fs.rmSync(TMP, { recursive: true, force: true }); console.log('(removed)'); }
process.exit(0);
