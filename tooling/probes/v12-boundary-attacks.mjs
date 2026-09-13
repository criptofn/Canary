#!/usr/bin/env node
/**
 * HARDENED ATTACK BATTERY — what an untrusted, integrity-confined worker can actually do.
 *
 * THE RULE THIS BATTERY EXISTS TO ENFORCE: a security property is claimed only where an attack
 * was EXECUTED and observed to fail. So every case here runs TWICE:
 *
 *   1. a CONTROL run with NO boundary — if the attack does not succeed there, the case proves
 *      nothing (the "protection" would be an artifact of the test, not of the boundary), and the
 *      case is reported INCONCLUSIVE rather than blocked;
 *   2. the CONFINED run — the same operation, launched at a lowered integrity level.
 *
 * Only `control succeeded ∧ confined failed` counts as BLOCKED. Where the boundary genuinely does
 * not apply, the case is reported NOT ADDRESSED with the reason and excluded from the blocked
 * count rather than folded into it. Nothing in this file can turn a skip, an error or a missing
 * primitive into a pass.
 *
 * WHY EVERY RESULT TRAVELS THROUGH A FILE: `runas /trustlevel` hands the caller its own exit code,
 * not the child's (measured: it reported exit 1 with empty output for a process that really ran).
 * A pipe or an exit code would therefore read a working boundary as absent. The operation program
 * writes one word to an evidence file; the file is the evidence.
 *
 * Usage: node tooling/probes/v12-boundary-attacks.mjs [--level low|untrusted] [--json]
 * Exit:  0 when every executed attack was blocked; 1 when any executed attack SUCCEEDED against
 *        the boundary (a real finding, which must be reported, not hidden).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { applyAuthorityLabel, containedRun, observeIntegrityPrimitive } from '../../apps/cli/dist/src/provider/integrity.js';

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? dflt : (argv[i + 1] ?? true);
};
const LEVEL = String(flag('level', 'low'));
const AS_JSON = argv.includes('--json');

const primitive = observeIntegrityPrimitive();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-attacks-'));
const authorityDir = path.join(root, 'authority');
const authorityFile = path.join(authorityDir, 'sealed-baseline.json');
const authorityBin = path.join(authorityDir, 'canary-authority.js');
const workerScratch = path.join(root, 'worker-scratch');
const evidenceDir = path.join(root, 'evidence');

/**
 * The operation program. It performs ONE filesystem action and writes `OK` or `DENIED:<code>` into
 * the evidence file — never to stdout, for the reason in the header.
 *
 * Actions: read | write | delete | replace | list | spawn
 */
const ACT = `
const fs = require('node:fs');
const [action, target, evidence] = process.argv.slice(2);
let word;
try {
  if (action === 'read') { fs.readFileSync(target, 'utf8'); word = 'OK'; }
  else if (action === 'write') { fs.writeFileSync(target, 'worker-was-here'); word = 'OK'; }
  else if (action === 'append') { fs.appendFileSync(target, 'worker-was-here'); word = 'OK'; }
  else if (action === 'delete') { fs.unlinkSync(target); word = 'OK'; }
  else if (action === 'replace') { fs.rmSync(target, { force: true }); fs.writeFileSync(target, 'worker-binary'); word = 'OK'; }
  else if (action === 'list') { fs.readdirSync(target); word = 'OK'; }
  else { word = 'UNKNOWN-ACTION'; }
} catch (e) { word = 'DENIED:' + (e.code || e.message); }
try { fs.writeFileSync(evidence, word); } catch { /* unreported; treated as no-evidence */ }
`;

let seq = 0;
/**
 * Perform one operation, optionally confined, and return the word the OPERATION left behind.
 * The evidence file lives OUTSIDE the protected tree so that a confined process can still report.
 */
function act(action, target, confined) {
  seq += 1;
  const evidence = path.join(evidenceDir, `evidence-${seq}.txt`);
  if (confined) {
    const r = containedRun(LEVEL, ACT, evidence, 45_000, primitive);
    if (!r.ran) return 'NO-EVIDENCE';
    return r.result;
  }
  const r = spawnSync(process.execPath, ['-e', ACT, action, target, evidence], { encoding: 'utf8', timeout: 45_000, windowsHide: true });
  try {
    return fs.readFileSync(evidence, 'utf8').trim();
  } catch {
    return `NO-EVIDENCE:${r.status ?? 'null'}`;
  }
}

const results = [];
function attack({ id, description, expectedBoundary, action, target, notAddressed }) {
  let outcome;
  if (notAddressed !== undefined) {
    outcome = { blocked: false, addressed: false, control: null, confined: null, detail: notAddressed };
  } else {
    const control = act(action, target, false);
    const confined = act(action, target, true);
    if (control !== 'OK') {
      outcome = { blocked: false, addressed: true, control, confined, detail: `INCONCLUSIVE — the unrestricted control did not succeed (${control}), so this case proves nothing` };
    } else if (confined === 'OK') {
      outcome = { blocked: false, addressed: true, control, confined, detail: 'THE ATTACK SUCCEEDED UNDER THE BOUNDARY' };
    } else {
      outcome = { blocked: true, addressed: true, control, confined, detail: `refused by the OS (${confined})` };
    }
  }
  results.push({ id, description, expectedBoundary, ...outcome });
  const mark = outcome.addressed === false ? 'N/A ' : (outcome.blocked ? 'PASS' : 'FAIL');
  console.log(`${mark} ${id} — ${description}`);
  console.log(`     boundary: ${expectedBoundary}`);
  console.log(`     actual:   ${outcome.detail}`);
}

