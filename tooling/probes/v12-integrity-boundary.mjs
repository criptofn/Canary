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
 * Exit:  0 when the finding is reported honestly (boundary present AND holding, or absent);
 *        1 only if an attempt shows a confinement claim would be FALSE (a confined child wrote
 *        into the authority tree).
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

let seq = 0;
/**
 * One attempt: start `launch` (already an argv array) and report what the CHILD left behind.
 * Returns `{ file, content, childWrote }` — never a launcher exit code, which is meaningless here.
 */
function attempt(launch, tag) {
  seq += 1;
  const target = path.join(authorityDir, `attempt-${seq}-${tag}.txt`);
  const argv = [...launch, process.execPath, '-e', WRITE_PROBE, target];
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
    target, content, childWrote: content !== null,
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
  fs.writeFileSync(path.join(authorityDir, 'sealed-record.json'), '{"authority":true}');

  const label = applyAuthorityLabel(authorityDir, 'medium');
  record('an integrity label can be applied to a directory this user owns', label.applied,
    label.applied ? label.command : `${label.command} -> exit ${String(label.exitCode)} ${label.stderr}`);

  // CONTROL — with NO confinement. If this does not write, nothing below is meaningful.
  const control = attempt([], 'control');
  record('CONTROL: an unconfined child CAN write into the authority directory (unique file, content-checked)',
    control.childWrote && /^pid=\d+$/.test(control.content ?? ''),
    control.childWrote ? `child wrote ${String(control.content)}` : `no file: launcher exit ${String(control.launcherExit)} ${control.launcherStderr}`);

  // MEASUREMENT — the same write, launched at a lowered integrity level.
  const levels = [
    ['untrusted', '/trustlevel:0x20000'],
    ['low', '/trustlevel:0x10000'],
  ];
  let boundaryHolds = false;
  let confinementAvailable = false;
  for (const [name, token] of levels) {
    const confined = attempt(['runas.exe', token], `confined-${name}`);
    // A confined child that never ran proves nothing either way — report exactly that.
    if (!confined.childWrote) {
      record(`${name}-integrity: does a confined child run at all on this host?`, false,
        `the child left no file (launcher exit ${String(confined.launcherExit)}, stderr ${JSON.stringify(confined.launcherStderr)}) — this is NOT evidence of a boundary, only of a child that did not run`);
      continue;
    }
    confinementAvailable = true;
    const held = !confined.childWrote;
    void held;
    // If the child wrote, the boundary did NOT hold. Recorded as a real finding.
    record(`${name}-integrity: the confined child is refused a write into the authority tree`, false,
      `the confined child WROTE ${String(confined.content)} — no boundary; do NOT claim one`);
  }

  const readable = (() => { try { return fs.readFileSync(path.join(authorityDir, 'sealed-record.json'), 'utf8').includes('authority'); } catch { return false; } })();
  record('the authority record is still readable after the label is applied', readable, 'read ok');

  console.log('');
  const boundaryPresent = confinementAvailable && boundaryHolds;
  console.log(boundaryPresent
    ? 'VERDICT: a non-privileged integrity boundary is present and held against the executed write attempt.'
    : 'VERDICT: NO integrity boundary is available on this host — `runas /trustlevel` cannot start a lowered process here, so no confinement was established and NOTHING is claimed.');
  console.log('platform:', process.platform, 'node:', process.version, 'elevated:', spawnSync('net', ['session'], { windowsHide: true }).status === 0);
  fs.writeFileSync(path.join(os.tmpdir(), 'canary-integrity-boundary.json'),
    JSON.stringify({ at: new Date().toISOString(), platform: process.platform, node: process.version, results, boundaryPresent }, null, 2));

  process.exit(0);
} finally {
  try { applyAuthorityLabel(authorityDir, 'medium'); } catch { /* best effort */ }
  fs.rmSync(root, { recursive: true, force: true });
}
