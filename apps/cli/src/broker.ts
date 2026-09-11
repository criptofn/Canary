/** LOCAL authorization kernel, not a daemon and not a sandbox launcher.
 * This module NEVER executes candidate code, project discovery, Git or callbacks.
 * A future service exposes ONLY request() to authenticated project-scoped workers.
 * enroll() and reservePromotion() are controller capabilities, never RPC verbs.
 * Same-UID callers can instantiate their own controller: LOCAL is the ceiling.
 */
import crypto from 'node:crypto';
import { authorityJson, verifySeal, type RecordEnvelope } from './authority-envelope.js';
import { canonicalTask, subjectDigest, taskWeakening, type AuthorizationSubject } from './authorization.js';
import { openSealed, sealRecord, type TrustStore } from './trust-store.js';
import { requireAuthorizationLevel, validateNetworkAuthority, type NetworkAuthority } from './platform-boundary.js';

export const BROKER_SCHEMA = 'canary-broker/1';
const HEX = /^[0-9a-f]{64}$/;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const hash = (v: unknown) => crypto.createHash('sha256').update(authorityJson(v)).digest('hex');
function requireThat(ok: unknown, reason: string): asserts ok { if (!ok) throw new Error(reason); }
function exact(v: unknown, fields: string[]): asserts v is Record<string, unknown> {
  requireThat(v && typeof v === 'object' && !Array.isArray(v)
    && Object.keys(v).sort().join(',') === fields.sort().join(','), 'unexpected fields at authority boundary');
}
function ids(v: unknown): asserts v is string[] {
  requireThat(Array.isArray(v) && v.every(x => typeof x === 'string' && ID.test(x))
    && new Set(v).size === v.length && v.length <= 128, 'invalid duty identifiers');
}

/** Desired authority, never evidence that the OS actually enforces it.
 * No command/cwd/env/mount/credential is accepted from a worker. A platform
 * supervisor resolves these digests and IDs from controller-owned resources. */
export interface ExecutionPolicy {
  adapterId: string;
  planDigest: string;
  environmentDigest: string;
  objectiveDuties: string[];
  network: NetworkAuthority;
  targetId: string; // controller-owned repository/ref mapping, not a path
}
export interface Enrollment {
  subject: AuthorizationSubject;
  policy: ExecutionPolicy;
  verifierKey: string; // trusted supervisor's key; NOT the candidate runner's
  reviewerKey: string; // separately enrolled review principal, NOT TTY presence
  minimumLevel: 'LOCAL' | 'HARDENED';
}
export interface RunTicket {
  runId: string; sequence: number; subjectDigest: string; policyDigest: string;
  purpose: 'verification' | 'promotion';
}
export interface VerificationStatement extends RunTicket {
  evidenceDigest: string;
  clean: boolean;
  objectiveResults: { id: string; status: 'met' | 'unmet' | 'unknown' }[];
}
export interface AcceptanceStatement extends RunTicket {
  verificationDigest: string;
  duties: string[];
  decision: 'accept';
}
/** JSON wire protocol. The authenticated transport supplies projectId to the
 * broker instance; the redundant request projectId must match, never select it. */
export type WorkerRequest =
  | { schema: typeof BROKER_SCHEMA; projectId: string; op: 'request-verification'; subjectDigest: string }
  | { schema: typeof BROKER_SCHEMA; projectId: string; op: 'submit-verification' | 'submit-acceptance'; receipt: RecordEnvelope };
export interface PromotionIntent {
  level: 'LOCAL'; projectId: string; targetId: string; runId: string;
  expectedHead: string; candidateCommit: string; candidateTree: string;
  subjectDigest: string; verificationDigest: string;
}
interface State {
  schema: typeof BROKER_SCHEMA; enrollment: Enrollment;
  phase: 'enrolled' | 'running' | 'verified' | 'accepted' | 'promotion-reserved';
  run: RunTicket | null;
  verification: VerificationStatement | null;
  verificationReceipt: RecordEnvelope | null;
  acceptanceReceipt: RecordEnvelope | null;
}

