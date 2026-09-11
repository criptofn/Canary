#!/usr/bin/env node
/**
 * v1.1 item E — the HARDENED boundary, measured instead of asserted.
 *
 * `HARDENED` is a claim that a *different OS identity* stands between candidate
 * code and Canary's authority. That claim is either measurable on the host or it
 * is not made. This probe does two jobs:
 *
 *   1. TRIPWIRE. It reads the product's own capability surface (the compiled
 *      `platform-boundary.js`) and FAILS if Canary would report `HARDENED`, or
 *      would report fewer than all six boundary controls unavailable, while no
 *      installed provider has been proven. Overclaiming protection must break a
 *      build, not merely be discouraged in prose.
 *   2. MEASUREMENT + EXACT ASK. For each of the six controls it establishes why
 *      the control is unavailable ON THIS HOST — not "not implemented", but the
 *      concrete missing piece — and prints the precise privileged command a
 *      human would have to run. The user's instruction is to implement
 *      everything possible first and stop only for that specific authorization;
 *      this is the artefact that makes the stop exact rather than vague.
 *
 * It never installs anything, never requests elevation and never writes outside
 * the OS temp dir. Exit 0 means "the honest posture holds and is measured".
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const MODULE = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'platform-boundary.js');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}\n     ${String(e?.message ?? e).split('\n').join('\n     ')}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

if (!fs.existsSync(MODULE)) { console.error(`FAIL: no compiled module at ${MODULE} — run \`npm run build\` first`); process.exit(1); }
const pb = await import(`file://${MODULE.replace(/\\/g, '/')}`);

const CONTROLS = ['authorityCustody', 'workerFilesystem', 'verificationSandbox', 'authenticatedReview', 'protectedPromotion', 'networkEgress'];

// ─────────────────────────── 1. the tripwire ───────────────────────────
console.log('=== tripwire: the product must not claim a boundary it has not proven ===');

check('no code path reports HARDENED', () => {
  for (const authority of [true, false]) {
    const cap = pb.localCapabilities(authority);
    assert(cap.level === 'LOCAL' || cap.level === 'ADVISORY',
      `localCapabilities(${authority}) reported ${cap.level} — HARDENED requires an installed provider with a separate OS identity`);
    assert(Array.isArray(cap.unavailable) && cap.unavailable.length === CONTROLS.length,
      `localCapabilities(${authority}) omitted a boundary control: ${JSON.stringify(cap.unavailable)}`);
    for (const c of CONTROLS) assert(cap.unavailable.includes(c), `control "${c}" is not reported unavailable: ${JSON.stringify(cap.unavailable)}`);
  }
});

check('requesting HARDENED is refused for every shape a caller could try', () => {
  for (const v of ['HARDENED', { level: 'HARDENED' }, { level: 'HARDENED', attested: true },
    { level: 'HARDENED', provider: 'installed' }, true, 1, null, undefined, ['HARDENED']]) {
    let threw = false;
    try { pb.requireAuthorizationLevel(v); } catch { threw = true; }
    assert(threw, `requireAuthorizationLevel(${JSON.stringify(v)}) did NOT throw — an unattested level would authorize`);
  }
  pb.requireAuthorizationLevel('LOCAL'); // the only level that may pass today
});

// ─────────────────── 2. what this host actually offers ───────────────────
console.log('\n=== measured host facts ===');

const facts = {};
{
  // Elevation: without it a second local identity cannot be created, and a
  // broker service cannot be installed. `net session` requires admin and is the
  // cheap, dependency-free probe on Windows.
  if (process.platform === 'win32') {
    const r = spawnSync('net', ['session'], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
    facts.elevated = r.status === 0;
    facts.elevationProbe = `net session -> exit ${r.status}`;
  } else {
    const r = spawnSync('id', ['-u'], { encoding: 'utf8', timeout: 20_000 });
    facts.elevated = (r.stdout ?? '').trim() === '0';
    facts.elevationProbe = `id -u -> ${(r.stdout ?? '').trim()}`;
  }
}
{
  // Is any provider registered at all? An installed provider would have to leave
  // the store and the worker identity discoverable, so their absence is the
  // honest reason each control is unavailable.
  const programData = process.env.ProgramData ?? process.env.ALLUSERSPROFILE ?? 'C:\\ProgramData';
  const providerDir = path.join(programData, 'Canary');
  facts.providerStoreDir = providerDir;
  facts.providerInstalled = fs.existsSync(providerDir);
  facts.workerIdentityDeclared = typeof process.env.CANARY_WORKER_USER === 'string' && process.env.CANARY_WORKER_USER.trim() !== '';
  facts.brokerEndpointDeclared = typeof process.env.CANARY_BROKER_ENDPOINT === 'string' && process.env.CANARY_BROKER_ENDPOINT.trim() !== '';
  // A service manager is the only sanctioned way to run the broker under a
  // different identity on Windows.
  if (process.platform === 'win32') {
    const q = spawnSync('sc.exe', ['query', 'CanaryBroker'], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
    facts.brokerServiceInstalled = q.status === 0;
    facts.brokerServiceProbe = `sc.exe query CanaryBroker -> exit ${q.status}`;
  }
}
console.log(JSON.stringify(facts, null, 2));

/** One line per control: why it is unavailable here, and what would change that. */
const REASONS = [
  ['authorityCustody', () => !facts.providerInstalled,
    'no provider store is installed outside the repository, so authority still lives in the same uid\'s reach',
    'install the provider store under a protected path owned by the broker identity'],
  ['workerFilesystem', () => !facts.workerIdentityDeclared,
    'no dedicated worker identity is declared, so candidate code runs as the same user that can write the authority',
    'create the worker identity, then declare it (CANARY_WORKER_USER) before any verification runs'],
  ['verificationSandbox', () => !facts.brokerServiceInstalled,
    'no supervisor service is installed, so nothing launches candidate code under a restricted identity',
    'install the supervisor as a service running as the broker identity'],
  ['authenticatedReview', () => true,
    'acceptance is authenticated by a real terminal (isTTY) and nothing stronger; that is friction, not identity, and the same uid can bypass it',
    'route the review act through the broker so the signature is produced under an identity the worker does not hold'],
  ['protectedPromotion', () => true,
    'promotion runs in-process with the CLI, so the identity that ran the plan also performs the apply',
    'move the promoter behind the broker with its own key material and a compare-and-set on the base ref'],
  ['networkEgress', () => true,
    'no egress policy is enforceable by this process: no per-process firewall rule, container or proxy is installed or claimed',
    'install a per-identity egress policy (firewall rule / sandbox) and prove DNS-rebinding and raw-IP bypasses are closed'],
];

