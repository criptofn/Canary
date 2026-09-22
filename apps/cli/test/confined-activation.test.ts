/** Positive fixtures are produced ONLY by the actual production enrollment,
 * broker, confined verifier, promotion, native battery and signed live check.
 * Negative raw transcripts are re-signed by the trusted test operator: a valid
 * signature must never turn a failed or absent observation into a capability. */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { measureBoundary, providerConfigured } from '../src/provider/boundary.js';
import { measuredCapabilities } from '../src/platform-boundary.js';
import { providerStatus, RestrictedRunner } from '../src/provider/service.js';
import { securityCapability } from '../src/onboarding.js';
import { ALL_CONTROLS, readConfinedMeasurement } from '../src/provider/confined-measurement.js';
import { anchorPath, PRODUCTION_MEASUREMENT, readProductionMeasurement } from '../src/provider/production-measurement.js';
import type { Enrollment } from '../src/provider/production.js';

const repo = path.resolve(import.meta.dirname, '../../../..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-real-activation-'));
const cli = path.join(repo, 'apps/cli/dist/src/main.js');
type Payload = NonNullable<ReturnType<typeof readProductionMeasurement>['payload']>;
type RecordFile = { payload: Payload; signature: string };
let fixture: ChildProcess, fixtureLog = '', store: string, e: Enrollment, brokerPid: number;
let record: RecordFile, anchor: {current: string; nonce: string}, anchorFile: string, recordFile: string, key: Buffer;
/**
 * v1.4 — this suite requires the native Windows confinement host (AppContainer +
 * restricted token + low integrity). Off Windows it used to FAIL from the
 * top-level `before` hook, which failed all five describes and every subtest:
 * ~50 red lines in the Linux CI leg on every push, for a reason that had
 * nothing to do with the change under test. That is the "unexplained permanent
 * red job" this release exists to remove.
 *
 * The reason string is unchanged and is NOT a pass: node:test reports the file
 * as skipped, the count shows it, and every assertion below is untouched.
 * `verify-productization` and this suite's own guard still refuse to report
 * these controls as available — `measureBoundary` remains fail-closed here, so
 * nothing about the capability answer depends on this suite running.
 */
const OFF_WINDOWS = process.platform === 'win32' ? false : 'this required native suite is unavailable off Windows, not PASS';
/**
 * v1.4 — THE HOST MEASUREMENT, not a guess and not a blanket skip.
 *
 * This suite's precondition is a host that can EXECUTE a program inside the
 * native confinement (AppContainer + restricted token + low integrity). The
 * GitHub-hosted Windows image measurably cannot: on run 35695885086 the fixture
 * reported `spawnSync C:\Program Files\Git\cmd\git.exe EPERM` for every confined
 * exec, 15 of its 33 production-authority controls failed, and this file's
 * `before` hook — which can only fail, never skip — turned that into five
 * hookFailed suites and ~61 cancelled tests. The product was right (it reports
 * NOT HARDENED, fail-closed); the SUITE was asking the host for a capability it
 * does not have, and leaving CI permanently red for a reason unrelated to any
 * change under test.
 *
 * The gate is a LIVE MEASUREMENT made in the same job by the same fixture:
 * CI runs `node tooling/probes/v12-production-authority.mjs --capability`, which
 * performs the real enrollment and one real confined execution, and exports this
 * variable ONLY when the confined child could not execute (raw OS refusal in the
 * reason). Nothing else sets it — a developer's `npm test` runs the suite in
 * full, and a machine that CAN confine gets no skip. A SKIP is never a PASS: the
 * count shows it and the reason carries the measured refusal verbatim.
 */
const HOST_CANNOT_CONFINE = process.env['CANARY_CONFINED_HOST'] === 'unmeasurable'
  ? (process.env['CANARY_CONFINED_HOST_REASON'] ?? 'this host measurably cannot execute inside the native confinement')
  : false;
