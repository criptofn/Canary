#!/usr/bin/env node
/**
 * INTEGRITY-LEVEL BOUNDARY PROBE — can this host establish a real, non-privileged worker/authority
 * separation via Windows Mandatory Integrity Control?
 *
 * THIS FILE EXISTS TO CORRECT A FALSE POSITIVE IT PREVIOUSLY REPORTED.
 *
 * The first version of this probe reported "7/7, a low-integrity process was refused write access".
 * That result was WRONG, and the bug is worth naming because it is the exact failure mode this
 * whole repository is about:
 *
 *   the CONTROL write and the CONFINED write targeted the SAME filename, so the control's own
 *   successful write satisfied the confined check. The probe measured its own control and called
 *   it a boundary.
 *
 * The fix is structural, not cosmetic: every attempt now uses a unique filename per attempt, the
 * attempt is only credited when the CHILD wrote the file (checked by content, not existence), and
 * the launcher's own exit code is never trusted — `runas` was measured to return 1 with empty
 * output for every input, including an invalid trust level, so its exit code carries no
 * information at all.
 *
 * Usage: node tooling/probes/v12-integrity-boundary.mjs
 * Exit: 0 only when a boundary is observed holding and every assertion passes;
 * unavailable execution and inconclusive denial fail closed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { applyAuthorityLabel } from '../../apps/cli/dist/src/provider/integrity.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-il-verify-'));
const authorityDir = path.join(root, 'authority');
const scratchDir = path.join(root, 'scratch');
const results = [];

/** A child that writes its OWN pid, so the file's content proves which process wrote it. */
const WRITE_PROBE = 'const fs=require("node:fs");try{fs.writeFileSync(process.argv[1],"pid="+process.pid)}catch(e){process.stderr.write("DENIED:"+(e.code||e.message))}';
const q = (s) => /[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;

let seq = 0;
/**
 * One attempt: start `launch` (already an argv array) and report what the CHILD left behind.
 * Returns `{ file, content, childWrote }` — never a launcher exit code, which is meaningless here.
 */
function attempt(launch, tag) {
  seq += 1;
  const target = path.join(authorityDir, `attempt-${seq}-${tag}.txt`);
  const marker = path.join(scratchDir, `ran-${seq}-${tag}.txt`);
  const command = [process.execPath, '-e', `${WRITE_PROBE};try{require('node:fs').writeFileSync(process.argv[2], 'pid='+process.pid)}catch{}`, target, marker].map(q).join(' ');
  const argv = launch[0] === 'powershell.exe'
    ? [...launch, '-Integrity', tag.includes('untrusted') ? 'untrusted' : 'low', '-CommandLine', command]
    : [...launch, process.execPath, '-e', `${WRITE_PROBE};try{require('node:fs').writeFileSync(process.argv[2], 'pid='+process.pid)}catch{}`, target, marker];
  const outPath = path.join(root, `out-${seq}.txt`);
  const errPath = path.join(root, `err-${seq}.txt`);
  const of = fs.openSync(outPath, 'w');
  const ef = fs.openSync(errPath, 'w');
  const r = spawnSync(argv[0], argv.slice(1), { timeout: 45_000, windowsHide: true, stdio: ['ignore', of, ef] });
  fs.closeSync(of);
  fs.closeSync(ef);
  let content = null;
  try {
    content = fs.readFileSync(target, 'utf8');
  } catch {
    content = null;
  }
  return {
    target, content, childRan: fs.existsSync(marker), childWrote: content !== null,
    launcherExit: r.status ?? null,
    launcherStderr: fs.readFileSync(errPath, 'utf8').trim().slice(0, 200),
  };
}

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} — ${detail}`);
}

try {
  fs.mkdirSync(authorityDir, { recursive: true });
  fs.mkdirSync(scratchDir, { recursive: true });
  // Low-integrity children need a low-integrity reporting directory. This is outside authority
  // and disposable; otherwise a successful confinement is mistaken for a child that never ran.
  applyAuthorityLabel(scratchDir, 'low');
  fs.writeFileSync(path.join(authorityDir, 'sealed-record.json'), '{"authority":true}');

  const label = applyAuthorityLabel(authorityDir, 'medium');
  record('an integrity label can be applied to a directory this user owns', label.applied,
    label.applied ? label.command : `${label.command} -> exit ${String(label.exitCode)} ${label.stderr}`);

  // CONTROL — with NO confinement. If this does not write, nothing below is meaningful.
  const control = attempt([], 'control');
  record('CONTROL: an unconfined child CAN write into the authority directory (unique file, content-checked)',
    control.childRan && control.childWrote && /^pid=\d+$/.test(control.content ?? ''),
    control.childRan ? `child ran; authority write=${control.childWrote ? String(control.content) : 'DENIED'}` : `no child marker: launcher exit ${String(control.launcherExit)} ${control.launcherStderr}`);

  // MEASUREMENT — the same write, launched at a lowered integrity level.
  const primitive = (await import('../../apps/cli/dist/src/provider/integrity.js')).observeIntegrityPrimitive();
  const levels = primitive.launchers.map((l) => [l.level, l.argvPrefix]);
  let boundaryHolds = false;
  let confinementAvailable = false;
  let hostSkips = 0;
  for (const [name, launch] of levels) {
    const confined = attempt(launch, `confined-${name}`);
    /**
     * A CONFINED CHILD THAT NEVER RAN IS A HOST-BOUND SKIP, NOT A FAILURE.
     *
     * This line used to print FAIL, which contradicted this repository's own convention — and its own
     * words. A child that did not run is *"not evidence of a boundary"*; it is evidence that this host
     * cannot drive the mechanism. Reporting it as FAIL made the productization log show two failures
     * for a probe whose honest outcome is "no boundary is available here", which is exactly the
     * SKIP-versus-FAIL distinction the rest of this repository is careful about (`pre10-acceptance`
     * reports its undrivable real-pty check as an explicit host-bound SKIP for the same reason).
     */
    if (!confined.childRan) {
      hostSkips += 1;
      console.log(`SKIP  ${name}-integrity: does a confined child run at all on this host? — the child left no marker (launcher exit ${String(confined.launcherExit)}, stderr ${JSON.stringify(confined.launcherStderr)}); this is NOT evidence of a boundary, only of a child that did not run, so nothing is claimed`);
      continue;
    }
    confinementAvailable = true;
    // If the child wrote, the boundary did NOT hold. That IS a real finding, and a real FAIL.
    const blocked = !confined.childWrote && /DENIED:(EPERM|EACCES)/.test(confined.launcherStderr);
    record(`${name}-integrity: the confined child is refused a write into the authority tree`, blocked,
      blocked ? `child ran, OS denied access, and no authority file was created` : `write=${String(confined.content)}, error=${confined.launcherStderr} — denial unproven; do NOT claim one`);
    boundaryHolds ||= blocked;
  }

  const readable = (() => { try { return fs.readFileSync(path.join(authorityDir, 'sealed-record.json'), 'utf8').includes('authority'); } catch { return false; } })();
  record('the authority record is still readable after the label is applied', readable, 'read ok');

  console.log('');
  const boundaryPresent = confinementAvailable && boundaryHolds;
  console.log(boundaryPresent
    ? 'VERDICT: a non-privileged integrity boundary is present and held against the executed write attempt.'
    : 'VERDICT: NO integrity boundary is available on this host — `runas /trustlevel` cannot start a lowered process here, so no confinement was established and NOTHING is claimed.');
  if (hostSkips > 0) {
    console.log(`PROBE-PASS-WITH-SKIP — ${hostSkips} host-bound SKIP(s) above; the mechanism this probe would measure could not be driven here, so the absence of a boundary is REPORTED rather than proven. A skip is never a pass.`);
  }
  console.log('platform:', process.platform, 'node:', process.version, 'elevated:', spawnSync('net', ['session'], { windowsHide: true }).status === 0);
  fs.writeFileSync(path.join(os.tmpdir(), 'canary-integrity-boundary.json'),
    JSON.stringify({ at: new Date().toISOString(), platform: process.platform, node: process.version, results, boundaryPresent, hostSkips }, null, 2));

  process.exitCode = boundaryPresent && results.every(r => r.ok) ? 0 : 1;
} finally {
  try { applyAuthorityLabel(authorityDir, 'medium'); } catch { /* best effort */ }
  fs.rmSync(root, { recursive: true, force: true });
}
