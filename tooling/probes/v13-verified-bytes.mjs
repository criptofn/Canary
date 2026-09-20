// v1.3 §20 — IS A VERDICT BOUND TO THE BYTES, OR TO A RECORD ABOUT THEM?
//
// This is the property the v1.3 audit's "invisible candidate/promotion lifecycle" exists to provide on the
// everyday path. The audit recorded an OPEN finding that the everyday path does not isolate or promote —
// no candidate, no frozen task authority — and the honest question is not whether that machinery is
// missing, but whether the GUARANTEE it is for is missing with it. The guarantee is: nothing is ever
// blessed on the strength of a stored record; a verdict is about the bytes in front of it, now.
//
// Canary's design says the checkpoint file and the evidence bundles are "NEVER read back to produce a
// verdict" (apps/cli/src/onboarding.ts). That is a claim in a comment, and this repository's own doctrine
// is that a claim is not evidence. So this probe attacks it directly, with the most convincing forgery it
// can build — a checkpoint record whose shape is byte-identical to what a real green run writes,
// `{at: <now>, status: 'pass', failed: [], source: 'checkpoint'}` — planted on a repository whose checks
// FAIL. If any stored record could produce a pass, this is how it would happen.
//
// The two controls are what make the result mean something. A gate that always blocks would pass every
// attack assertion for the wrong reason, so the probe brackets the attacks with a green run that must be
// ALLOWED — including one AFTER the forgery is planted, which also proves the forgery did not simply
// poison the repository.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(import.meta.dirname, '../..');
const cli = path.join(repo, 'apps/cli/dist/src/main.js');
const git = 'C:\\Program Files\\Git\\cmd\\git.exe';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-verified-bytes-'));
const project = path.join(temp, 'project');
let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}\n     ${String(e?.message ?? e).split('\n').join('\n     ')}`); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

// The trust store lives OUTSIDE the repository, as the default one does: pointing it inside makes the
// repo genuinely dirty and the gate then answers a different question (learned in the vocabulary probe).
const env = { ...process.env, CANARY_TRUST_STORE: path.join(temp, 'local-trust') };
const run = (exe, args, cwd) => spawnSync(exe, args, { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 300000 });
const canary = (args) => run(process.execPath, [cli, ...args], project);
const out = (r) => `${r.stdout ?? ''}${r.stderr ?? ''}`;

/** The hook's whole contract: a refusal is a JSON line with decision "block". An allow is silence. */
const blocked = (r) => (r.stdout ?? '').split('\n')
  .filter((l) => l.trim().startsWith('{'))
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .some((d) => d && d.decision === 'block');

const GREETING = 'module.exports = (name) => `Hello, ${name}!`;\n';
const BROKEN = 'module.exports = (name) => `Goodbye, ${name}!`;\n';
const checkpointPath = path.join(project, '.canary', 'last-checkpoint.json');

try {
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({
    name: 'verified-bytes', private: true, scripts: { test: 'node greeting.test.cjs' },
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(project, 'package-lock.json'), JSON.stringify({
    name: 'verified-bytes', version: '1.0.0', lockfileVersion: 3, requires: true, packages: {},
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(project, 'greeting.cjs'), GREETING);
  fs.writeFileSync(path.join(project, 'greeting.test.cjs'),
    "const assert = require('node:assert');\n"
    + "assert.strictEqual(require('./greeting.cjs')('a'), 'Hello, a!');\n");

  // Its OWN git repository: `findRepoRoot` walks up, so a bare temp dir answers about whatever encloses it.
  for (const args of [['init', '-b', 'main'], ['config', 'user.email', 'bytes@canary.local'],
    ['config', 'user.name', 'Verified Bytes Probe'], ['add', '-A'], ['commit', '-m', 'base']]) {
    const r = run(git, args, project);
    assert(r.status === 0, `fixture git ${args[0]} failed: ${r.stdout}${r.stderr}`);
  }
  const setup = canary(['setup', '--yes']);
  assert(setup.status === 0, `setup must succeed:\n${out(setup)}`);

  // ── CONTROL 1: a green tree is ALLOWED, so "block" below means something ──
  const green = canary(['checkpoint']);
  check('CONTROL-a-green-tree-is-allowed (otherwise every attack below would pass for the wrong reason)', () => {
    assert(green.status === 0, `checkpoint exited ${green.status} on a green tree:\n${out(green)}`);
    assert(!blocked(green), `a green tree was BLOCKED:\n${out(green)}`);
  });

  // ── the verdict follows the BYTES, not the earlier green run ──
  fs.writeFileSync(path.join(project, 'greeting.cjs'), BROKEN);
  const onBroken = canary(['checkpoint']);
  check('A1-breaking-the-code-BLOCKS-even-though-a-green-checkpoint-record-exists', () => {
    assert(blocked(onBroken), `the completion was allowed on a repository whose checks fail:\n${out(onBroken)}`);
  });

  // ── the core attack: forge the most convincing record possible, on the broken tree ──
  const realRecord = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
  const forgery = { at: new Date(Date.now() + 60_000).toISOString(), status: 'pass', failed: [], source: 'checkpoint' };
  fs.writeFileSync(checkpointPath, JSON.stringify(forgery, null, 2) + '\n');
  console.log(`INFO forged record: ${JSON.stringify(forgery)}`);
  console.log(`INFO (the real record from the failing run was: status=${realRecord.status} failed=${JSON.stringify(realRecord.failed)} source=${realRecord.source})`);

  const afterForge = canary(['checkpoint']);
  check('A2-a-forged-PASS-record-cannot-allow-a-completion-on-failing-bytes', () => {
    assert(blocked(afterForge),
      'a forged checkpoint record produced an ALLOW on a repository whose checks fail — the record is '
      + `being read back to produce a verdict:\n${out(afterForge)}`);
  });

  const doctorForged = canary(['doctor']);
  check('A3-doctor-is-not-READY-on-failing-bytes-while-the-forgery-is-present', () => {
    assert(doctorForged.status !== 0, `doctor exited 0 (READY) with a forged pass record present:\n${out(doctorForged)}`);
    assert(!/READY/.test(out(doctorForged).match(/^.*(READY|NOT PROVEN|NEEDS ATTENTION|UNSUPPORTED).*$/m)?.[0] ?? ''),
      `doctor reported READY on failing bytes:\n${out(doctorForged)}`);
  });

  // ── CONTROL 2: with the forgery STILL on disk, repairing the code must allow again ──
  fs.writeFileSync(path.join(project, 'greeting.cjs'), GREETING);
  const repaired = canary(['checkpoint']);
  check('CONTROL-repairing-the-bytes-allows-again-with-the-forgery-still-on-disk', () => {
    assert(repaired.status === 0, `checkpoint exited ${repaired.status} after repair:\n${out(repaired)}`);
    assert(!blocked(repaired),
      `repairing the code did not restore an allow, so the block above may have been caused by the forged `
      + `FILE rather than by the failing bytes:\n${out(repaired)}`);
  });

  // ── and the forgery must be labelled as what it is, not silently trusted ──
  const status = canary(['status']);
  check('A4-status-labels-a-stored-record-as-NOT-a-claim-about-now', () => {
    const text = out(status);
    assert(/NOT a claim about now/i.test(text),
      `status did not disclaim the stored record:\n${text.split('\n').slice(0, 12).join('\n')}`);
  });

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} v1.3 verified bytes — the verdict follows the bytes, not a record about them`);
  process.exit(failures === 0 ? 0 : 1);
} catch (e) {
  console.log(`FAIL v1.3 verified bytes — ${String(e?.message ?? e)}`);
  process.exit(1);
} finally {
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* best effort */ }
}