const SUITE_SKIP = OFF_WINDOWS || HOST_CANNOT_CONFINE;
// A skip that only zeroes out five describes is invisible in node:test's totals
// (0 tests, 0 skipped), which is the one thing a host-bound skip may not be.
// This makes it COUNT as a skip and carries the reason into the summary line.
if (SUITE_SKIP) {
  describe('host-bound SKIP — never a PASS', () => {
    it(`native confinement suite NOT measured on this host: ${String(SUITE_SKIP)}`, { skip: String(SUITE_SKIP) }, () => {});
  });
}
const json = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
const put = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value));
/** How long the REAL production fixture may take to enroll, compile its native
 *  boundary and answer on a named pipe.
 *
 *  MEASURED (v1.4): 300 s was enough on an idle machine and NOT enough inside
 *  `npm test`, where eight test files run concurrently and several of them spawn
 *  their own pipelines; 600 s was still not enough under the same load — the
 *  fixture was observed past its whole native attack battery and its custody
 *  checks, still short of the handoff, while the same suite passed alone in
 *  271 s (61/61) on the same bytes. A fixture that cannot come up inside its
 *  budget is a red step that says nothing about the change under test, which is
 *  the false red this release exists to remove. This is a BUDGET, not an
 *  assertion: what the suite asserts is unchanged, and it still fails loudly if
 *  the fixture never arrives. */
const FIXTURE_STARTUP_MS = 900000;
const pause = () => new Promise(resolve => setTimeout(resolve, 100));
async function ready(file: string, child: ChildProcess, timeout = FIXTURE_STARTUP_MS): Promise<void> {
  const until = Date.now() + timeout;
  while (!fs.existsSync(file)) {
    if (child.exitCode !== null || Date.now() > until) throw new Error('real fixture unavailable: ' + fixtureLog);
    await pause();
  }
}
function restore(): void {
  if (!record) return;
  put(recordFile, record); put(anchorFile, anchor);
  fs.writeFileSync(path.join(store, 'producer.key'), key);
}
function changed(mutate: (p: Payload) => void, foreignKey = false): void {
  const next = structuredClone(record); mutate(next.payload);
  next.signature = crypto.sign(null, Buffer.from(JSON.stringify(next.payload)),
    foreignKey ? crypto.generateKeyPairSync('ed25519').privateKey : key).toString('base64');
  put(recordFile, next);
  put(anchorFile, {...anchor, current: crypto.createHash('sha256').update(JSON.stringify(next)).digest('hex')});
}
function closed(reason?: RegExp): void {
  const boundary = measureBoundary({root: store}, {});
  assert.equal(boundary.hardenedAvailable, false);
  assert.notEqual(measuredCapabilities(boundary).level, 'HARDENED');
  for (const control of ALL_CONTROLS) {
    assert.equal(boundary.controls[control].available, false, control);
    assert.ok(boundary.controls[control].why.length > 10);
  }
  if (reason) assert.match(boundary.production?.reason ?? boundary.confined.reason, reason);
}
before(async () => {
  // Off Windows every describe below is SKIPPED with this reason (see OFF_WINDOWS).
  // The guard is kept for the case where the skip is ever removed: on a host that
  // cannot satisfy it, this suite must FAIL, never silently pass.
  if (SUITE_SKIP) {
    console.log(`SKIP (host-bound): ${String(SUITE_SKIP)}`);
    return;
  }
  assert.equal(process.platform, 'win32', 'this required native suite is unavailable off Windows, not PASS');
  const handoff = path.join(root, 'handoff.json');
  fixture = spawn(process.execPath, [path.join(repo,'tooling/probes/v12-production-authority.mjs'), '--hold-file', handoff],
    {cwd: repo, windowsHide: true, stdio: ['pipe','pipe','pipe']});
  fixture.stdout?.on('data', b => { fixtureLog += b; });
  fixture.stderr?.on('data', b => { fixtureLog += b; });
  await ready(handoff, fixture);  ({store, enrollment: e, brokerPid} = json(handoff));
  recordFile = path.join(store, PRODUCTION_MEASUREMENT); anchorFile = anchorPath(store);
  record = json(recordFile); anchor = json(anchorFile); key = fs.readFileSync(path.join(store, 'producer.key'));
}, {timeout: FIXTURE_STARTUP_MS + 10000});
beforeEach(restore);
after(async () => {
  restore();
  if (fixture && fixture.exitCode === null) {
    fixture.stdin?.write('release\n');
    const until = Date.now()+20000;
    while (fixture.exitCode === null && Date.now()<until) await pause();
    if (fixture.exitCode === null) spawnSync('taskkill', ['/PID', String(fixture.pid), '/T', '/F'], {windowsHide:true});
    else assert.equal(fixture.exitCode, 0, fixtureLog);
  }
  fs.rmSync(root, {recursive:true,force:true});
});

