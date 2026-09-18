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

// ─────────────────── 3b. the REAL provider surface (v1.1 Phase 3) ───────────────────
console.log('\n=== canary provider status (the measured boundary) ===');
{
  // v1.2 Mission 3: the tripwire is no longer "HARDENED must never appear" — the
  // confined-caller measurement may legitimately produce it. What must never
  // happen is HARDENED from anything OTHER than a measurement, so this reads the
  // product's own measurement of a store that has none.
  const boundaryModule = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'provider', 'boundary.js');
  if (!fs.existsSync(boundaryModule)) { failures++; console.log(`FAIL missing built boundary module: ${boundaryModule}`); }
  else {
    const { measureBoundary } = await import(`file://${boundaryModule.replace(/\\/g, '/')}`);
    const emptyStore = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-provider-probe-measure-'));
    const measured = measureBoundary({ root: emptyStore }, {});
    check('a store with no measurement reports no control available and not HARDENED', () => {
      assert(measured.hardenedAvailable === false, 'hardenedAvailable was true with no measurement');
      assert(measured.confined.measured === false, 'a deployment was reported measured with no record');
      const available = CONTROLS.filter((c) => measured.controls[c].available);
      assert(available.length === 0, `controls claimed available with no measurement: ${available.join(', ')}`);
      for (const c of CONTROLS) {
        assert(typeof measured.controls[c].why === 'string' && measured.controls[c].why.length > 20, `${c} must state why`);
      }
    });
    console.log(`measured boundary on an unmeasured store -> hardenedAvailable ${measured.hardenedAvailable}, reason: ${measured.confined.reason}`);
    fs.rmSync(emptyStore, { recursive: true, force: true });
  }

  const cli = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');
  if (!fs.existsSync(cli)) { failures++; console.log(`FAIL missing built CLI: ${cli}`); }
  else {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-provider-probe-'));
    const env = { ...process.env, CANARY_TRUST_STORE: store };
    const status = spawnSync(process.execPath, [cli, 'provider', 'status', '--json'], { encoding: 'utf8', timeout: 120_000, env, windowsHide: true });
    const line = (status.stdout ?? '').split(/\r?\n/).find((l) => l.trim().startsWith('{'));
    let env0 = null;
    try { env0 = line ? JSON.parse(line) : null; } catch { env0 = null; }
    console.log(`provider status -> exit ${status.status}, envelope ${env0 === null ? 'MISSING' : 'present'}`);
    check('the provider reports NOT CONNECTED with every control missing, and never READY', () => {
      assert(env0 !== null, `no JSON envelope on stdout:\n${status.stdout}${status.stderr}`);
      assert(env0.schema === 'canary-provider-status/1', `wrong schema: ${env0.schema}`);
      assert(env0.status === 'NOT CONNECTED', `an uninstalled provider must not read READY: ${env0.status}`);
      assert(env0.exitCode === 2, `exitCode must be 2 without a boundary, got ${env0.exitCode}`);
      assert(Array.isArray(env0.problems) && env0.problems.length === CONTROLS.length,
        `expected ${CONTROLS.length} unavailable controls, got ${JSON.stringify(env0.problems)}`);
    });

    const plan = spawnSync(process.execPath, [cli, 'provider', 'install-plan'], { encoding: 'utf8', timeout: 120_000, env, windowsHide: true });
    const planOut = `${plan.stdout ?? ''}${plan.stderr ?? ''}`;
    console.log(`provider install-plan -> exit ${plan.status}`);
    check('install-plan PRINTS the privileged steps and executes nothing', () => {
      assert(plan.status === 0, `install-plan failed: ${planOut.slice(-400)}`);
      assert(/OWNER AUTHORIZATION REQUIRED/.test(planOut), 'the plan must say what it is waiting for');
      for (const needle of ['net user', 'sc.exe create', 'icacls']) {
        assert(planOut.includes(needle), `the plan must name the real command (${needle})`);
      }
      assert(/rollback/i.test(planOut), 'a plan without a rollback is not a plan');
      assert(/Nothing in this command executed any of the above/.test(planOut), 'it must state that nothing ran');
    });

    // The provider must not have installed itself as a side effect.
    if (process.platform === 'win32') {
      const q = spawnSync('sc.exe', ['query', 'CanaryBroker'], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
      check('no CanaryBroker service was installed as a side effect', () => {
        assert(q.status !== 0, 'a service exists after running only the planning commands — that would be an unrequested privileged change');
      });
    }

    // The worker-side client must refuse to talk to a broker that is not there,
    // rather than silently doing the work locally.
    const call = spawnSync(process.execPath, [cli, 'provider', 'call', 'broker.hello'], { encoding: 'utf8', timeout: 60_000, env, windowsHide: true });
    check('with no broker running, a worker call is refused (never silently local)', () => {
      assert(call.status !== 0, `the call must fail when no provider is served: ${call.stdout}${call.stderr}`);
      assert(/refused/i.test(`${call.stdout}${call.stderr}`), 'the refusal must say so');
    });
    fs.rmSync(store, { recursive: true, force: true });
  }
}

// ─────────────────── 3. the exact authorization ask ───────────────────
console.log('\n=== the identity path: privileged steps (NOT executed here) ===');
console.log('This build does NOT need these steps: capability comes from the measured');
console.log('confined-caller deployment (node tooling/probes/v12-confined-caller.mjs),');
console.log('which uses no elevation. They remain here for a host that wants a separate');
console.log('broker ACCOUNT on top of it, and elevation stays a human decision. On Windows x64:');
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
console.log('Until step 4 passes on a host with a real second identity, the IDENTITY path contributes');
console.log('no control; that is not the same as HARDENED being unreachable, which it is not:');
console.log('HARDENED is produced by a measured confined-caller deployment, and this probe checks');
console.log('that a host without one still reports every control unavailable.');

console.log(`\n=== provider-boundary: ${failures === 0 ? 'HONEST POSTURE HOLDS (no unproven HARDENED, all six controls unavailable without a measurement)' : `${failures} FAIL`} ===`);
process.exit(failures === 0 ? 0 : 1);