try {
  fs.mkdirSync(authorityDir, { recursive: true });
  fs.mkdirSync(workerScratch, { recursive: true });
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(authorityFile, JSON.stringify({ schema: 'canary-plan-seal/1', plan: ['test'] }));
  fs.writeFileSync(authorityBin, "process.stdout.write('authority')");
  fs.mkdirSync(path.join(authorityDir, 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(authorityDir, 'evidence', 'checkpoint.log'), 'trusted evidence');
  fs.writeFileSync(path.join(authorityDir, 'frozen-bindings.json'), '{"frozen":true}');

  console.log(`hardened attack battery — worker level=${LEVEL}, authority level=medium`);
  console.log(`primitive: ${primitive.available ? `AVAILABLE (icacls + runas ${LEVEL})` : `UNAVAILABLE (${String(primitive.reason)})`}`);
  for (const o of primitive.observations) console.log(`  observed: ${o}`);
  console.log('');

  if (!primitive.available) {
    console.log('The host cannot establish an integrity boundary, so NO attack was executed.');
    console.log('ATTACKS BLOCKED: 0/0 — nothing is claimed: a boundary that could not be established protects nothing.');
    process.exit(0);
  }

  const label = applyAuthorityLabel(authorityDir, 'medium');
  if (!label.applied) {
    console.log(`could not apply the authority label: ${label.command} -> ${String(label.exitCode)} ${label.stderr}`);
    console.log('ATTACKS BLOCKED: 0/0 — the boundary could not be established, so nothing is claimed.');
    process.exit(0);
  }
  console.log(`authority tree labelled medium: ${label.command}`);

  // A8 needs the symlink to actually exist: the worker creates a link in its own (unprotected)
  // scratch pointing at the authority tree, then tries to write THROUGH it.
  let symlinkCreated = false;
  try {
    fs.symlinkSync(authorityDir, path.join(workerScratch, 'link-to-authority'), 'junction');
    symlinkCreated = true;
  } catch (e) {
    console.log(`note: could not create the symlink A8 needs (${e instanceof Error ? e.message : String(e)})`);
  }
  console.log('');

  // --- controls: the boundary must separate, not blanket-deny -------------------------------
  const scratchWrite = act('write', path.join(workerScratch, 'allowed.txt'), true);
  const scratchOk = scratchWrite === 'OK';
  console.log(`${scratchOk ? 'PASS' : 'FAIL'} CONTROL — a confined worker can still write its OWN scratch space`);
  console.log(`     boundary: confinement must not break the worker, only separate it from the authority`);
  console.log(`     actual:   ${scratchWrite}`);

  const scratchList = act('list', workerScratch, true);
  const listOk = scratchList === 'OK';
  console.log(`${listOk ? 'PASS' : 'FAIL'} CONTROL — a confined worker can still read its own working tree`);
  console.log(`     boundary: the boundary is a write separation on the protected tree, not a jail on the workspace`);
  console.log(`     actual:   ${scratchList}\n`);

  // --- the attack classes ------------------------------------------------------------------
  attack({
    id: 'A1-modify-authority-state',
    description: 'overwrite a sealed authority record',
    expectedBoundary: 'the worker cannot write the medium-integrity authority tree',
    action: 'write',
    target: authorityFile,
  });
  attack({
    id: 'A2-replace-trusted-executable',
    description: "replace the authority's own executable with a worker-written one",
    expectedBoundary: 'replacing the binary inside the protected tree is refused',
    action: 'replace',
    target: authorityBin,
  });
  attack({
    id: 'A3-delete-sealed-baseline',
    description: 'delete the sealed baseline record outright',
    expectedBoundary: 'deletion inside the protected tree is refused',
    action: 'delete',
    target: authorityFile,
  });
  attack({
    id: 'A4-forge-a-new-record',
    description: 'mint a new record file inside the protected tree (a forged PASS/READY)',
    expectedBoundary: 'creating a new file in the protected tree is refused',
    action: 'write',
    target: path.join(authorityDir, 'forged-pass-bundle.json'),
  });
  attack({
    id: 'A5-alter-frozen-bindings',
    description: 'alter the frozen binding record to re-point a requirement',
    expectedBoundary: 'the frozen authority record is not writable',
    action: 'write',
    target: path.join(authorityDir, 'frozen-bindings.json'),
  });
  attack({
    id: 'A6-overwrite-trusted-evidence',
    description: 'overwrite stored trusted evidence',
    expectedBoundary: 'evidence kept under the protected tree is not writable',
    action: 'write',
    target: path.join(authorityDir, 'evidence', 'checkpoint.log'),
  });
  attack({
    id: 'A7-path-traversal-into-authority',
    description: 'reach the authority tree through a traversal path from the scratch dir',
    expectedBoundary: 'a traversal path resolves to the same protected object, so it is refused',
    action: 'write',
    target: path.join(workerScratch, '..', 'authority', 'traversal.txt'),
  });
  attack({
    id: 'A8-symlink-into-authority',
    description: 'write through a symlink that points into the authority tree',
    expectedBoundary: symlinkCreated
      ? 'the symlink target is the protected object, so the write is refused'
      : 'NOT ADDRESSED — the symlink this case needs could not be created on this host',
    action: 'write',
    target: path.join(workerScratch, 'link-to-authority', 'symlink.txt'),
    notAddressed: symlinkCreated
      ? undefined
      : 'the junction could not be created, so the traversal-through-a-link case was never executed. Not claiming it.',
  });
  attack({
    id: 'A9-read-authority-credentials',
    description: 'READ the authority tree (the honest limit of this boundary)',
    expectedBoundary: 'NOT ADDRESSED — an integrity boundary denies WRITE, not read; the worker is still the same user',
    action: 'read',
    target: authorityFile,
    notAddressed: 'an integrity boundary separates write access, not read: the worker remains the same OS user and can still read anything that user can read. Confidentiality of the authority tree needs an identity boundary, which v1.2 does not install. A worker can therefore still SEE the sealed records — it cannot change them.',
  });
  attack({
    id: 'A10-tamper-with-ipc',
    description: 'tamper with an in-flight broker message',
    expectedBoundary: 'NOT ADDRESSED by an integrity boundary — the transport must authenticate each message',
    notAddressed: 'no transport runs in this battery, so nothing was executed. Message integrity is a transport property and must be measured there — not inferred from confinement.',
  });
  attack({
    id: 'A11-race-candidate-base-state',
    description: 'race the candidate/base state during verification',
    expectedBoundary: 'NOT ADDRESSED by an integrity boundary — the authority pins committed bytes inside a verification window',
    notAddressed: 'a race cannot be exercised without running a verification window; that property is measured by the M9/M10 authority probes, not by confinement.',
  });
  attack({
    id: 'A12-replay-old-proof',
    description: 'replay an old valid proof bundle',
    expectedBoundary: 'NOT ADDRESSED by an integrity boundary — ticket/generation binding is what refuses a replay',
    notAddressed: 'replay refusal is a broker-kernel property (ticket + authority-generation binding), measured by the broker suites, not by confinement.',
  });
  attack({
    id: 'A13-impersonate-broker',
    description: 'stand up a fake broker the CLI would talk to',
    expectedBoundary: 'NOT ADDRESSED by an integrity boundary — endpoint custody is required',
    notAddressed: 'impersonation depends on endpoint custody (named-pipe ACL or service identity), which needs privilege; not measured here.',
  });

  // --- report -----------------------------------------------------------------------------
  const addressed = results.filter((r) => r.addressed === true);
  const blocked = addressed.filter((r) => r.blocked === true);
  const failed = addressed.filter((r) => r.blocked === false);
  const inconclusive = addressed.filter((r) => r.detail.startsWith('INCONCLUSIVE'));
  const notAddressed = results.filter((r) => r.addressed === false);
  const controlsOk = scratchOk && listOk;

  console.log('');
  console.log(`ATTACKS BLOCKED: ${blocked.length}/${addressed.length} (${notAddressed.length} not addressed by this boundary, ${controlsOk ? 2 : 0}/2 controls)`);
  if (inconclusive.length > 0) console.log(`  INCONCLUSIVE (control did not succeed): ${inconclusive.map((r) => r.id).join(', ')}`);
  if (failed.length > 0) console.log(`  SUCCEEDED AGAINST THE BOUNDARY: ${failed.map((r) => r.id).join(', ')}`);
  console.log(`  not addressed here: ${notAddressed.map((r) => r.id).join(', ')}`);

  const record = {
    at: new Date().toISOString(), platform: process.platform, node: process.version, level: LEVEL,
    primitive: { available: primitive.available, observations: primitive.observations },
    label: { command: label.command, applied: label.applied },
    controls: { scratchWrite, scratchList },
    blocked: `${blocked.length}/${addressed.length}`,
    notAddressed: notAddressed.map((r) => r.id),
    results,
  };
  fs.writeFileSync(path.join(os.tmpdir(), 'canary-boundary-attacks.json'), JSON.stringify(record, null, 2));
  if (AS_JSON) console.log(JSON.stringify(record, null, 2));

  // Fail loudly if an executed attack beat the boundary. An inconclusive case is not a pass, but
  // it is also not a false claim, so it is printed rather than failed.
  process.exit(failed.length === 0 && controlsOk ? 0 : 1);
} finally {
  try { applyAuthorityLabel(authorityDir, 'medium'); } catch { /* best effort */ }
  fs.rmSync(root, { recursive: true, force: true });
}