describe('real production activation chain', { skip: SUITE_SKIP }, () => {
  it('measured deployment alone plus live signed broker activates every control', () => {
    const b = measureBoundary({root:store},{});
    assert.equal(b.production?.valid,true,b.production?.reason);
    assert.equal(b.hardenedAvailable,true);
    assert.deepEqual(measuredCapabilities(b),{level:'HARDENED',unavailable:[]});
    for (const control of ALL_CONTROLS) assert.equal(b.controls[control].available,true);
  });
  it('provider status reports actual caller confinement without pending activation', () => {
    const status = providerStatus({root:store},{});
    assert.equal(status.hardened,true);
    assert.equal(status.activationPending,false);
    assert.deepEqual(status.unavailable,[]);
    assert.equal(status.confinement?.kind,'win32-appcontainer-restricted-low');
    assert.equal(status.confinement?.kind === 'win32-appcontainer-restricted-low' ? status.confinement.package : null,e.package);
    assert.equal(new RestrictedRunner(null,status.confinement).assertUsable(),null);
  });
  it('production capability reporter and CLI agree', () => {
    const saved = process.env.CANARY_TRUST_STORE;
    process.env.CANARY_TRUST_STORE = store;
    try {
      assert.equal(securityCapability().level,'HARDENED');
      const r = spawnSync(process.execPath,[cli,'provider','status','--json'],{cwd:repo,encoding:'utf8',windowsHide:true});
      assert.equal(r.status,0,r.stderr);
      const envelope = JSON.parse(r.stdout);
      assert.equal(envelope.status,'READY');
      assert.equal(envelope.security.level,'HARDENED');
      assert.match(r.stderr,/MEASURED \+ LIVE BROKER VERIFIED/);
    } finally {
      if (saved === undefined) delete process.env.CANARY_TRUST_STORE; else process.env.CANARY_TRUST_STORE = saved;
    }
  });
  it('configured provider is store specific', () => {
    assert.equal(providerConfigured({root:store},{}),true);
    const bare = path.join(root,'bare'); fs.mkdirSync(bare);
    assert.equal(providerConfigured({root:bare},{}),false);
    assert.equal(measureBoundary({root:bare},{}).hardenedAvailable,false);
  });
});

describe('one broken custody or deployment requirement closes HARDENED', { skip: SUITE_SKIP }, () => {
  const cases: Array<[string,(p:Payload)=>void,RegExp]> = [
    ['stale',p=>{p.startedAt-=3600000;p.finishedAt-=3600000;},/stale/],
    ['future',p=>{p.startedAt+=3600000;p.finishedAt+=3600000;},/future/],
    ['foreign host',p=>{p.host='foreign';},/host/],
    ['foreign OS identity',p=>{p.user='S-1-0-0';},/identity/],
    ['foreign platform/schema',p=>{Reflect.set(p,'schema','linux-production/2');},/foreign/],
    ['foreign toolchain',p=>{p.tools='0'.repeat(64);},/toolchain/],
    ['foreign store',p=>{p.store=root;},/foreign/],
    ['foreign deployment',p=>{p.deployment=crypto.randomUUID();},/foreign/],
    ['replayed generation',p=>{p.nonce=crypto.randomUUID();},/replayed/],
    ['missing observations',p=>{Reflect.deleteProperty(p,'observations');},/./],
    ['zero attacks',p=>{p.observations.native[0]!.restricted.attempts=[];},/attacks/],
    ['failed battery',p=>{p.observations.native[0]!.restricted.attempts[0]!.allowed=true;},/attack/],
    ['inconclusive egress',p=>{p.observations.native[0]!.restricted.network.isolationError=0;},/egress/],
    ['foreign authority target',p=>{p.observations.native[0]!.restricted.attempts.find(a=>a.id==='authority-write-0')!.target=root;},/target/],
    ['broker did not promote',p=>{p.observations.authority.find(a=>a.response.appliedBy==='broker')!.response.appliedBy='caller';},/readback/],
    ['readback mismatch',p=>{p.observations.promotedTree='foreign';},/readback/],
    ['unconfined review accepted',p=>{p.observations.authority[0]!.client.appContainer=false;},/identity/],
    ['missing positive control',p=>{p.observations.native[0]!.control.attempts[0]!.allowed=false;},/control/],
    ['attack never executed',p=>{p.observations.native[0]!.restricted.attempts[0]!.executed=false;},/attack/],
    ['missing listener observation',p=>{Reflect.deleteProperty(p.observations.native[0]!,'connectionsBeforePostControl');},/egress/],
  ];
  for (const [name,mutate,reason] of cases) it(name+' -> NOT HARDENED',()=>{changed(mutate);closed(reason);});
  it('caller-created signed record cannot mint custody',()=>{changed(()=>{},true);closed(/producer/);});
  it('tampered bytes cannot retain the signature',()=>{
    const next=structuredClone(record);next.payload.host='tampered';put(recordFile,next);
    put(anchorFile,{...anchor,current:crypto.createHash('sha256').update(JSON.stringify(next)).digest('hex')});
    closed(/producer/);
  });
  it('missing private signing key prevents the live proof',()=>{
    fs.unlinkSync(path.join(store,'producer.key'));closed(/live broker/);
  });
  it('saved record without enrolled public custody is refused',()=>{
    fs.unlinkSync(anchorFile);closed(/ENOENT/);
  });
  it('no measurement remains fail closed',()=>{fs.unlinkSync(recordFile);closed();});
  it('copy to another store never activates',()=>{
    const copy=path.join(root,'copied');fs.mkdirSync(copy);put(path.join(copy,PRODUCTION_MEASUREMENT),record);
    assert.equal(measureBoundary({root:copy},{}).hardenedAvailable,false);
  });
});

