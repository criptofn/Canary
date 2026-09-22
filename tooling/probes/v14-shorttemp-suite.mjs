#!/usr/bin/env node
/**
 * v1.4 release gate -- run the unit suite under the EXACT condition GitHub's
 * Windows runners provide, so a red Windows leg can be diagnosed in minutes
 * instead of a 90-minute round trip.
 *
 * THE CONDITION: the runner's temp path is `C:\Users\RUNNER~1\AppData\Local\Temp`
 * -- an 8.3 SHORT name. `os.tmpdir()` therefore hands every fixture a SHORT
 * spelling of a directory whose `realpathSync.native` (and whose `git`-reported
 * toplevel) is the LONG spelling `C:\Users\runneradmin\...`. One directory, two
 * spellings. MEASURED on the runner (probe v14-windows-identity-diag.mjs, run
 * 35554826434): `fs.realpathSync` keeps the short form while git prints the
 * long one.
 *
 * WHY IT IS INVISIBLE HERE: a path component only HAS a distinct short name
 * when its long name does not fit 8.3. `Johannes` (8) and `Desktop` (7) fit, so
 * on this workstation the two spellings are byte-identical and every comparison
 * passes. This probe manufactures the condition instead of waiting for it.
 *
 * Usage:
 *   node tooling/probes/v14-shorttemp-suite.mjs                      # a fast, high-signal default set
 *   node tooling/probes/v14-shorttemp-suite.mjs <test-file> [...]    # exact files (absolute or repo-relative)
 *   node tooling/probes/v14-shorttemp-suite.mjs --all                # every compiled test file
 *   node tooling/probes/v14-shorttemp-suite.mjs --timeout <seconds>  # per-file budget (default 900)
 *
 * Exit: 0 everything passed; 3 this host cannot produce a distinct 8.3 short
 *       name (explicit host-bound SKIP -- never a pass); 1 a test failed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const argv = process.argv.slice(2);
const all = argv.includes('--all');
const tIdx = argv.indexOf('--timeout');
const perFileTimeoutMs = (tIdx >= 0 ? Number(argv[tIdx + 1]) : 900) * 1000;
const named = argv.filter((a, i) => !a.startsWith('--') && i !== tIdx + 1);

/** The default set: the files that were red (or cascade-cancelled) on the
 *  Windows leg of run 35636516908. Chosen for signal per second. */
const DEFAULT_SET = [
  'apps/cli/dist/test/prove.test.js',
  'apps/cli/dist/test/verify-tree.test.js',
  'apps/cli/dist/test/attested-channel.test.js',
  'apps/cli/dist/test/cli.test.js',
];

function discoverAll() {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.test.js')) out.push(path.relative(REPO, p).replace(/\\/g, '/'));
    }
  };
  for (const pkg of ['apps', 'packages']) walk(path.join(REPO, pkg));
  return out.sort();
}

/** The 8.3 short spelling of an EXISTING directory.
 *
 *  MEASURED: `cmd /c for %I in ("<path>") do @echo %~sI` cannot be driven from
 *  spawnSync -- cmd re-parses the command line and the quotes collapse. The
 *  FileSystemObject's `ShortPath` is the documented, quote-safe way to ask
 *  Windows for a path's 8.3 form. */
function shortPathOf(p) {
  const script = `$f=(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${p.replace(/'/g, "''")}'); $f.ShortPath`;
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  const out = (r.stdout ?? '').trim();
  return out.length > 0 ? out : null;
}

if (process.platform !== 'win32') {
  console.log('SKIP: 8.3 short names are a Windows filesystem property; this host cannot exercise it.');
  process.exit(3);
}

const files = all ? discoverAll() : (named.length > 0 ? named : DEFAULT_SET);
for (const f of files) {
  const abs = path.isAbsolute(f) ? f : path.join(REPO, f);
  if (!fs.existsSync(abs)) { console.error(`FAIL: no compiled test file at ${abs} - run \`npm run build\` first`); process.exit(1); }
}

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-shorttemp-'));
// A component whose long name does not fit 8.3, so a distinct short name is
// guaranteed (mirrors the runner's `runneradmin` -> `RUNNER~1`).
const LONG_DIR = path.join(BASE, 'a-long-directory-name');
fs.mkdirSync(LONG_DIR, { recursive: true });

let exitCode = 0;
try {
  const SHORT_DIR = shortPathOf(LONG_DIR);
  console.log(`LONG_DIR  ${LONG_DIR}`);
  console.log(`SHORT_DIR ${String(SHORT_DIR)}`);
  if (SHORT_DIR === null || SHORT_DIR.toLowerCase() === LONG_DIR.toLowerCase()) {
    console.log('\nSKIP: this filesystem/locale did not produce a distinct 8.3 short name for the');
    console.log('      fixture, so the runner condition cannot be exercised here. That is NOT a');
    console.log('      pass -- this host cannot prove the suite either way.');
    process.exit(3);
  }
  console.log(`child TEMP/TMP/TMPDIR = ${SHORT_DIR}`);
  console.log(`files: ${files.length}, per-file budget ${Math.round(perFileTimeoutMs / 1000)}s\n`);

  const env = { ...process.env, TEMP: SHORT_DIR, TMP: SHORT_DIR, TMPDIR: SHORT_DIR };
  const results = [];
  for (const f of files) {
    const abs = path.isAbsolute(f) ? f : path.join(REPO, f);
    const started = Date.now();
    const r = spawnSync(process.execPath, ['--test', abs], { env, cwd: REPO, encoding: 'utf8', timeout: perFileTimeoutMs, maxBuffer: 256 * 1024 * 1024 });
    const secs = Math.round((Date.now() - started) / 100) / 10;
    const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    const failed = out.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('\u2716 ') || l.startsWith('not ok '));
    const timedOut = r.error !== undefined && r.error !== null && r.error.code === 'ETIMEDOUT';
    const ok = !timedOut && r.status === 0 && failed.length === 0;
    results.push({ file: f, ok, secs, timedOut, failed: failed.length, status: r.status });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${f} - ${secs}s, exit ${String(r.status)}${timedOut ? ' (TIMED OUT)' : ''}, ${failed.length} failing line(s)`);
    if (!ok) {
      for (const line of failed.slice(0, 8)) console.log(`       ${line.slice(0, 180)}`);
      const detail = path.join(os.tmpdir(), `canary-shorttemp-${path.basename(f)}.log`);
      fs.writeFileSync(detail, out);
      console.log(`       full output: ${detail}`);
    }
  }

  const bad = results.filter((r) => !r.ok);
  console.log('');
  for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${String(r.secs).padStart(7)}s  ${r.file}`);
  console.log('');
  if (bad.length > 0) {
    console.log(`SHORTTEMP-SUITE: FAIL (${bad.length}/${results.length} file(s) red under an 8.3 short TEMP -- the Windows runner condition)`);
    exitCode = 1;
  } else {
    console.log(`SHORTTEMP-SUITE: PASS - ${results.length} file(s) green with TEMP spelled as an 8.3 short name.`);
  }
} finally {
  try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* OS temp */ }
}
process.exit(exitCode);