export function validateSubject(v: unknown): AuthorizationSubject {
  exact(v, ['candidate', 'candidateCommit', 'candidateTree', 'baseHead', 'baseTree', 'baseAuthorityIdentity', 'frozenTask', 'liveTask', 'subjectiveDuties']);
  for (const k of ['candidateCommit', 'candidateTree', 'baseHead', 'baseTree']) requireThat(typeof v[k] === 'string' && OID.test(v[k] as string), 'unresolved Git identity');
  requireThat(typeof v.candidate === 'string' && ID.test(v.candidate), 'invalid candidate identifier');
  requireThat(typeof v.baseAuthorityIdentity === 'string' && HEX.test(v.baseAuthorityIdentity), 'missing frozen authority');
  const frozen = canonicalTask(v.frozenTask), live = canonicalTask(v.liveTask);
  requireThat(frozen && live && frozen.kinds.length && !taskWeakening(frozen, live).length, 'invalid or weakened task authority');
  for (const t of [v.frozenTask, v.liveTask]) {
    exact(t, ['taskDigest', 'kinds', 'requirementCount', 'requirementDigests', 'subjectiveVisual', 'subjectivePerformance', 'objectiveTargets']);
    for (const target of t.objectiveTargets as unknown[]) exact(target, ['digest', 'kind']);
  }
  ids(v.subjectiveDuties);
  return { ...v, frozenTask: frozen, liveTask: live } as unknown as AuthorizationSubject;
}
function validateEnrollment(e: Enrollment): void {
  exact(e, ['subject', 'policy', 'verifierKey', 'reviewerKey', 'minimumLevel']);
  // Unconditional, not overridable by env/config/worker/claim of isolation.
  requireAuthorizationLevel(e.minimumLevel);
  validateSubject(e.subject);
  const p = e.policy;
  exact(p, ['adapterId', 'planDigest', 'environmentDigest', 'objectiveDuties', 'network', 'targetId']);
  requireThat(typeof p.adapterId === 'string' && ID.test(p.adapterId)
    && [p.planDigest, p.environmentDigest, p.targetId].every(x => typeof x === 'string' && HEX.test(x)), 'invalid execution policy identity');
  ids(p.objectiveDuties);
  requireThat(p.objectiveDuties.length > 0, 'empty objective proof plan cannot authorize promotion');
  validateNetworkAuthority(p.network);
  const keys = [e.verifierKey, e.reviewerKey].map(pem => {
    const key = crypto.createPublicKey(pem);
    requireThat(key.asymmetricKeyType === 'ed25519', 'authority requires Ed25519 keys');
    return key.export({ type: 'spki', format: 'der' }).toString('hex');
  });
  requireThat(keys[0] !== keys[1], 'review and verification require distinct enrolled keys');
}

