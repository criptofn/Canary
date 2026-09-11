import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { authorityJson, RECORD_SCHEMA, signedBytes, type RecordEnvelope } from '../src/authority-envelope.js';
import { BROKER_SCHEMA, LocalAuthorityBroker, type Enrollment, type RunTicket, type VerificationStatement } from '../src/broker.js';
import { declaredTask, subjectDigest } from '../src/authorization.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-broker-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const projectId = 'a'.repeat(64), targetId = 'b'.repeat(64);
const verifier = crypto.generateKeyPairSync('ed25519'), reviewer = crypto.generateKeyPairSync('ed25519');
const publicPem = (key: crypto.KeyObject) => key.export({ type: 'spki', format: 'pem' }) as string;
const hash = (v: unknown) => crypto.createHash('sha256').update(authorityJson(v)).digest('hex');
let n = 0;
function fixture(subjective = true, enroll = true) {
  const store = { root: path.join(tmp, String(n++)) };
  const broker = new LocalAuthorityBroker(store, projectId);
  const task = declaredTask('fix calculation', ['bugfix'], ['negative numbers work']);
  const enrollment: Enrollment = {
    minimumLevel: 'LOCAL', verifierKey: publicPem(verifier.publicKey), reviewerKey: publicPem(reviewer.publicKey),
    subject: { candidate: 'candidate', candidateCommit: 'c'.repeat(40), candidateTree: 'd'.repeat(40), baseHead: 'e'.repeat(40), baseTree: 'f'.repeat(40), baseAuthorityIdentity: '1'.repeat(64), frozenTask: task, liveTask: task, subjectiveDuties: subjective ? ['visual'] : [] },
    policy: { adapterId: 'node', planDigest: '2'.repeat(64), environmentDigest: '3'.repeat(64), objectiveDuties: ['tests', 'negative-numbers'], targetId, network: { mode: 'deny', origins: [] } },
  };
  if (enroll) broker.enroll(enrollment);
  const request = (op: string, fields: object = {}) => broker.request(JSON.stringify({ schema: BROKER_SCHEMA, projectId, op, ...fields }));
  const run = () => broker.beginPromotion(enrollment.subject, targetId);
  const verifyRun = () => request('request-verification', { subjectDigest: subjectDigest(enrollment.subject) }) as RunTicket;
  const result = (ticket: RunTicket): VerificationStatement => ({ ...ticket, evidenceDigest: '4'.repeat(64), clean: true, objectiveResults: [{ id: 'tests', status: 'met' }, { id: 'negative-numbers', status: 'met' }] });
  const receipt = <T extends RunTicket>(kind: string, payload: T, key = verifier.privateKey): RecordEnvelope => {
    const body = { schema: RECORD_SCHEMA, projectId, kind, seq: payload.sequence, issuedAt: '2026-09-11T00:00:00.000Z', canaryVersion: 'test', payload };
    return { ...body, signature: crypto.sign(null, signedBytes(body), key).toString('base64') };
  };
  const accept = (v: VerificationStatement) => receipt('human-acceptance', { ...pickRun(v), verificationDigest: hash(v), duties: enrollment.subject.subjectiveDuties, decision: 'accept' }, reviewer.privateKey);
  return { store, broker, enrollment, request, run, verifyRun, result, receipt, accept };
}
function pickRun(v: RunTicket): RunTicket { return { runId: v.runId, sequence: v.sequence, subjectDigest: v.subjectDigest, policyDigest: v.policyDigest, purpose: v.purpose }; }

test('a green routine verification cannot authorize promotion; controller must start a fresh window', () => {
  const f = fixture(false), v = f.result(f.verifyRun());
  f.request('submit-verification', { receipt: f.receipt('verification-result', v) });
  assert.throws(() => f.broker.reservePromotion(f.enrollment.subject, targetId), /fresh/);
  const run = f.run();
  assert.equal(run.purpose, 'promotion');
  assert.notEqual(run.runId, v.runId);
  assert.throws(() => f.request('submit-verification', { receipt: f.receipt('verification-result', v) }));
  assert.throws(() => f.request('beginPromotion', { receipt: {} }));
});

