/**
 * Canary 1.1 P0 — the TRUSTED AUTHORITY STORE (master directive §§2–8, 55).
 *
 * The problem this seam attacks: in 1.0 every authority-bearing record (plan
 * seal, acceptance, promotion state) lived inside the repo the worker edits.
 * A worker that rewrites `.canary/` rewrites both the data AND the checker's
 * memory of it. Repository-local hashes authenticate an account to itself.
 *
 * This module moves authority OUT of the repo into a per-user store outside
 * every project tree, and makes every record cryptographically sealed with an
 * Ed25519 key that never leaves the store and is never passed to a child:
 *   - the worker may READ the public key and VERIFY any record;
 *   - only `sealRecord()` (private key, this module, this process) can mint;
 *   - any record that fails verification reads as forged/stale/malformed —
 *     callers must fail closed on every status except 'valid'.
 *
 * The honest ceiling (law: never print protection you cannot enforce): the
 * CLI runs with the worker's own OS uid, so `probeTrustLevel` returns LOCAL
 * (sealed, but the same uid could still overwrite the store) — and there is
 * NO code path here that can report HARDENED. HARDENED requires a broker with
 * a different identity; until such a broker provably exists, the probe's
 * write test IS the boundary measurement, and it must keep failing before
 * that word may appear anywhere.
 *
 * (Name note: './authority.ts' is taken — that is 1.0's repo-state drift
 * module. This is the 1.1 sealed-store; the two must not be confused.)
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalJson } from '@canary-rn/hashing';

export const RECORD_SCHEMA = 'canary-authority/1';

/** Store custody levels. HARDENED is deliberately unreachable in this build
 *  (no broker exists yet) — see probeTrustLevel; it is NOT an empty option. */
export type TrustLevel = 'HARDENED' | 'LOCAL' | 'ADVISORY' | 'UNSUPPORTED';

export interface RecordEnvelope {
  schema: string;
  projectId: string;
  kind: string;
  seq: number;
  issuedAt: string;
  canaryVersion: string;
  payload: unknown;
  signature: string; // base64 ed25519 over the canonical signed section
}

/** The exact bytes the signature covers: everything except the signature. */
export function signedBytes(env: Omit<RecordEnvelope, 'signature'>): Buffer {
  return Buffer.from(canonicalJson(env), 'utf8');
}

export interface TrustStore {
  root: string;
}

/**
 * Platform conventions on the OS-reported home — never a project-relative
 * path, never an env var a repo could steer. A worker that controls the CLI's
 * whole process environment is the documented same-uid ceiling itself (it
 * could touch the real home store directly anyway); steering only ever aims
 * Canary at an EMPTY store, which fails closed, never at a forged one.
 */
export function defaultStoreRoot(home: string = os.homedir()): string {
  return process.platform === 'win32'
    ? path.join(home, 'AppData', 'Local', 'canary', 'trust')
    : path.join(home, '.local', 'share', 'canary', 'trust');
}

/**
 * The store this process uses: the OS-home default, or an explicit
 * CANARY_TRUST_STORE pointer (test/dev steering — same legitimate need the
 * one `USERPROFILE` fake-home test already serves, without touching git
 * identity). The override changes WHERE Canary looks, never WHETHER it
 * verifies: it can only ever aim at an empty or already-valid store. Aimed
 * at an empty one, every read fails closed (missing/unavailable) — records
 * are never trusted more because a pointer named them.
 */
export function storeFromEnv(env: NodeJS.ProcessEnv = process.env): TrustStore {
  const v = env.CANARY_TRUST_STORE?.trim();
  return { root: v ? path.resolve(v) : defaultStoreRoot() };
}

/** Stable, path-free project identity: a safe id derived from the resolved
 *  repo root. Two checkouts of one folder share it; renames do not forge a
 *  new record shelf out of an old one (reads still bind to the sealed bytes). */
export function projectIdForRoot(root: string): string {
  return 'p-' + crypto.createHash('sha256').update(fs.realpathSync(root)).digest('hex').slice(0, 32);
}

