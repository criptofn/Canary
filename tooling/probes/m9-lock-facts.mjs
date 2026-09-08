#!/usr/bin/env node
/**
 * M9 design gate: the authority-guard mechanism depends on mandatory file
 * locks (fs/promises FileHandle.lock). This probe measures what the host
 * ACTUALLY does — never a guess:
 *   1. does FileHandle.lock('exclusive') exist on this node?
 *   2-5. while the lock is held by a SEPARATE process (lock state is
 *      per-process, so in-process measurement would be fiction), can another
 *      same-user process WRITE / APPEND / REPLACE-via-rename / DELETE the
 *      file? Each answer decides whether the guard covers that verb or must
 *      rely on detection instead of prevention.
 * Prints PASS/FAIL facts; exit 0 when the facts were gathered and the bytes
 * survived the attempts (the actual prevention model). Self-cleaning.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let fail = false;
const line = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) fail = true; };

// Measure the REAL handle, not the class export: a prototype lookup against a
// possibly-unexposed class would report absence even if open() hands out locks.
const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-m9lockapi-'));
let hasLock = false;
try {
  const sample = path.join(probeDir, 'f');
  fs.writeFileSync(sample, 'x');
  const fh = await fs.promises.open(sample, 'r+');
  hasLock = typeof fh.lock === 'function';
  const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(fh) ?? {}).join(', ');
  console.log(`node ${process.version} ${process.platform}; FileHandle methods: ${proto}`);
  await fh.close();
} finally {
  fs.rmSync(probeDir, { recursive: true, force: true });
}
if (!hasLock) {
  line(true, 'FileHandle.lock ABSENT on this runtime — mandatory-lock prevention is off the table; M9 guard must be detection-at-edges + fail-closed (fact recorded, design decision made)');
  console.log('M9-LOCK-FACTS: facts gathered');
  process.exit(0);
}
line(true, 'FileHandle.lock exists — measuring per-verb behavior across processes');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-m9lock-'));
try {
  const target = path.join(dir, 'authority.json');
  fs.writeFileSync(target, 'ORIGINAL');
  const holderScript = path.join(dir, 'holder.mjs');
  fs.writeFileSync(holderScript, `
import fs from 'node:fs';
const fh = await fs.promises.open(${JSON.stringify(target)}, 'r+');
await fh.lock('exclusive');
console.log('LOCKED');
setInterval(() => {}, 5000);
`);
  const hp = spawn(process.execPath, [holderScript], { stdio: ['ignore', 'pipe', 'pipe'] });
  let errBuf = '';
  hp.stderr.on('data', (d) => { errBuf += String(d); });
  const ready = await new Promise((resolve) => {
    hp.stdout.on('data', (d) => { if (String(d).includes('LOCKED')) resolve(true); });
    hp.on('error', () => resolve(false));
    setTimeout(() => resolve(false), 15_000);
  });
  if (!ready) { line(false, `lock holder never announced LOCKED (${errBuf.slice(0, 200)})`); hp.kill(); }
  else {
    line(true, 'holder process holds exclusive lock');
    const tryOp = (label, fn) => {
      try { fn(); line(true, `${label}: SUCCEEDED while locked — lock does NOT prevent this verb`); }
      catch (e) { line(true, `${label}: DENIED while locked (${e.code ?? e.message})`); }
    };
    tryOp('truncate-write', () => { fs.writeFileSync(target, 'PWNED'); });
    tryOp('append', () => { fs.appendFileSync(target, 'x'); });
    const alt = path.join(dir, 'alt.json');
    fs.writeFileSync(alt, 'REPLACED');
    tryOp('rename-onto', () => { fs.renameSync(alt, target); });
    tryOp('delete', () => { fs.unlinkSync(target); });
    const after = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '(file gone)';
    line(after === 'ORIGINAL', `bytes survived all attempts: "${after}"`);
    hp.kill();
    await new Promise((r) => hp.on('exit', r));
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(fail ? 'M9-LOCK-FACTS: FAIL' : 'M9-LOCK-FACTS: facts gathered');
process.exit(fail ? 1 : 0);