test('separate verifier + reviewer signatures authorize exactly one LOCAL promotion reservation across restart', () => {
  const f = fixture(), run = f.run(), result = f.result(run);
  f.request('submit-verification', { receipt: f.receipt('verification-result', result) });
  assert.throws(() => f.request('submit-verification', { receipt: f.receipt('verification-result', result) }), /consumed/);
  assert.throws(() => f.broker.reservePromotion(f.enrollment.subject, targetId), /subjective/);
  f.request('submit-acceptance', { receipt: f.accept(result) });
  const restarted = new LocalAuthorityBroker(f.store, projectId);
  const intent = restarted.reservePromotion(f.enrollment.subject, targetId);
  assert.equal(intent.level, 'LOCAL');
  assert.equal(intent.candidateTree, f.enrollment.subject.candidateTree);
  assert.equal(intent.expectedHead, f.enrollment.subject.baseHead);
  assert.throws(() => restarted.reservePromotion(f.enrollment.subject, targetId));
  assert.throws(() => f.run(), /reconciliation/);
});
test('no subjective duties still requires objective proof but no invented acceptance', () => {
  const f = fixture(false), v = f.result(f.run());
  assert.throws(() => f.broker.reservePromotion(f.enrollment.subject, targetId));
  f.request('submit-verification', { receipt: f.receipt('verification-result', v) });
  assert.equal(f.broker.reservePromotion(f.enrollment.subject, targetId).targetId, targetId);
});
test('worker cannot enroll, sign, spawn, accept-yes, promote or supply executable authority', () => {
  const f = fixture();
  for (const op of ['enroll', 'sealRecord', 'spawn', 'accept', 'promote']) assert.throws(() => f.request(op, { receipt: {} }));
  for (const key of ['command', 'cwd', 'env', 'store', 'publicKey', 'isTTY', 'network', 'targetId']) assert.throws(() => f.request('request-verification', { subjectDigest: subjectDigest(f.enrollment.subject), [key]: 'attacker' }), /unexpected fields/);
  assert.throws(() => f.broker.request(JSON.stringify({ schema: BROKER_SCHEMA, projectId: 'b'.repeat(64), op: 'request-verification', subjectDigest: subjectDigest(f.enrollment.subject) })), /project/);
  assert.throws(() => f.request('request-verification', { subjectDigest: '0'.repeat(64) }), /authority/);
});
test('HARDENED, weak keys, shared principals and empty plans cannot be enrolled', () => {
  const f = fixture(true, false);
  assert.throws(() => f.broker.enroll({ ...f.enrollment, minimumLevel: 'HARDENED' }), /HARDENED unavailable/);
  assert.throws(() => f.broker.enroll({ ...f.enrollment, reviewerKey: f.enrollment.verifierKey }), /distinct/);
  assert.throws(() => f.broker.enroll({ ...f.enrollment, verifierKey: 'not a key' }));
  assert.throws(() => f.broker.enroll({ ...f.enrollment, policy: { ...f.enrollment.policy, objectiveDuties: [] } }), /empty/);
  f.broker.enroll(f.enrollment);
  assert.throws(() => f.broker.enroll(f.enrollment), /compare-and-swap/);
});
test('new run invalidates verification and acceptance, even for unchanged source', () => {
  const f = fixture(), v = f.result(f.run());
  f.request('submit-verification', { receipt: f.receipt('verification-result', v) });
  f.request('submit-acceptance', { receipt: f.accept(v) });
  const next = f.run();
  assert.notEqual(next.runId, v.runId);
  assert.throws(() => f.request('submit-verification', { receipt: f.receipt('verification-result', v) }));
  assert.throws(() => f.request('submit-acceptance', { receipt: f.accept(v) }));
  assert.throws(() => f.broker.reservePromotion(f.enrollment.subject, targetId));
});
test('valid signatures cannot cross role, project, run, subject or policy boundaries', () => {
  const f = fixture(), v = f.result(f.run());
  assert.throws(() => f.request('submit-verification', { receipt: f.receipt('verification-result', v, reviewer.privateKey) }));
  assert.throws(() => f.request('submit-verification', { receipt: f.receipt('human-acceptance', v) }));
  for (const field of ['runId', 'subjectDigest', 'policyDigest'] as const) assert.throws(() => f.request('submit-verification', { receipt: f.receipt('verification-result', { ...v, [field]: '0'.repeat(64) }) }));
  assert.throws(() => f.request('submit-verification', { receipt: f.receipt('verification-result', { ...v, purpose: 'verification' }) }));
  const wrongProject = f.receipt('verification-result', v);
  wrongProject.projectId = 'b'.repeat(64);
  const { signature: _signature, ...body } = wrongProject;
  wrongProject.signature = crypto.sign(null, signedBytes(body), verifier.privateKey).toString('base64');
  assert.throws(() => f.request('submit-verification', { receipt: wrongProject }));
});
for (const failure of ['unmet', 'unknown', 'dirty'] as const) test(`human signature cannot waive ${failure} objective proof`, () => {
  const f = fixture(), v = f.result(f.run());
  if (failure === 'dirty') v.clean = false;
  else v.objectiveResults[0]!.status = failure;
  f.request('submit-verification', { receipt: f.receipt('verification-result', v) });
  assert.throws(() => f.request('submit-acceptance', { receipt: f.accept(v) }), /cannot waive/);
  assert.throws(() => f.broker.reservePromotion(f.enrollment.subject, targetId));
});
test('missing, extra and duplicate objective duties are refused despite a valid verifier signature', () => {
  const f = fixture(), v = f.result(f.run());
  for (const results of [[], [v.objectiveResults[0]], [...v.objectiveResults, v.objectiveResults[0]], [...v.objectiveResults, { id: 'extra', status: 'met' }]]) {
    assert.throws(() => f.request('submit-verification', { receipt: f.receipt('verification-result', { ...v, objectiveResults: results }) }));
  }
});
test('acceptance binds verification contents and exact subjective scope, never terminal presence', () => {
  const f = fixture(), v = f.result(f.run());
  f.request('submit-verification', { receipt: f.receipt('verification-result', v) });
  for (const change of [{ duties: [] }, { duties: ['visual', 'extra'] }, { verificationDigest: '0'.repeat(64) }, { decision: 'reject' }, { isTTY: true }]) {
    const payload = { ...(f.accept(v).payload as object), ...change } as unknown as RunTicket;
    assert.throws(() => f.request('submit-acceptance', { receipt: f.receipt('human-acceptance', payload, reviewer.privateKey) }));
  }
  assert.throws(() => f.request('submit-acceptance', { receipt: f.receipt('human-acceptance', f.accept(v).payload as RunTicket) }));
});
test('promotion refuses all changed subject fields and foreign target mapping', () => {
  const f = fixture(false), v = f.result(f.run());
  f.request('submit-verification', { receipt: f.receipt('verification-result', v) });
  for (const field of ['candidateCommit', 'candidateTree', 'baseHead', 'baseTree'] as const) assert.throws(() => f.broker.reservePromotion({ ...f.enrollment.subject, [field]: '0'.repeat(40) }, targetId));
  assert.throws(() => f.broker.reservePromotion(f.enrollment.subject, '0'.repeat(64)));
  assert.throws(() => f.broker.reservePromotion({ ...f.enrollment.subject, liveTask: declaredTask('changed work', ['bugfix'], []) }, targetId), /weakened/);
});
test('egress policy never treats wildcard, credentials, path or implicit allow as an origin grant', () => {
  const f = fixture(false, false);
  for (const network of [{ mode: 'allowlist', origins: [] }, { mode: 'deny', origins: ['https://example.com'] }, ...['*', 'http://example.com', 'https://x:y@example.com', 'https://example.com/path'].map(origin => ({ mode: 'allowlist', origins: [origin] }))]) {
    assert.throws(() => f.broker.enroll({ ...f.enrollment, policy: { ...f.enrollment.policy, network } } as Enrollment));
  }
});
