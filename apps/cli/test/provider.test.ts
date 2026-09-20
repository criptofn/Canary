/**
 * The HARDENED provider — boundary measurement, IPC guarantees, and the
 * fail-closed lifecycle (v1.1 Phase 3).
 *
 * These tests pin the properties that make the provider worth having, and pin
 * the refusals that keep it honest:
 *   - the icacls parser distinguishes a WRITE grant from a read grant (a
 *     read-only ACE naming the worker must never read as "the worker can write");
 *   - the IPC surface refuses an unknown operation, an unknown FIELD (the
 *     confused-deputy vector), a wrong token, and a stale authority generation;
 *   - HARDENED is produced ONLY by a measurement in which every control is
 *     available, and one missing control keeps the level local;
 *   - the restricted runner refuses to run rather than falling back to the
 *     broker's own identity — the single invariant the provider exists to keep.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

process.env.CANARY_TRUST_STORE = path.join(os.tmpdir(), `canary-provider-${process.pid}`);

import { measuredCapabilities, requireAuthorizationLevel, requireMeasuredLevel, type BoundaryControl } from '../src/platform-boundary.js';
import { measureBoundary, parseStoreWriters, providerConfigured, installPlan, installPlanFor, observeSandboxPrimitive, storeDaclGrantsWrite } from '../src/provider/boundary.js';
import { RestrictedRunner, providerStatus, providerUninstallPlan } from '../src/provider/service.js';
import { callBroker, createBrokerServer, encodeFrame, ensureBrokerToken, tokenMatches, validateWireRequest } from '../src/provider/ipc.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-provider-test-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const ALL_CONTROLS: BoundaryControl[] = ['authorityCustody', 'workerFilesystem', 'verificationSandbox', 'authenticatedReview', 'protectedPromotion', 'networkEgress'];
const controls = (available: readonly string[]): Record<BoundaryControl, { available: boolean }> =>
  Object.fromEntries(ALL_CONTROLS.map((c) => [c, { available: available.includes(c) }])) as Record<BoundaryControl, { available: boolean }>;

describe('icacls parsing: a read grant is not a write grant', () => {
  it('the DECISION finds a write ACE for a named principal, including the first line', () => {
    // The first ACE shares its line with the directory path — the exact shape
    // that makes "where does the principal start" unanswerable, and therefore
    // why the decision does not try to answer it.
    const out = [
      'C:\\store BUILTIN\\Administrators:(OI)(CI)(F)',
      '        NT AUTHORITY\\SYSTEM:(OI)(CI)(F)',
      '        DESKTOP\\worker:(M)',
        '        DESKTOP\\reader:(RX)',
    ].join('\r\n');
    assert.equal(storeDaclGrantsWrite(out, 'BUILTIN\\Administrators'), true);
    assert.equal(storeDaclGrantsWrite(out, 'NT AUTHORITY\\SYSTEM'), true);
    assert.equal(storeDaclGrantsWrite(out, 'DESKTOP\\worker'), true);
    assert.equal(storeDaclGrantsWrite(out, 'DESKTOP\\reader'), false, 'a read grant is not a write grant');
    assert.equal(storeDaclGrantsWrite(out, 'DESKTOP\\nobody'), false);
  });

  it('a read-only ACE naming the worker is NOT a write grant', () => {
    const out = 'C:\\store DESKTOP\\canary-worker:(OI)(CI)(RX)\r\n        BUILTIN\\Administrators:(F)';
    assert.equal(storeDaclGrantsWrite(out, 'canary-worker'), false);
    assert.equal(storeDaclGrantsWrite(out, 'Administrators'), true);
    // The directory path must never be mistaken for a principal.
    assert.equal(storeDaclGrantsWrite(out, 'C:\\store'), false);
  });

  it('a principal that is a PREFIX of another does not inherit its grant', () => {
    const out = 'C:\\store DESKTOP\\worker:(RX)\r\n        DESKTOP\\worker-admin:(F)';
    assert.equal(storeDaclGrantsWrite(out, 'DESKTOP\\worker'), false, 'the shorter name must not match the longer one\'s ACE');
    assert.equal(storeDaclGrantsWrite(out, 'DESKTOP\\worker-admin'), true);
  });

  it('an empty or unparseable listing yields no writers, never a default', () => {
    assert.deepEqual(parseStoreWriters(''), []);
    assert.equal(storeDaclGrantsWrite('Successfully processed 0 files; Failed processing 0 files', 'Anyone'), false);
  });
});

describe('HARDENED is produced only by a measurement, never by an assertion', () => {
  it('every control available => HARDENED', () => {
    assert.equal(measuredCapabilities({ storeExists: true, controls: controls(ALL_CONTROLS) }).level, 'HARDENED');
    assert.deepEqual(measuredCapabilities({ storeExists: true, controls: controls(ALL_CONTROLS) }).unavailable, []);
  });

  it('ONE missing control keeps the level local — there is no partial HARDENED', () => {
    for (const missing of ALL_CONTROLS) {
      const m = measuredCapabilities({ storeExists: true, controls: controls(ALL_CONTROLS.filter((c) => c !== missing)) });
      assert.equal(m.level, 'LOCAL', `${missing} missing must not yield HARDENED`);
      assert.deepEqual(m.unavailable, [missing]);
    }
  });

  it('no store at all => ADVISORY', () => {
    assert.equal(measuredCapabilities({ storeExists: false, controls: controls([]) }).level, 'ADVISORY');
  });

  it('level authorization: HARDENED passes only with a HARDENED measurement', () => {
    requireMeasuredLevel('LOCAL', undefined);
    requireMeasuredLevel('HARDENED', { level: 'HARDENED', unavailable: [] });
    for (const level of ['HARDENED', 'ADVISORY', 'UNSUPPORTED', undefined, { level: 'HARDENED' }]) {
      assert.throws(() => requireMeasuredLevel(level, { level: 'LOCAL', unavailable: ALL_CONTROLS }),
        `${JSON.stringify(level)} must not authorize against a LOCAL measurement`);
    }
    // The un-measured door stays exactly as closed as it was.
    for (const v of ['HARDENED', 'ADVISORY', undefined]) assert.throws(() => requireAuthorizationLevel(v));
    requireAuthorizationLevel('LOCAL');
  });
});

describe('boundary measurement on a real host is honest about what it cannot see', () => {
  it('reports every control unavailable-with-a-reason when nothing is installed', () => {
    const store = { root: path.join(TMP, 'empty-store') };
    const m = measureBoundary(store, {});
    assert.equal(m.storeExists, false);
    assert.equal(m.hardenedAvailable, false);
    assert.equal(m.workerUser, null);
    assert.equal(m.confined.measured, false, 'nothing has measured a confined-caller deployment in this store');
    assert.equal(m.confined.signatureVerified, false);
    // The six production controls come from the deployment measurement, and with
    // no record every one of them is unavailable WITH the validation's reason.
    assert.deepEqual(Object.keys(m.controls).sort(), ALL_CONTROLS.slice().sort());
    for (const c of ALL_CONTROLS) {
      assert.equal(m.controls[c].available, false, `${c} must not be claimed`);
      assert.ok(m.controls[c].why.length > 20, `${c} must state why`);
      assert.match(m.controls[c].why, /confined-caller deployment is not measured/);
    }
    // The identity path is reported SEPARATELY: it is not evidence of anything on
    // a host where nobody ran an elevated install, so it never mixes into the six.
    for (const c of ALL_CONTROLS) assert.equal(m.identityControls[c].available, false);
    assert.ok(m.observations.length >= 3, 'the raw observations are retained so a human can re-check');
  });

  it('a provider is only "configured" when it left a trace', () => {
    const store = { root: path.join(TMP, 'no-trace') };
    assert.equal(providerConfigured(store, {}), false);
    assert.equal(providerConfigured(store, { CANARY_WORKER_USER: 'canary-worker' }), true);
    fs.mkdirSync(store.root, { recursive: true });
    ensureBrokerToken(store.root);
    assert.equal(providerConfigured(store, {}), true, 'a store token means a provider ran here');
    fs.rmSync(path.join(store.root, 'provider-token'), { force: true });
    // A measurement record is the other trace a provider leaves behind.
    fs.writeFileSync(path.join(store.root, 'confined-caller-measurement.json'), '{}');
    assert.equal(providerConfigured(store, {}), true, 'a measurement record means a provider ran here');
  });

  it('providerStatus explains HARDENED is unavailable and flags pending activation', () => {
    const store = { root: path.join(TMP, 'status-store') };
    const s = providerStatus(store, { CANARY_WORKER_USER: 'canary-worker' });
    assert.equal(s.hardened, false);
    assert.equal(s.unavailable.length, ALL_CONTROLS.length);
    assert.equal(s.activationPending, true, 'a worker is enrolled but no deployment is measured and no service runs');
    assert.equal(s.confinement?.kind, 'identity-runner');
  });
});

describe('the install lifecycle is explicit, privileged and reversible', () => {
  it('names elevation for exactly the privileged steps and provides a rollback', () => {
    const plan = installPlan({ root: path.join(TMP, 'plan-store') });
    const ids = plan.steps.map((s) => s.id);
    // v1.4 — `installPlan({root})` builds the plan for THIS HOST, and the two lifecycles are
    // different: `windowsInstallPlan` (boundary.ts:446) has install-service/start-service and one
    // step that needs no elevation (enroll-worker), while the Linux plan (boundary.ts:538) has
    // install-unit/enable-service and NO unprivileged step at all. This test asserted the Windows
    // ids — including `enroll-worker`, which the Linux plan does not contain — so on Linux it
    // failed the id check and then threw on the missing step (`undefined.needsElevation`). Every
    // Linux push was red for a host difference, not a defect.
    //
    // The property is now asserted against the lifecycle actually returned, which is strictly more
    // coverage than before: the privileged set is checked for whichever plan this host builds.
    const privileged = plan.platform === 'win32'
      ? ['worker-identity', 'broker-identity', 'protected-store', 'install-service', 'start-service']
      : ['worker-identity', 'broker-identity', 'protected-store', 'install-unit', 'enable-service', 'egress-policy'];
    for (const id of privileged) {
      assert.ok(ids.includes(id), `plan must contain ${id}`);
      assert.equal(plan.steps.find((s) => s.id === id)!.needsElevation, true, `${id} must be marked privileged`);
    }
    // Where the lifecycle HAS an unprivileged step, it must stay unmarked.
    if (plan.platform === 'win32') {
      assert.equal(plan.steps.find((s) => s.id === 'enroll-worker')!.needsElevation, false);
    }
    assert.ok(plan.rollback.length >= 4, 'a plan without a rollback is not a plan');
    assert.ok(plan.verify.length >= 2);
    assert.ok(plan.postState.some((p) => /hardenedAvailable/.test(p)));
    // The plan must say how the level is actually produced, so a reader does not
    // infer that running it is what makes HARDENED reachable.
    //
    // v1.4 — this is a property of the HOST-VERIFIED lifecycle, not of both. The Windows plan
    // (boundary.ts:501-508) names the confined-caller measurement the controls come from; the Linux
    // plan's verify list (boundary.ts:586-590) deliberately does NOT, because that path is
    // `IMPLEMENTED_BUT_HOST_UNVERIFIED` and naming a measured deployment there would be exactly the
    // overclaim this project refuses. The assertion was unconditional, so it failed on Linux — the
    // second host-hardcoded assertion in this test, and the one the real CI caught after the first
    // was fixed. Both halves are now pinned, so the DIFFERENCE between the plans is asserted rather
    // than assumed.
    if (plan.platform === 'win32') {
      assert.ok(plan.verify.some((v) => /v12-confined-caller\.mjs/.test(v)), 'the plan must name the measurement that produces the controls');
    } else {
      assert.equal(plan.hostVerified, false, 'the non-Windows lifecycle is host-unverified');
      assert.ok(!plan.verify.some((v) => /v12-confined-caller\.mjs/.test(v)),
        'a HOST-UNVERIFIED plan must NOT claim the deployment measurement that produces the controls');
    }
  });

  it('uninstall keeps the sealed authority and says so', () => {
    const u = providerUninstallPlan({ root: path.join(TMP, 'uninstall-store') });
    assert.ok(u.steps.length >= 4);
    assert.match(u.keepsProtectedAuthority, /NOT deleted/);
    assert.match(u.keepsProtectedAuthority, /sealed authority/);
  });

  it('the LINUX provider path is real code with contract coverage, and says it is unverified', () => {
    // Contract-tested on a Windows host on purpose: the alternative is a Linux
    // path whose only evidence is that it looks right. Execution must still
    // happen on Linux, and `hostVerified: false` travels with the plan so no
    // reader can mistake coverage for proof.
    const plan = installPlanFor('linux', '/var/lib/canary/trust', 'canary-worker', '/opt/canary');
    assert.equal(plan.platform, 'linux');
    assert.equal(plan.hostVerified, false, 'the Linux path has never been executed here and must not claim it');
    const ids = plan.steps.map((s) => s.id);
    for (const id of ['worker-identity', 'broker-identity', 'protected-store', 'install-unit', 'enable-service', 'egress-policy']) {
      assert.ok(ids.includes(id), `Linux plan must contain ${id}`);
    }
    assert.ok(plan.steps.find((s) => s.id === 'worker-identity')!.argv.includes('useradd'));
    assert.ok(plan.steps.find((s) => s.id === 'enable-service')!.argv.includes('systemctl'));
    // The egress step exists but is the ONLY thing that could make the control
    // true; if it is not run, networkEgress must stay unavailable.
    assert.match(plan.steps.find((s) => s.id === 'egress-policy')!.why, /ONLY if HARDENED is to claim egress control/);
    // The unit file is the enforcement point, so it is INSPECTABLE, not a black box.
    const unit = plan.files?.find((f) => f.path.endsWith('.service'));
    assert.ok(unit, 'the systemd unit must be part of the plan');
    for (const line of ['User=canary-broker', 'NoNewPrivileges=true', 'ProtectSystem=strict', 'ProtectHome=true', `ReadWritePaths=/var/lib/canary/trust`]) {
      assert.ok(unit!.content.includes(line), `the unit must set ${line}`);
    }
    assert.ok(plan.postState.some((p) => /IMPLEMENTED_BUT_HOST_UNVERIFIED/.test(p)),
      'the plan must carry the warning, not just the docs');
    assert.ok(plan.rollback.length >= 4);
  });

  it('the WINDOWS plan is the host-verified one', () => {
    const plan = installPlanFor('win32', 'C:\\store', 'canary-worker', 'C:\\ProgramData\\Canary');
    assert.equal(plan.hostVerified, true);
    assert.ok(plan.steps.some((s) => s.argv[0] === 'icacls'));
    assert.ok(plan.steps.some((s) => s.argv[0] === 'sc.exe' && s.argv[1] === 'create'));
  });
});

describe('the restricted runner refuses rather than running as the broker', () => {
  it('has no launch argv without a measured deployment and refuses in words', () => {
    const r = new RestrictedRunner(null, null);
    assert.equal(r.launchArgv('python', ['-m', 'unittest'], TMP), null);
    const why = r.assertUsable();
    assert.ok(why !== null, 'without a measured deployment or an identity the runner MUST refuse');
    assert.match(why!, /BLOCKED/);
    assert.match(why!, /as the broker identity/);
  });

  it('builds a platform-shaped launch only WITH an identity', () => {
    const r = new RestrictedRunner('canary-worker', null);
    const argv = r.launchArgv('python', ['-m', 'unittest'], TMP);
    assert.ok(argv !== null);
    if (process.platform === 'win32') assert.equal(argv![0], 'schtasks');
    else assert.deepEqual(argv!.slice(0, 4), ['sudo', '-n', '-u', 'canary-worker']);
  });

  it('an identity alone is not enough on Windows: it still refuses, because no runner is installed', () => {
    const r = new RestrictedRunner('canary-worker', { kind: 'identity-runner', account: 'canary-worker' });
    if (process.platform === 'win32') {
      assert.match(r.assertUsable()!, /BLOCKED/);
    } else {
      assert.equal(r.assertUsable(), null);
    }
  });
});

describe('IPC: a closed surface with binding, not a remote control', () => {
  it('refuses unknown operations and caller-supplied fields', () => {
    const ok = { schema: 'canary-ipc/1', token: 'x'.repeat(32), id: 1, op: 'broker.status' };
    assert.equal(validateWireRequest(ok).op, 'broker.status');
    assert.throws(() => validateWireRequest({ ...ok, op: 'broker.execute' }), /not in the worker surface/);
    // The confused-deputy vector: a client trying to name a command or a path.
    for (const extra of ['command', 'cwd', 'env', 'path', 'key', 'network', 'argv']) {
      assert.throws(() => validateWireRequest({ ...ok, [extra]: 'rsync' }), /not part of the worker surface/,
        `field "${extra}" must be refused, not ignored`);
    }
    assert.throws(() => validateWireRequest({ ...ok, token: 'short' }), /missing or short token/);
  });

  it('token comparison is length-safe and exact', () => {
    const a = crypto.randomBytes(32).toString('hex');
    assert.equal(tokenMatches(a, a), true);
    assert.equal(tokenMatches(a, a.slice(0, -1) + 'f'), a.endsWith('f'));
    assert.equal(tokenMatches(a, crypto.randomBytes(32).toString('hex')), false);
  });

  it('frames are newline-delimited and size-capped', () => {
    assert.equal(encodeFrame({ a: 1 }), '{"a":1}\n');
    assert.throws(() => encodeFrame({ a: 'x'.repeat(70 * 1024) }), /frame exceeds/);
  });

  it('serves a real call, and refuses the wrong token, unknown ops and stale generations', async () => {
    const pipe = `canary-test-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    const token = crypto.randomBytes(32).toString('hex');
    const seen: string[] = [];
    const server = createBrokerServer({
      pipeName: pipe,
      token,
      authorityGeneration: 'gen-2',
      handler: (req) => { seen.push(req.op); return { echo: req.op, generation: 'gen-2' }; },
    });
    // The pipe needs a moment to be listening; a connect retry loop keeps the
    // test honest without a fixed sleep.
    const call = async (req: Parameters<typeof callBroker>[0], tok = token): Promise<unknown> => {
      for (let i = 0; i < 40; i++) {
        try { return await callBroker(req, { pipeName: pipe, token: tok, timeoutMs: 5_000 }); }
        catch (e) {
          const msg = String((e as Error).message);
          if (!/ENOENT|ECONNREFUSED/.test(msg)) throw e;
          await new Promise((r) => setTimeout(r, 50));
        }
      }
      throw new Error('the broker never accepted a connection');
    };

    // The server MUST be closed even when an assertion fails: an un-closed
    // listener keeps the event loop alive and turns a test failure into a hang.
    try {
      assert.deepEqual(await call({ op: 'broker.hello' }), { echo: 'broker.hello', generation: 'gen-2' });
      assert.deepEqual(await call({ op: 'broker.status' }), { echo: 'broker.status', generation: 'gen-2' });
      // The refusal carries a machine-readable CODE plus a message naming both
      // generations, so a caller can branch on the code and a human can see why.
      await assert.rejects(call({ op: 'broker.reserve-promotion', authorityGeneration: 'gen-1' }),
        (e: unknown) => (e as { code?: string }).code === 'stale-generation'
          && /gen-1/.test(String((e as Error).message)) && /gen-2/.test(String((e as Error).message)));
      // Same operation, correct generation: ACCEPTED. The refusal above was about
      // the generation, not about the operation being unusable.
      assert.deepEqual(await call({ op: 'broker.reserve-promotion', authorityGeneration: 'gen-2' }),
        { echo: 'broker.reserve-promotion', generation: 'gen-2' });
      await assert.rejects(call({ op: 'broker.hello' }, crypto.randomBytes(32).toString('hex')),
        (e: unknown) => (e as { code?: string }).code === 'unauthorized');
      assert.ok(seen.includes('broker.hello'));
    } finally {
      await server.close();
    }
  });
});