/** ids/kinds become path segments — only inert characters may appear. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const safeSegment = (value: string, what: string): string => {
  if (!SAFE_ID.test(value)) throw new Error(`${what} "${value}" is not a safe identifier`);
  return value;
};

const keyPath = (store: TrustStore): string => path.join(store.root, 'keys', 'ed25519');

/** Generate or load the store keypair. The private PEM never leaves the
 *  store dir and is never handed to any child process or return value. */
export function ensureStoreKey(store: TrustStore): { publicKey: string } {
  const pubPath = `${keyPath(store)}.pub`;
  const privPath = keyPath(store);
  if (fs.existsSync(pubPath) && fs.existsSync(privPath)) {
    return { publicKey: fs.readFileSync(pubPath, 'utf8') };
  }
  if (fs.existsSync(pubPath) !== fs.existsSync(privPath)) {
    // half a keypair: refusing beats "regenerate and orphan every record".
    throw new Error('trust store key material is incomplete (public and private halves must coexist)');
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.mkdirSync(path.dirname(privPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(privPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  fs.writeFileSync(pubPath, publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o644 });
  // Windows ignores mode bits (the profile ACL is the real control and the
  // probe measures what it allows); on posix re-assert after umask.
  try { fs.chmodSync(privPath, 0o600); } catch { /* best-effort; probe reports the truth */ }
  return { publicKey: fs.readFileSync(pubPath, 'utf8') };
}

function readLedger(store: TrustStore): Record<string, number> {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(store.root, 'ledger.json'), 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(raw)) if (typeof v === 'number' && Number.isSafeInteger(v)) out[k] = v;
      return out;
    }
  } catch { /* absent or unreadable ledger = no history known (reads still
                 bind to the sealed bytes; fresh seals just start at 1) */ }
  return {};
}

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file); // win32 rename replaces an existing target
}

/**
 * Mint a sealed record: strictly newer than the last seq for (project,kind),
 * signed with the store key. Any failure THROWS — callers fail closed; there
 * is no partial authority and no unsigned fallback.
 */
export function sealRecord(
  store: TrustStore,
  input: { projectId: string; kind: string; payload: unknown; canaryVersion: string },
): RecordEnvelope {
  const projectId = safeSegment(input.projectId, 'project id');
  const kind = safeSegment(input.kind, 'record kind');
  ensureStoreKey(store); // ensures both halves before signing
  const ledger = readLedger(store);
  const lane = `${projectId}/${kind}`;
  const seq = (ledger[lane] ?? 0) + 1;
  const body = {
    schema: RECORD_SCHEMA,
    projectId,
    kind,
    seq,
    issuedAt: new Date().toISOString(),
    canaryVersion: input.canaryVersion,
    payload: input.payload,
  };
  const priv = crypto.createPrivateKey(fs.readFileSync(keyPath(store), 'utf8'));
  const signature = crypto.sign(null, signedBytes(body), priv).toString('base64');
  const env: RecordEnvelope = { ...body, signature };
  writeAtomic(path.join(store.root, 'records', projectId, `${kind}.json`), JSON.stringify(env, null, 2) + '\n');
  ledger[lane] = seq;
  writeAtomic(path.join(store.root, 'ledger.json'), canonicalJson(ledger));
  return env;
}

export type OpenStatus = 'valid' | 'missing' | 'malformed' | 'forged' | 'mismatch' | 'stale' | 'unavailable';
export interface OpenResult {
  status: OpenStatus;
  envelope?: RecordEnvelope;
  reason: string; // always present; every non-'valid' status must block the caller
}

function isEnvelope(v: unknown): v is RecordEnvelope {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const e = v as Record<string, unknown>;
  return typeof e.schema === 'string' && typeof e.projectId === 'string' && typeof e.kind === 'string'
    && typeof e.seq === 'number' && Number.isSafeInteger(e.seq) && e.seq > 0
    && typeof e.issuedAt === 'string' && typeof e.canaryVersion === 'string'
    && typeof e.signature === 'string' && e.signature.length > 0
    && Object.hasOwn(e, 'payload');
}