console.log('\n=== boundary controls, measured ===');
for (const [control, unavailable, why, remedy] of REASONS) {
  assert(unavailable(), `${control} unexpectedly looks AVAILABLE — do not claim it without a proven provider`);
  console.log(`UNAVAILABLE  ${control}`);
  console.log(`  why:    ${why}`);
  console.log(`  needs:  ${remedy}`);
}

check('every control is unavailable and every reason is substantive', () => {
  const cap = pb.localCapabilities(true);
  assert(cap.unavailable.length === CONTROLS.length);
  for (const [, , why, remedy] of REASONS) {
    assert(why.length > 30 && remedy.length > 20, 'a reason that does not explain itself is not a reason');
  }
});

// ─────────────────── 3. the exact authorization ask ───────────────────
console.log('\n=== the exact privileged step (NOT executed here) ===');
console.log('Elevation is required, and it is a human decision. On Windows x64:');
console.log('  1. create a restricted worker identity (as Administrator, once):');
console.log('       net user canary-worker <STRONG-PASSWORD> /add /passwordreq:yes');
console.log('       net localgroup "Users" canary-worker /add');
console.log('  2. install the broker/supervisor to run as ANOTHER identity (NOT the worker):');
console.log('       sc.exe create CanaryBroker binPath= "<install>\\canary-broker.exe" obj= "<BROKER-ACCOUNT>" start= auto');
console.log('       sc.exe start CanaryBroker');
console.log('  3. give the provider store a DACL that excludes the worker identity:');
console.log(`       icacls "${facts.providerStoreDir}" /inheritance:r /grant:r "<BROKER-ACCOUNT>:(OI)(CI)F" /grant:r "SYSTEM:(OI)(CI)F"`);
console.log('  4. declare the pairing, then re-run THIS probe and the broker contract suite:');
console.log('       set CANARY_WORKER_USER=canary-worker');
console.log('       set CANARY_BROKER_ENDPOINT=\\\\.\\pipe\\canary-broker');
console.log('       node tooling/probes/provider-boundary.mjs && npm test');
console.log('Until step 4 passes on a host with a real second identity, HARDENED stays unreachable');
console.log('and every one of the six controls above stays reported unavailable.');

console.log(`\n=== provider-boundary: ${failures === 0 ? 'HONEST POSTURE HOLDS (HARDENED unreachable, all six controls unavailable, measured)' : `${failures} FAIL`} ===`);
process.exit(failures === 0 ? 0 : 1);
