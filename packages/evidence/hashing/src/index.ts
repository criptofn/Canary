import { createHash } from 'node:crypto';
import fs from 'node:fs';

export function sha256hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function sha256File(path: string): string {
  return sha256hex(fs.readFileSync(path));
}

/**
 * Canonical JSON for hashing: stable key order, no incidental whitespace.
 * Every artifact hash in an Evidence Bundle is computed over this form, so
 * bundles can be re-verified byte-for-byte by an independent re-serializer.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortDeep((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

export function hashObject(value: unknown): string {
  return sha256hex(canonicalJson(value));
}
