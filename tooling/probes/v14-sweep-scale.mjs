#!/usr/bin/env node
/**
 * v1.4 release gate -- REGRESSION GUARD for the containment-sweep defect that
 * made the GitHub Windows leg red for two releases.
 *
 * THE DEFECT (measured, run 35636516908): `sweepWin32` issued one WMI query PER
 * PROCESS in the descendant BFS --
 *   `Get-CimInstance -ClassName Win32_Process -Filter "ParentProcessId=$p"`
 * -- for every node it visited. A fixture command that spawns a whole test
 * suite has a large descendant tree, so one sweep made 30+ queries. At the
 * ~1s/query a loaded hosted runner gives, the sweep hit its budget and reported
 * the LOOK as unconfirmable; every round of every pipeline then became "not a
 * valid test run" -> INFRASTRUCTURE_FAILURE. That is 27 of the 29 real failures
 * in that run, each costing ~334 s of sweeps.
 *
 * THE FIX (packages/support): ONE snapshot of the process table, the BFS inside
 * that same PowerShell, kills attempted after the traversal, and a row count
 * that must come back positive -- so a snapshot that silently failed can never
 * be read as "nothing survived".
 *
 * WHAT THIS PROBE PINS DOWN
 *   A. SHAPE (deterministic, catches a revert): the built sweep contains no
 *      per-process `ParentProcessId=` query, and issues exactly one
 *      `Get-CimInstance -ClassName Win32_Process`.
 *   B. THE PROPERTY THE CHANGE MUST NOT BREAK (live evidence): against a real
 *      intermediate parent holding SEVERAL live descendants, the sweep still
 *      reports success and kills every one of them.
 *   C. HONESTY (unchanged by the fix): no child pid is not a failure, and a
 *      child that died leaving nothing behind is not a failure either.
 *
 * Usage: node tooling/probes/v14-sweep-scale.mjs
 * Exit: 0 all checks passed; 1 a check failed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUILT = path.join(REPO, 'packages', 'support', 'dist', 'src', 'index.js');
const DESCENDANTS = 6;

let failures = 0;
const check = (name, ok, detail = '') => {
  if (ok) console.log(`PASS ${name}${detail ? ` - ${detail}` : ''}`);
  else { failures += 1; console.log(`FAIL ${name}${detail ? ` - ${detail}` : ''}`); }
};
const info = (label, value) => console.log(`${label.padEnd(34)} ${value}`);

if (!fs.existsSync(BUILT)) {
  console.error(`FAIL: no built support package at ${BUILT} - run \`npm run build\` first`);
  process.exit(1);
}
const { sweepDescendants } = await import(`file://${BUILT.replace(/\\/g, '/')}`);

// ---------------------------------------------------------------- A. shape ---
console.log('=== A. the sweep asks the OS ONCE, not once per process ===');
const src = fs.readFileSync(BUILT, 'utf8');
// Comments are excluded on purpose: the fix's own rationale quotes the OLD
// shape (`Get-CimInstance -Filter "ParentProcessId=$p"`), and a shape guard that
// trips over prose would be noise. Built output keeps `//` and `*` comment lines,
// so dropping those lines leaves the executable text.
const code = src.split('\n')
  .filter((l) => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*'); })
  .join('\n');
const perProcessQueries = (code.match(/ParentProcessId=/g) ?? []).length;
const snapshots = (code.match(/Get-CimInstance -ClassName Win32_Process/g) ?? []).length;
info('per-process ParentProcessId queries', perProcessQueries);
info('whole-table enumerations', snapshots);
check('no per-process WMI query remains (the O(N) shape that timed out)', perProcessQueries === 0,
  `found ${perProcessQueries}`);
check('exactly one process-table enumeration per sweep', snapshots === 1, `found ${snapshots}`);
check('the enumeration result is required to be non-empty before "no survivors" is reported',
  /surveyed <= 0/.test(src) && /came back empty or unreadable/.test(src));

// ------------------------------------------------------------- B. live tree ---
console.log('\n=== B. a real tree with several survivors is still swept ===');
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const killIfAlive = (pid) => { if (pid !== undefined && isAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } };

const mid = spawn(process.execPath, ['-e',
  "const { spawn } = require('node:child_process');" +
  'const pids = [];' +
  `for (let i = 0; i < ${DESCENDANTS}; i++) {` +
  "  const c = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 120000)'], { stdio: 'ignore', windowsHide: true, detached: true });" +
  '  c.unref(); pids.push(c.pid); }' +
  "console.log(pids.join(' '));" +
  'setTimeout(()=>{}, 180000);',
], { stdio: ['ignore', 'pipe', 'ignore'], detached: true, windowsHide: true });

let out = '';
mid.stdout?.setEncoding('utf8');
let kidPids = [];
try {
  kidPids = await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('no child pids printed')), 20_000);
    mid.stdout?.on('data', (d) => {
      out += d;
      const parts = out.trim().split(/\s+/).map(Number).filter((n) => Number.isFinite(n) && n > 0);
      if (parts.length >= DESCENDANTS) { clearTimeout(to); resolve(parts); }
    });
    mid.on('error', (e) => { clearTimeout(to); reject(e); });
  });
  info('intermediate parent pid', String(mid.pid));
  info('live descendants', kidPids.join(' '));
  check(`precondition: ${DESCENDANTS} descendants are alive before the sweep`,
    kidPids.length === DESCENDANTS && kidPids.every(isAlive));

  const started = Date.now();
  const res = sweepDescendants(mid.pid, Date.now() - 1_000);
  const secs = Math.round((Date.now() - started) / 100) / 10;
  info('sweep result', JSON.stringify(res));
  info('sweep wall time', `${secs}s`);
  check('the sweep reports success (a look that ran, not one that could not)', res.failed === false);
  check('every live descendant is named as killed', kidPids.every((p) => res.killed.includes(p)),
    `killed ${JSON.stringify(res.killed)}`);
  await sleep(500);
  check('every descendant is actually gone afterwards', kidPids.every((p) => !isAlive(p)));
  check('the sweep stays far inside the budget it used to exhaust', secs < 25, `${secs}s`);
} catch (e) {
  check('the live-tree sweep ran', false, String(e));
} finally {
  for (const p of kidPids) killIfAlive(p);
  if (mid.pid !== undefined) killIfAlive(mid.pid);
}

// --------------------------------------------------------------- C. honesty ---
console.log('\n=== C. honesty: "no child" is not a failed look ===');
const none = sweepDescendants(undefined, Date.now());
info('sweepDescendants(undefined)', JSON.stringify(none));
check('no pid -> no kill, and NOT failed', none.failed === false && none.killed.length === 0);

const ghost = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore', windowsHide: true });
await new Promise((r) => ghost.on('close', r));
const after = sweepDescendants(ghost.pid, Date.now() - 5_000);
info('sweepDescendants(dead child)', JSON.stringify(after));
check('a child that left nothing behind -> not failed (no false alarm)', after.failed === false);

console.log('');
if (failures > 0) {
  console.log(`SWEEP-SCALE: FAIL (${failures} check(s) failed)`);
  process.exit(1);
}
console.log('SWEEP-SCALE: PASS - one snapshot per sweep, real survivors still killed, no false failures.');
process.exit(0);