export class LocalAuthorityBroker {
  readonly level = 'LOCAL' as const;
  readonly #store: TrustStore;
  readonly #projectId: string;
  constructor(store: TrustStore, projectId: string) {
    requireThat(HEX.test(projectId), 'broker project IDs must be controller-issued lowercase SHA-256 identities');
    this.#store = { root: store.root };
    this.#projectId = projectId;
  }
  /** Controller-only, one-time enrollment. Re-enrollment/recovery must be an
   * explicit future operator operation, not worker setup or automatic fallback. */
  enroll(enrollment: Enrollment): void {
    const copy: Enrollment = JSON.parse(authorityJson(enrollment));
    validateEnrollment(copy);
    const state: State = { schema: BROKER_SCHEMA, enrollment: copy, phase: 'enrolled', run: null, verification: null, verificationReceipt: null, acceptanceReceipt: null };
    sealRecord(this.#store, { projectId: this.#projectId, kind: 'broker-state', payload: state, canaryVersion: BROKER_SCHEMA }, 0);
  }
  #load(): { state: State; seq: number } {
    const opened = openSealed(this.#store, { projectId: this.#projectId, kind: 'broker-state' });
    requireThat(opened.status === 'valid' && opened.envelope, `broker authority unavailable: ${opened.status}`);
    const state = opened.envelope.payload as State;
    requireThat(state?.schema === BROKER_SCHEMA, 'broker state schema mismatch');
    validateEnrollment(state.enrollment);
    return { state, seq: opened.envelope.seq };
  }
  #save(state: State, seq: number): void {
    sealRecord(this.#store, { projectId: this.#projectId, kind: 'broker-state', payload: state, canaryVersion: BROKER_SCHEMA }, seq);
  }
  #start(state: State, seq: number, purpose: RunTicket['purpose']): RunTicket {
    requireThat(state.phase !== 'promotion-reserved', 'promotion pending reconciliation');
    const run: RunTicket = { runId: crypto.randomBytes(32).toString('hex'), sequence: seq + 1,
      subjectDigest: subjectDigest(state.enrollment.subject), policyDigest: hash(state.enrollment.policy), purpose };
    this.#save({ ...state, phase: 'running', run, verification: null, verificationReceipt: null, acceptanceReceipt: null }, seq);
    return run;
  }
  /** Controller starts a NEW verification window for every promotion attempt.
   * A previous green routine run or acceptance is never promoted from cache. */
  beginPromotion(liveSubject: AuthorizationSubject, targetId: string): RunTicket {
    const live = validateSubject(JSON.parse(authorityJson(liveSubject)));
    const { state, seq } = this.#load();
    requireThat(subjectDigest(live) === subjectDigest(state.enrollment.subject)
      && targetId === state.enrollment.policy.targetId, 'promotion start identity/target changed');
    return this.#start(state, seq, 'promotion');
  }
  /** Sole worker endpoint. It accepts serialized data, never callable code.
   * No generic sign, register, execute, accept-yes, promote or path RPC exists. */
  request(json: string): RunTicket | { recorded: true } {
    requireThat(typeof json === 'string' && Buffer.byteLength(json) <= 64 * 1024, 'worker request too large');
    const r = JSON.parse(json) as WorkerRequest;
    exact(r, r?.op === 'request-verification' ? ['schema', 'projectId', 'op', 'subjectDigest'] : ['schema', 'projectId', 'op', 'receipt']);
    requireThat(r.schema === BROKER_SCHEMA && r.projectId === this.#projectId, 'worker project/schema mismatch');
    const { state, seq } = this.#load();
    if (r.op === 'request-verification') {
      requireThat(r.subjectDigest === subjectDigest(state.enrollment.subject), 'worker cannot choose new authority');
      return this.#start(state, seq, 'verification');
    }
    requireThat(r.op === 'submit-verification' || r.op === 'submit-acceptance', 'worker operation not authorized');
    requireThat(state.run, 'no active verification run');
    const verification = r.op === 'submit-verification';
    const key = verification ? state.enrollment.verifierKey : state.enrollment.reviewerKey;
    const kind = verification ? 'verification-result' : 'human-acceptance';
    requireThat(verifySeal(r.receipt, key) && r.receipt.projectId === this.#projectId
      && r.receipt.kind === kind && r.receipt.seq === state.run.sequence, 'receipt issuer/domain/project/sequence mismatch');
    const body = r.receipt.payload as VerificationStatement | AcceptanceStatement;
    exact(body, verification
      ? ['runId', 'sequence', 'subjectDigest', 'policyDigest', 'purpose', 'evidenceDigest', 'clean', 'objectiveResults']
      : ['runId', 'sequence', 'subjectDigest', 'policyDigest', 'purpose', 'verificationDigest', 'duties', 'decision']);
    for (const k of ['runId', 'sequence', 'subjectDigest', 'policyDigest', 'purpose'] as const) requireThat(body[k] === state.run[k], 'receipt is stale or bound to another authority');
    if (verification) {
      requireThat(state.phase === 'running', 'verification already consumed');
      const v = body as VerificationStatement;
      requireThat(typeof v.clean === 'boolean' && HEX.test(v.evidenceDigest) && Array.isArray(v.objectiveResults), 'malformed verification');
      const results = v.objectiveResults;
      results.forEach(x => { exact(x, ['id', 'status']); requireThat(['met', 'unmet', 'unknown'].includes(x.status), 'unknown proof status'); });
      ids(results.map(x => x.id));
      requireThat(authorityJson(results.map(x => x.id).sort()) === authorityJson([...state.enrollment.policy.objectiveDuties].sort()), 'incomplete objective duty coverage');
      this.#save({ ...state, phase: 'verified', verification: v, verificationReceipt: r.receipt }, seq);
    } else {
      requireThat(state.phase === 'verified' && state.verification && this.#objectiveMet(state), 'acceptance cannot waive failed or missing objective proof');
      const a = body as AcceptanceStatement;
      ids(a.duties);
      requireThat(a.decision === 'accept' && a.verificationDigest === hash(state.verification)
        && authorityJson([...a.duties].sort()) === authorityJson([...state.enrollment.subject.subjectiveDuties].sort()), 'acceptance does not cover exact verified duties');
      this.#save({ ...state, phase: 'accepted', acceptanceReceipt: r.receipt }, seq);
    }
    return { recorded: true };
  }
  #objectiveMet(state: State): boolean {
    return !!state.verification?.clean && state.verification.objectiveResults.every(x => x.status === 'met');
  }
  /** Controller-only reservation, NOT a Git mutation or portable bearer token.
   * Promoter must read this broker state through its authenticated channel,
   * recheck immutable snapshot + live target, then CAS expectedHead -> commit.
   * Never run the existing verify/promote CLI under broker privileges. */
  reservePromotion(liveSubject: AuthorizationSubject, targetId: string): PromotionIntent {
    const live = validateSubject(JSON.parse(authorityJson(liveSubject)));
    const { state, seq } = this.#load();
    requireThat(state.run && state.run.purpose === 'promotion' && (state.phase === 'verified' || state.phase === 'accepted') && this.#objectiveMet(state), 'promotion lacks fresh objective verification');
    requireThat(!state.enrollment.subject.subjectiveDuties.length || state.phase === 'accepted', 'subjective acceptance required');
    requireThat(subjectDigest(live) === state.run.subjectDigest && targetId === state.enrollment.policy.targetId, 'promotion identity/target changed');
    const intent: PromotionIntent = { level: 'LOCAL', projectId: this.#projectId, targetId, runId: state.run.runId,
      expectedHead: live.baseHead, candidateCommit: live.candidateCommit, candidateTree: live.candidateTree,
      subjectDigest: state.run.subjectDigest, verificationDigest: hash(state.verification) };
    this.#save({ ...state, phase: 'promotion-reserved' }, seq);
    return intent;
  }
}
