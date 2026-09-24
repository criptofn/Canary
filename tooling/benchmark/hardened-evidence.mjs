/**
 * v1.5 post-audit — can a SAVED hardened transcript describe the PRESENT?
 *
 * CONFIRMED AUDIT FINDING (BLOCKER 3). `tooling/probes/v15-hardened-boundary.mjs
 * --from-saved` read the transcript an EARLIER run had left in the OS temp dir and
 * printed `HARDENED: MEASURED` / `PASS: 6` / `RESULT: PASS`, while the live store on the
 * same host reported `LOCAL` with 0/6 controls. The product's own validator was never
 * bypassed — it enforces signature, store/deployment binding, host binding, a 15-minute
 * freshness ceiling, toolchain digest, enrollment, observations and a live authenticated
 * broker heartbeat. The PROBE presented a stale file as a current verdict.
 *
 * The honest model chosen (the brief's option C.1): a saved transcript is
 * **HISTORICAL EVIDENCE, NON-AUTHORITATIVE FOR CURRENT STATE**. It is never upgraded into
 * a current measurement by anything, because every fact that would make it current is a
 * fact about the world NOW that only a live run can observe.
 *
 * This module exists so that claim is a pure, testable function rather than prose inside
 * a probe. `hardened-evidence.test.mjs` pins all five required cases.
 */

/** The product's own ceiling for a current measurement (`DEFAULT_MAX_AGE_MS`). */
export const FRESHNESS_CEILING_MS = 15 * 60 * 1000;

/**
 * Classify a saved production transcript against the present.
 *
 * `current` is ALWAYS false. This function cannot return true, by construction: that is
 * the whole point, and the test asserts it even when every other fact matches.
 *
 * @param {any} payload the recorded `canary-production-measurement/2` payload
 * @param {{now?: number, hostname?: string, storeExists?: (store: string) => boolean}} env
 * @returns {{current: false, verdict: 'HISTORICAL', recordedControlsHeld: number|null, facts: object, reasons: string[]}}
 */
export function classifySavedEvidence(payload, env = {}) {
  const now = env.now ?? Date.now();
  const hostname = env.hostname ?? '';
  const storeExists = env.storeExists ?? (() => false);
  const p = payload ?? {};

  const finishedAt = Number(p.finishedAt);
  const ageMs = Number.isFinite(finishedAt) ? now - finishedAt : Number.NaN;
  const fresh = Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= FRESHNESS_CEILING_MS;
  const hostMatches = typeof p.host === 'string' && p.host.length > 0 && p.host === hostname;
  const storePresent = typeof p.store === 'string' && p.store.length > 0 && storeExists(p.store) === true;

  const reasons = [];
  if (!Number.isFinite(ageMs)) reasons.push('the transcript records no usable timestamp, so its age is unknown');
  else if (!fresh) reasons.push(`the transcript is ${(ageMs / 60000).toFixed(1)} min old, beyond the ${FRESHNESS_CEILING_MS / 60000} min ceiling the product enforces for a current measurement`);
  if (!hostMatches) reasons.push(`the transcript was recorded on host "${p.host ?? 'unknown'}", not on this host ("${hostname}")`);
  if (!storePresent) reasons.push(`the deployment store the transcript describes is not present (${p.store ?? 'unrecorded'})`);
  // Even a transcript that is young, on this host, with its store intact is STILL not a
  // current measurement: it carries no live authenticated broker heartbeat from NOW.
  reasons.push('a saved transcript carries no live broker heartbeat for the present, which the product requires before it will call a boundary current');

  return {
    current: false,
    verdict: 'HISTORICAL',
    recordedControlsHeld: Number.isInteger(p.controlsHeld) ? p.controlsHeld : null,
    facts: { ageMs, fresh, hostMatches, storePresent, host: p.host ?? null, store: p.store ?? null },
    reasons,
  };
}
