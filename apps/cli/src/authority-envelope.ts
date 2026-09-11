/** Public verification only: no filesystem, private key or execution capability.
 * Signatures establish issuer/integrity, NOT freshness or human identity. */
import crypto from 'node:crypto';

export const RECORD_SCHEMA = 'canary-authority/1';
export interface RecordEnvelope {
  schema: string; projectId: string; kind: string; seq: number;
  issuedAt: string; canaryVersion: string; payload: unknown; signature: string;
}

/** Bind every JSON key, including __proto__. Reject lossy JS inputs. */
export function authorityJson(value: unknown): string {
  const visit = (v: unknown, depth: number): unknown => {
    if (depth > 32) throw new Error('authority JSON exceeds depth limit');
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (!v || typeof v !== 'object') throw new Error('authority requires lossless JSON');
    const out: Record<string, unknown> = Object.create(null);
    for (const k of Reflect.ownKeys(v)) {
      if (Array.isArray(v) && k === 'length') continue;
      if (typeof k !== 'string') throw new Error('authority requires JSON keys');
      const d = Object.getOwnPropertyDescriptor(v, k)!;
      if (!d.enumerable || !('value' in d)) throw new Error('authority refuses hidden fields and accessors');
    }
    if (Array.isArray(v)) {
      if (Object.keys(v).length !== v.length || Object.keys(v).some((k, i) => k !== String(i))) throw new Error('authority requires dense JSON arrays');
      return Array.from(v, x => visit(x, depth + 1));
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(v))) throw new Error('authority requires plain JSON objects');
    for (const k of Object.keys(v).sort()) out[k] = visit((v as Record<string, unknown>)[k], depth + 1);
    return out;
  };
  const text = JSON.stringify(visit(value, 0));
  if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('authority JSON exceeds size limit');
  return text;
}
export function signedBytes(env: Omit<RecordEnvelope, 'signature'>): Buffer {
  return Buffer.from(authorityJson(env), 'utf8');
}
export function isEnvelope(v: unknown): v is RecordEnvelope {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const e = v as Record<string, unknown>;
  return Object.keys(e).sort().join(',') === 'canaryVersion,issuedAt,kind,payload,projectId,schema,seq,signature'
    && e.schema === RECORD_SCHEMA && typeof e.projectId === 'string' && typeof e.kind === 'string'
    && typeof e.seq === 'number' && Number.isSafeInteger(e.seq) && e.seq > 0
    && typeof e.issuedAt === 'string' && typeof e.canaryVersion === 'string'
    && typeof e.signature === 'string' && /^[A-Za-z0-9+/]{86}==$/.test(e.signature);
}
export function verifySeal(envelope: RecordEnvelope, publicKeyPem: string): boolean {
  try {
    if (!isEnvelope(envelope)) return false;
    const key = crypto.createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== 'ed25519') return false;
    const { signature, ...body } = envelope;
    return crypto.verify(null, signedBytes(body), key, Buffer.from(signature, 'base64'));
  } catch { return false; }
}