describe('each required raw control cannot be replaced by claims', { skip: SUITE_SKIP },()=>{
  const slots = {
    authorityCustody: (p:Payload) => [p.observations.native[0]!.restricted.attempts,'0'] as const,
    workerFilesystem: (p:Payload) => [p.observations.native[0]!.token,'0'] as const,
    verificationSandbox: (p:Payload) => [p.observations.native[1]!.restricted.attempts,String(p.observations.native[1]!.restricted.attempts.findIndex(a=>a.id==='descendant-read'))] as const,
    authenticatedReview: (p:Payload) => [p.observations,'pipeNegative'] as const,
    protectedPromotion: (p:Payload) => [p.observations,'promotedTree'] as const,
    networkEgress: (p:Payload) => [p.observations.native[0]!,'restricted'] as const,
  };
  for(const control of ALL_CONTROLS) for(const mode of ['missing','null','claim-only','boolean']) {
    it(control+' '+mode+' -> NOT HARDENED',()=>{
      changed(p=>{
        const [owner,field]=slots[control](p);
        if(mode==='missing') Reflect.deleteProperty(owner,field);
        else Reflect.set(owner,field,mode==='null'?null:mode==='boolean'?true:{available:true,pass:true,complete:true});
      });
      closed();
    });
  }
});

describe('retired schema and malformed evidence', { skip: SUITE_SKIP },()=>{
  it('schema 1 can never activate even with caller-owned signing material',()=>{
    const legacy=path.join(root,'legacy');fs.mkdirSync(legacy);
    fs.writeFileSync(path.join(legacy,'custody-key-material.txt'),'caller-owned');
    put(path.join(legacy,'confined-caller-measurement.json'),{schema:'canary-confined-measurement/1',deployment:{complete:true},battery:{pass:100,fail:0,inconclusive:0},controls:ALL_CONTROLS.map(control=>({control,available:true}))});
    assert.equal(readConfinedMeasurement(legacy,{}).valid,false);
    assert.equal(measureBoundary({root:legacy},{}).hardenedAvailable,false);
  });
  it('garbage is refused without throwing',()=>{
    for(const junk of ['', '{','null','[]','{"schema":"other/1"}']) {
      fs.writeFileSync(recordFile,junk);
      assert.equal(readProductionMeasurement(store).valid,false);
    }
  });
});

describe('saved evidence requires a current authenticated live broker', { skip: SUITE_SKIP },()=>{
  it('same saved evidence with dead broker -> NOT HARDENED',()=>{
    assert.equal(readProductionMeasurement(store).valid,true);
    const r=spawnSync('taskkill',['/PID',String(brokerPid),'/T','/F'],{windowsHide:true,encoding:'utf8'});
    assert.equal(r.status,0,r.stderr);
    closed(/live production broker unavailable/);
  });
  for(const mode of ['key','generation','deployment','replay']) {
    it('live wrong '+mode+' -> NOT HARDENED',async()=>{
      const config=path.join(root,'false-'+mode+'.json'),readyFile=config+'.ready';
      put(config,{mode,ready:readyFile,pipe:e.pipe,deployment:e.id,generation:anchor.nonce,measurement:anchor.current,key:path.join(store,'producer.key')});
      const child=spawn(process.execPath,[path.join(repo,'tooling/test-support/fixtures/production-false-broker.cjs'),config],{windowsHide:true,stdio:'ignore'});
      try { await ready(readyFile,child,10000);closed(/live broker identity not proven/); }
      finally { child.kill(); while(child.exitCode===null && child.signalCode===null) await pause(); }
    });
  }
});
