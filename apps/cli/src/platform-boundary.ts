/** Platform contracts. These types are NOT an installed sandbox or attestation.
 * Implement providers outside the broker's dependency graph. Never satisfy a
 * contract by executing a candidate with the broker/supervisor signing identity. */
import type { RecordEnvelope } from './authority-envelope.js';
import type { PromotionIntent, RunTicket } from './broker.js';

export type CapabilityLevel = 'HARDENED' | 'LOCAL' | 'ADVISORY';
export type BoundaryControl = 'authorityCustody' | 'workerFilesystem' | 'verificationSandbox'
  | 'authenticatedReview' | 'protectedPromotion' | 'networkEgress';
export interface CapabilityReport {
  level: CapabilityLevel;
  unavailable: BoundaryControl[];
}
/** Current installation has no protected provider. Requesting HARDENED must
 * fail; neither a signed receipt nor a successful test can elevate this fact. */
export function localCapabilities(authorityAvailable: boolean): CapabilityReport {
  return { level: authorityAvailable ? 'LOCAL' : 'ADVISORY', unavailable: [
    'authorityCustody', 'workerFilesystem', 'verificationSandbox',
    'authenticatedReview', 'protectedPromotion', 'networkEgress',
  ] };
}
export function requireAuthorizationLevel(level: unknown): void {
  if (level !== 'LOCAL') throw new Error('HARDENED unavailable: no installed protected broker/supervisor/promoter; ADVISORY cannot authorize');
}

export interface NetworkAuthority { mode: 'deny' | 'allowlist'; origins: string[] }
/** Approval covers exact HTTPS origins. The provider must ALSO prevent DNS
 * rebinding, redirects, raw-IP/proxy/IPv6/UDP bypass and internal destinations.
 * An allowlist string is policy, never evidence of egress containment. */
export function validateNetworkAuthority(value: unknown): asserts value is NetworkAuthority {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid network policy');
  const n = value as NetworkAuthority;
  if (Object.keys(n).sort().join(',') !== 'mode,origins' || !Array.isArray(n.origins) || n.origins.length > 64
    || new Set(n.origins).size !== n.origins.length
    || !(n.mode === 'deny' ? n.origins.length === 0 : n.mode === 'allowlist' && n.origins.length > 0)) throw new Error('ambiguous network policy');
  for (const origin of n.origins) {
    if (typeof origin !== 'string') throw new Error('invalid network origin');
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) throw new Error('network grants require exact HTTPS origins');
  }
}

/** Issued by the trusted supervisor AFTER fetching current broker authority.
 * A worker-delivered object with these fields is NOT sufficient authorization.
 * All handles are supervisor-owned IDs, never worker-provided host paths. */
export interface VerificationJob {
  schema: 'canary-verification-job/1';
  projectId: string;
  ticket: RunTicket;
  snapshot: { commit: string; tree: string; handle: string };
  planHandle: string;
  environmentHandle: string;
  network: NetworkAuthority;
}
export interface UntrustedRunObservation {
  jobId: string;
  exitCode: number | null;
  timedOut: boolean;
  stdoutArtifact: string;
  stderrArtifact: string;
  // This is DATA. There is deliberately no PASS/accepted/promoted field.
}
/** Supervisor-owned provider: launch under a separate restricted identity;
 * read-only verified source; private writable scratch; no broker store/keys,
 * base Git store, sockets, host home, credentials or writable shared cache.
 * Kill/reap descendants before final measurement; refuse unavailable controls.
 * Provider returns untrusted observations. Only supervisor constructs proof. */
export interface VerificationSandbox {
  run(job: VerificationJob): Promise<UntrustedRunObservation>;
}
/** Supervisor signs after authoritative checks/coverage and snapshot identity
 * checks. It never loads project plugins or runs code under its signing UID. */
export interface VerificationSupervisor {
  verify(job: VerificationJob): Promise<RecordEnvelope>;
}
/** No candidate code, Git hooks, filters, fsmonitor or project-selected binaries
 * in this identity. Authenticate the broker, resolve targetId in protected
 * enrollment, independently check ancestry+tree and live old HEAD, then CAS.
 * Never accept an intent received from a worker as a bearer authorization. */
export interface ProtectedPromoter {
  reconcile(projectId: string): Promise<'applied' | 'not-applied' | 'blocked'>;
  apply(intent: PromotionIntent): Promise<'applied' | 'blocked'>;
}
