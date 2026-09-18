/** A v2 record is a signed transcript from this deployment, not a capability flag.
 * Public-key/current-generation custody is anchored outside caller-selected stores.
 * Schema 1 is not parsed by this module and remains permanently retired. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { packagedProvider, providerRoot as repo } from './assets.js';
const hash = (b: string | Buffer): string => crypto.createHash('sha256').update(b).digest('hex');
export const PRODUCTION_MEASUREMENT = 'production-measurement.json';
export const NATIVE_ATTACKS = ['inherited-file', 'inherited-process-duplicate', 'acquire-and-duplicate-broker-file',
  'direct', 'extended', 'relative', 'dot-components', 'junction', 'symlink', 'temp-copy', 'rename-out',
  'authority-write-0', 'authority-write-1', 'authority-write-2', 'authority-write-3', 'authority-write-4', 'descendant-read'] as const;
export function productionHost(): { user: string; host: string; profile: string } {
  if (process.platform !== 'win32') throw new Error('native host identity unavailable');
  const r = spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ['-NoProfile', '-NonInteractive', '-File', path.join(repo, 'tools/windows-boundary/production-host.ps1')],
    { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (r.status !== 0) throw new Error('OS-owned host/profile binding unavailable');
  return JSON.parse(r.stdout);
}
function safeRead(file: string): Buffer {
  for (let p = path.resolve(file); ; p = path.dirname(p)) {
    const stat = fs.lstatSync(p);
    if (stat.isSymbolicLink()) throw new Error('linked custody refused');
    if (p === file && (!stat.isFile() || stat.nlink !== 1 || stat.size > 32 * 1024 * 1024)) throw new Error('invalid custody file');
    if (path.dirname(p) === p) break;
  }
  return fs.readFileSync(file);
}
const read = <T>(file: string): T => JSON.parse(safeRead(file).toString('utf8')) as T;
export function anchorPath(store: string): string {
  return path.join(productionHost().profile, '.canary-native-authorities', `${hash(path.resolve(store).toLowerCase())}.json`);
}
interface Anchor { store: string; deployment: string; publicKey: string; nonce: string; current: string | null }
export function measurementGeneration(store: string): { generation: string; measurement: string | null } {
  const anchor = read<Anchor>(anchorPath(store));
  return { generation: anchor.nonce, measurement: anchor.current };
}
function atomic(file: string, value: unknown): void {
  const temp = `${file}.${crypto.randomUUID()}`;
  fs.writeFileSync(temp, JSON.stringify(value), { flag: 'wx' });
  fs.renameSync(temp, file);
}
/** Operator enrollment only. A confined caller cannot create this OS-profile anchor. */
export function enrollMeasurementAuthority(store: string, deployment: string, publicKey: string): void {
  const file = anchorPath(store);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) throw new Error('measurement authority already enrolled');
  fs.writeFileSync(file, JSON.stringify({ store: fs.realpathSync(store), deployment, publicKey, nonce: crypto.randomUUID(), current: null } satisfies Anchor), { flag: 'wx' });
}
export function removeMeasurementAuthority(store: string, deployment: string): void {
  const file = anchorPath(store), anchor = read<Anchor>(file);
  if (anchor.deployment !== deployment || anchor.store !== fs.realpathSync(store)) throw new Error('foreign custody removal refused');
  fs.unlinkSync(file);
}
/** Begin invalidates all earlier measurements before any new attack runs. */
export function beginProductionMeasurement(store: string): string {
  const file = anchorPath(store), anchor = read<Anchor>(file);
  const nonce = crypto.randomUUID(); atomic(file, { ...anchor, nonce, current: null });
  atomic(path.join(store, 'measurement-session.json'), { nonce, startedAt: Date.now() });
  return nonce;
}
export function productionToolsDigest(store: string): string {
  const h = crypto.createHash('sha256');
  const visit = (dir: string): void => {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error('linked boundary toolchain refused');
      h.update(path.relative(repo, file));
      if (stat.isDirectory()) visit(file); else h.update(fs.readFileSync(file));
    }
  };
  visit(path.join(repo, 'tools/windows-boundary'));
  visit(path.join(repo, packagedProvider ? 'dist' : 'apps/cli/dist/src'));
  for (const name of ['boundary-native-child.cs', 'boundary-native-parent.cs', 'boundary-native-run.ps1', 'confined-listener.cjs', 'confined-caller.cjs', 'medium-pipe.ps1'])
    h.update(fs.readFileSync(path.join(repo, 'tooling/test-support/fixtures', name)));
  for (const group of packagedProvider ? [] : ['core', 'runner', 'evidence', 'support']) {
    const root = path.join(repo, 'packages', group);
    if (fs.existsSync(path.join(root, 'dist'))) visit(path.join(root, 'dist'));
    else for (const name of fs.readdirSync(root).sort()) if (fs.existsSync(path.join(root, name, 'dist'))) visit(path.join(root, name, 'dist'));
  }
  visit(path.join(store, 'runtime'));
  h.update(fs.readFileSync(process.execPath));
  return h.digest('hex');
}
export interface NativeObservation {
  package: string;
  control: { environment: string | null; attempts: Array<{ id: string; executed: boolean; allowed: boolean; error: number; target: string | null }>; network: { executed: boolean; result: string; diagnosticReturn: number; isolationError: number; host: string; port: number } };
  restricted: NativeObservation['control'];
  token: Array<Record<string, unknown>>;
  connectionsBeforePostControl: number; connectionsAfterPostControl: number; postControl: string;
}
interface AuthorityEvent { client: Record<string, unknown>; request: Record<string, unknown>; response: Record<string, unknown> }
export interface ProductionTranscript {
  framing: { at: string; client: Record<string, unknown>; requestJson: string; response: { status: number } };
  native: NativeObservation[];
  authority: AuthorityEvent[];
  enrollmentDigest: string;
  promotedHead: string;
  promotedTree: string;
  pipeNegative: { control: PipeReport; restricted: PipeReport; token: Array<Record<string, unknown>>; descriptor: { dacl: string }; nonce: string };
}
interface PipeReport { nonce?: string; error?: string; broker?: Array<{ response?: { status?: number } }> }
interface Payload {
  schema: 'canary-production-measurement/2'; deployment: string; store: string;
  host: string; user: string; tools: string; nonce: string; startedAt: number; finishedAt: number;
  observations: ProductionTranscript;
}
/** Each required result is derived from concrete native return values and broker
 * transcripts. Aggregate pass/complete/available fields have no authority. */