/** Verify (never mint). Standalone so worker-side code can check records with
 *  only the public key. */
export function verifySeal(envelope: RecordEnvelope, publicKeyPem: string): boolean {
  const { signature, ...body } = envelope;
  try {
    return crypto.verify(null, signedBytes(body), crypto.createPublicKey(publicKeyPem), Buffer.from(signature, 'base64'));
  } catch { return false; }
}

/**
 * Read and verify one record for one project+kind. Every way this can fail is
 * an attack that MUST NOT pass: wrong bytes (forged), wrong shelf (mismatch —
 * a copied file re-binds nothing), replayed older record (stale vs the ledger).
 */
export function openSealed(store: TrustStore, want: { projectId: string; kind: string }): OpenResult {
  let projectId: string, kind: string;
  try { projectId = safeSegment(want.projectId, 'project id'); kind = safeSegment(want.kind, 'record kind'); }
  catch (e) { return { status: 'malformed', reason: (e as Error).message }; }
  let pub: string;
  try { pub = fs.readFileSync(`${keyPath(store)}.pub`, 'utf8'); }
  catch { return { status: 'unavailable', reason: 'the trust store has no verification key — nothing can be certified from it' }; }
  const file = path.join(store.root, 'records', projectId, `${kind}.json`);
  let env: unknown;
  try { env = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT'
      ? { status: 'missing', reason: `no sealed ${kind} record for project ${projectId}` }
      : { status: 'malformed', reason: `the sealed ${kind} record cannot be parsed` };
  }
  if (!isEnvelope(env)) return { status: 'malformed', reason: `the sealed ${kind} record has an unexpected shape` };
  if (env.schema !== RECORD_SCHEMA) return { status: 'malformed', reason: `record schema "${env.schema}" is not this build's ${RECORD_SCHEMA}` };
  if (!verifySeal(env, pub)) return { status: 'forged', reason: `the ${kind} record's signature does not match this store's key` };
  if (env.projectId !== projectId || env.kind !== kind) {
    return { status: 'mismatch', reason: `a record for ${env.projectId}/${env.kind} was found on the ${projectId}/${kind} shelf — a moved file re-binds nothing` };
  }
  const laneSeq = readLedger(store)[`${projectId}/${kind}`];
  if (typeof laneSeq === 'number' && env.seq < laneSeq) {
    return { status: 'stale', reason: `the ${kind} record is seq ${env.seq} but the store has already issued ${laneSeq}` };
  }
  return { status: 'valid', envelope: env, reason: 'valid' };
}

/**
 * Measure the boundary — never infer it. The CLI shares its uid with the
 * worker, so a successful store write PROVES the worker could write it too
 * (that is LOCAL, named plainly). Write failure is the only observation that
 * could ever precede a stronger word, and this build has no broker to make
 * one, so failure here can only report UNSUPPORTED.
 */
export function probeTrustLevel(store: TrustStore): { level: TrustLevel; reasons: string[] } {
  const probeFile = path.join(store.root, '.write-probe');
  try {
    fs.mkdirSync(store.root, { recursive: true });
    fs.writeFileSync(probeFile, String(process.pid));
    const back = fs.readFileSync(probeFile, 'utf8');
    fs.unlinkSync(probeFile);
    if (back !== String(process.pid)) return { level: 'UNSUPPORTED', reasons: ['the trust store write probe did not read back — authority cannot live here'] };
  } catch {
    return { level: 'UNSUPPORTED', reasons: [`the trust store at ${store.root} is not writable by this process — authority-changing operations fail closed here`] };
  }
  return {
    level: 'LOCAL',
    reasons: [
      'records are sealed outside the repo with an Ed25519 key this store owns',
      'the same uid that runs the worker can also write this store — sealing detects, it does not prevent; HARDENED requires a broker with a different identity and is NOT claimed',
    ],
  };
}
