#!/usr/bin/env node
/**
 * Test-support fixture: mint exactly ONE sealed record into the trust store
 * named on argv, then print the generation it received.
 *
 * Used by the trust-store concurrency test: several copies are started at once
 * against one store, and the generations they report must all be distinct. That
 * is only true if minting is serialized — the seq ledger is read-modify-write,
 * so two unsynchronized minters can both claim generation N and one record
 * silently replaces the other.
 *
 * Deterministic, self-cleaning (the caller owns the temp store), explicit exit
 * code — the probe/fixture convention in AGENTS.md. No inline interpreter is
 * involved anywhere.
 *
 * usage: node trust-seal-once.mjs <storeRoot> <projectId> <kind>
 *   stdout: {"seq":N,"pid":M}
 *   exit:   0 minted · 3 misuse · 1 refused (the store failed closed)
 */
import { sealRecord } from '../../../apps/cli/dist/src/trust-store.js';

const [root, projectId, kind] = process.argv.slice(2);
if (!root || !projectId || !kind) {
  console.error('usage: trust-seal-once.mjs <storeRoot> <projectId> <kind>');
  process.exit(3);
}

try {
  const env = sealRecord({ root }, { projectId, kind, payload: { by: process.pid }, canaryVersion: 'fixture' });
  console.log(JSON.stringify({ seq: env.seq, pid: process.pid }));
} catch (e) {
  console.error(`REFUSED: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