function checkObservations(p: Payload, enrollment: { package: string; verifier: string; project: string; base: string }): void {
  const framing = p.observations.framing;
  if (!framing || framing.response.status !== 403 || framing.client.package !== enrollment.package || framing.client.identity !== p.user ||
      framing.client.appContainer !== true || framing.client.restricted !== true || framing.client.capabilities !== 0 ||
      framing.client.integrity !== 'S-1-16-4096' || !Number.isFinite(Date.parse(framing.at)) ||
      Date.parse(framing.at) < p.startedAt || Date.parse(framing.at) > p.finishedAt) throw new Error('framing attack denial not observed');
  // Reproduce the unsafe control directly from the bytes the real pipe received.
  const unsafe = JSON.parse('{"client":{"appContainer":true},"request":' + framing.requestJson + '}');
  if (unsafe.client.appContainer !== false || unsafe.request.verb !== 'heartbeat' ||
      unsafe.request.project !== enrollment.project || unsafe.request.deployment !== p.deployment)
    throw new Error('framing positive control missing');
  let malformed = false;
  try { JSON.parse(framing.requestJson); } catch { malformed = true; }
  if (!malformed) throw new Error('framing attack did not execute');
  const events = p.observations.authority;
  if (!Array.isArray(events) || events.length !== 10) throw new Error('production authority attacks missing or unexpected');
  const review = events.find(x => x.request.verb === 'review' && x.response.status === 200);
  const apply = events.find(x => x.request.verb === 'promote' && x.response.status === 200);
  if (!review || !apply || typeof review.request.candidate !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,40}$/.test(review.request.candidate)) throw new Error('production positive control missing');
  if (p.observations.native.length !== 2) throw new Error('both caller and verifier attack observations required');
  for (const sid of [enrollment.package, enrollment.verifier]) {
    const n = p.observations.native.find(x => x.package === sid);
    if (!n || n.token.length !== 2 || n.token[0]?.package !== sid || n.token[0]?.appContainer !== true ||
      n.token[0]?.restricted !== true || n.token[0]?.integrity !== 'S-1-16-4096' || n.token[0]?.capabilities !== 0 ||
      n.token[1]?.pid !== n.token[0]?.pid || n.token[1]?.exit !== 0) throw new Error('native execution/token not established');
    if (n.control.attempts.length !== NATIVE_ATTACKS.length || n.restricted.attempts.length !== NATIVE_ATTACKS.length) throw new Error('missing or extra native attacks');
    if (n.control.environment !== 'trusted-parent-only-test-value' || n.restricted.environment !== null) throw new Error('environment secrecy not established');
    for (const id of NATIVE_ATTACKS) {
      const controls = n.control.attempts.filter(x => x.id === id), attacks = n.restricted.attempts.filter(x => x.id === id);
      if (controls.length !== 1 || attacks.length !== 1 || controls[0]?.executed !== true || controls[0]?.allowed !== true || controls[0]?.error !== 0 ||
        attacks[0]?.executed !== true || attacks[0]?.allowed !== false || ![5, 6, -1073741816].includes(attacks[0]?.error ?? 0)) throw new Error(`native attack/control failed: ${id}`);
    }
    const targets = [path.join(p.store, 'producer.key'), path.join(p.store, 'enrollment.json'), anchorPath(p.store), path.join(enrollment.base, '.git', 'HEAD'),
      path.join(os.tmpdir(), `canary-production-${p.deployment}-${review.request.candidate}`, '.git')];
    for (let i = 0; i < targets.length; i++) {
      if (n.control.attempts.find(x => x.id === `authority-write-${i}`)?.target !== targets[i] ||
          n.restricted.attempts.find(x => x.id === `authority-write-${i}`)?.target !== targets[i]) throw new Error('foreign authority attack target');
    }
    const c = n.control.network, a = n.restricted.network;
    if (c.executed !== true || c.result !== 'CONNECTED' || a.executed !== true || typeof a.result !== 'string' || !/^(TIMEOUT|WSA-\d+)$/.test(a.result) ||
      typeof c.host !== 'string' || !/^\d+\.\d+\.\d+\.\d+$/.test(c.host) || !Number.isInteger(c.port) || c.port <= 0 || c.port > 65535 || c.host !== a.host || c.port !== a.port ||
      n.connectionsBeforePostControl !== 1 || n.connectionsAfterPostControl !== 2 || n.postControl !== 'CONNECTED' ||
      !(a.result === 'WSA-10013' || (a.diagnosticReturn === 0 && [1,2,3].includes(a.isolationError) && c.diagnosticReturn === 0 && c.isolationError === 0)))
      throw new Error('egress failed or inconclusive');
  }
  for (const event of events) {
    if (event.request.challenge !== p.nonce || event.client.package !== enrollment.package ||
      event.client.appContainer !== true || event.client.restricted !== true || event.client.capabilities !== 0 ||
      event.client.integrity !== 'S-1-16-4096' || event.client.identity !== p.user || ![200,403].includes(Number(event.response.status))) throw new Error('foreign production attack identity/challenge or failed result');
  }
  if (!review || !apply || apply.response.appliedBy !== 'broker' || apply.response.head !== review.response.head ||
      p.observations.promotedHead !== apply.response.head || p.observations.promotedTree !== apply.response.tree ||
      apply.request.receipt !== review.response.receipt || apply.request.digest !== review.response.digest) throw new Error('production positive control/readback missing');
  const denied = events.filter(x => x.response.status === 403);
  const r = review.response;
  const needed: Array<(e: AuthorityEvent) => boolean> = [
    e => e.request.verb === 'enroll',
    e => e.request.verb === 'promote' && events.indexOf(e) < events.indexOf(review),
    e => e.request.verb === 'promote' && e.request.receipt === r.receipt && Object.hasOwn(e.request, 'body'),
    e => e.request.verb === 'promote' && e.request.receipt === r.receipt && e.request.digest !== r.digest,
    e => e.request.verb === 'promote' && e.request.receipt === r.receipt && e.request.project !== enrollment.project,
    e => e.request.verb === 'promote' && e.request.receipt === r.receipt && e.request.candidate !== review.request.candidate,
    e => e.request.verb === 'promote' && events.indexOf(e) > events.indexOf(review) && e.request.receipt !== r.receipt,
    e => e.request.verb === 'promote' && events.indexOf(e) > events.indexOf(apply) && e.request.receipt === r.receipt,
  ];
  if (needed.some(predicate => !denied.some(predicate))) throw new Error('production authority attack battery incomplete');
  const pipe = p.observations.pipeNegative;
  if (!pipe || pipe.nonce !== p.nonce || pipe.control.nonce !== p.nonce || pipe.restricted.nonce !== p.nonce ||
      pipe.control.broker?.[0]?.response?.status !== 200 || !/pipe-connect (EPERM|EACCES)/.test(String(pipe.restricted.error)) ||
      pipe.token[0]?.package !== enrollment.package || pipe.token[0]?.appContainer !== true || pipe.token[0]?.restricted !== true ||
      pipe.token[0]?.capabilities !== 0 || pipe.token[0]?.integrity !== 'S-1-16-4096' || pipe.token[1]?.exit !== 3 ||
      pipe.token[1]?.pid !== pipe.token[0]?.pid || !pipe.descriptor.dacl.includes(enrollment.package) ||
      pipe.descriptor.dacl.split('(').some(ace => ace.startsWith('A;') && ace.includes(enrollment.package)))
    throw new Error('pipe negative control missing or inconclusive');
}
export function publishProductionMeasurement(store: string, nonce: string, startedAt: number, observations: ProductionTranscript): void {
  const anchorFile = anchorPath(store), anchor = read<Anchor>(anchorFile);
  const e = read<{ id: string; package: string; verifier: string; project: string; base: string }>(path.join(store, 'enrollment.json'));
  const host = productionHost();
  if (anchor.nonce !== nonce || anchor.deployment !== e.id || anchor.store !== fs.realpathSync(store)) throw new Error('measurement generation changed');
  const payload: Payload = { schema: 'canary-production-measurement/2', deployment: e.id, store: anchor.store, host: host.host, user: host.user,
    tools: productionToolsDigest(store), nonce, startedAt, finishedAt: Date.now(), observations };
  checkObservations(payload, e);
  const signature = crypto.sign(null, Buffer.from(JSON.stringify(payload)), safeRead(path.join(store, 'producer.key'))).toString('base64');
  const record = { payload, signature };
  atomic(path.join(store, PRODUCTION_MEASUREMENT), record);
  atomic(anchorFile, { ...anchor, current: hash(JSON.stringify(record)) });
}
export function readProductionMeasurement(store: string, now = Date.now()): { valid: boolean; reason: string; payload?: Payload } {
  try {
    const anchor = read<Anchor>(anchorPath(store));
    const record = read<{ payload: Payload; signature: string }>(path.join(store, PRODUCTION_MEASUREMENT));
    const p = record.payload, e = read<{ id: string; package: string; verifier: string; project: string; base: string; pipe: string }>(path.join(store, 'enrollment.json'));
    const host = productionHost();
    if (p.schema !== 'canary-production-measurement/2' || p.store !== fs.realpathSync(store) || anchor.store !== p.store ||
        p.deployment !== e.id || anchor.deployment !== e.id || p.nonce !== anchor.nonce || anchor.current !== hash(JSON.stringify(record))) throw new Error('copied, replayed or foreign deployment record');
    if (!crypto.verify(null, Buffer.from(JSON.stringify(p)), anchor.publicKey, Buffer.from(record.signature, 'base64'))) throw new Error('unauthenticated measurement producer');
    if (p.host !== host.host || p.user !== host.user) throw new Error('foreign host identity');
    if (![p.startedAt,p.finishedAt,now].every(Number.isFinite) || p.startedAt > p.finishedAt || p.finishedAt > now || now - p.startedAt > 15 * 60 * 1000) throw new Error('stale or future measurement');
    if (p.tools !== productionToolsDigest(store)) throw new Error('foreign boundary toolchain');
    if (p.observations.enrollmentDigest !== hash(safeRead(path.join(store, 'enrollment.json')))) throw new Error('enrollment changed');
    checkObservations(p, e);
    const nonce = crypto.randomBytes(32).toString('hex');
    const heartbeat = spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      ['-NoProfile', '-NonInteractive', '-File', path.join(repo, 'tools/windows-boundary/production-heartbeat.ps1'),
        '-Pipe', e.pipe, '-Nonce', nonce, '-Deployment', e.id, '-Project', e.project],
      { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    if (heartbeat.status !== 0) throw new Error('live production broker unavailable');
    const live = JSON.parse(heartbeat.stdout);
    if (live.status !== 200 || live.payload?.schema !== 'canary-production-heartbeat/2' || live.payload.deployment !== e.id || live.payload.nonce !== nonce ||
        live.payload.generation !== anchor.nonce || live.payload.measurement !== anchor.current ||
        !crypto.verify(null, Buffer.from(JSON.stringify(live.payload)), anchor.publicKey, Buffer.from(live.signature, 'base64'))) throw new Error('live broker identity not proven');
    return { valid: true, reason: 'production deployment and executed attack transcript verified', payload: p };
  } catch(e) { return { valid: false, reason: String((e as Error).message) }; }
}
