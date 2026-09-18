/** Retired schema-1 harness diagnostics. No record accepted by these legacy
 * parsing/signature helpers can activate HARDENED. Production authority is
 * provider/production-measurement.ts: protected Ed25519 producer, deployment
 * bindings, raw executed observations and a live signed broker challenge. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { BoundaryControl } from '../platform-boundary.js';

/** Where a valid measurement lives, relative to the protected store root. */
export const CONFINED_RECORD_NAME = 'confined-caller-measurement.json';
export const CONFINED_RECORD_SCHEMA = 'canary-confined-measurement/1';
/** The only producer whose records this build validates. */
export const CONFINED_RECORD_SOURCE = 'tooling/probes/v12-confined-caller.mjs';

/** The six controls, in the order every report lists them. */
export const ALL_CONTROLS: readonly BoundaryControl[] = [
  'authorityCustody', 'workerFilesystem', 'verificationSandbox',
  'authenticatedReview', 'protectedPromotion', 'networkEgress',
] as const;

/**
 * How long a measurement stays usable. A day is a judgement, not a measurement,
 * and it is deliberately short: a boundary that must still hold tomorrow must be
 * measured tomorrow. The number is exported so the probe and the docs quote the
 * same one.
 */
export const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The deployment facts that MUST be observed true. Listed here so the validator
 * re-derives the deployment verdict from the facts rather than trusting the
 * record's own `complete` flag — a signed record can still be a record of a
 * deployment that did not confine the caller.
 */
export const REQUIRED_DEPLOYMENT_FACTS: readonly string[] = [
  'brokerOwnsKeyMaterial',
  'brokerNeverRunsCallerWork',
  'promotionPerformedByBroker',
  'callerConfinementMeasured',
  'brokerIdentityReported',
] as const;

/**
 * The boundary tools a record is bound to. Every file here is part of the
 * deployment: the launcher that creates the confined token, the broker that owns
 * review custody and promotion, the relay the launcher is driven through, and the
 * untrusted caller fixture whose attacks were measured.
 */
export const CONFINED_TOOL_PATHS: readonly string[] = [
  'tools/windows-boundary/CanaryConfinedLauncher.cs',
  'tools/windows-boundary/CanaryBroker.cs',
  'tools/windows-boundary/confined-relay.ps1',
  'tools/windows-boundary/confined-cli.ps1',
  'tooling/test-support/fixtures/confined-caller.cjs',
  'tooling/test-support/fixtures/confined-listener.cjs',
  'tooling/probes/v12-confined-caller.mjs',
] as const;

/**
 * The repository root, found by walking up from this file until a directory holds
 * both `package.json` and `.git`. A FIXED number of `..` hops would be wrong for
 * one of this module's two load sites (the compiled provider and the compiled
 * test both import it), and silently wrong is how a digest check stops meaning
 * anything.
 */
function repoRootFromModule(): string {
  let dir = import.meta.dirname;
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(import.meta.dirname, '..', '..', '..', '..');
}

/**
 * The digest of a toolchain, or `null` when any named file is missing. A `null`
 * digest can never match a record, which is the point: an absent tool is not a
 * weaker deployment, it is an unmeasurable one.
 */
export function toolsDigest(repoRoot: string = repoRootFromModule()): string | null {
  const h = crypto.createHash('sha256');
  for (const relative of CONFINED_TOOL_PATHS) {
    const abs = path.join(repoRoot, relative);
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(abs);
    } catch {
      return null;
    }
    h.update(relative, 'utf8');
    h.update('\u0000', 'utf8');
    h.update(bytes);
    h.update('\u0000', 'utf8');
  }
  return h.digest('hex');
}

// ─────────────────────────────────────────────────────────────────────────────
// The record's shape
// ─────────────────────────────────────────────────────────────────────────────

/** What one control's measurement consists of, stated as data. */
export interface ConfinedControlObservation {
  control: BoundaryControl;
  /** What the observation is OF, e.g. `read of the trusted store under the confined token`. */
  subject: string;
  /** The unrestricted control case: the same act, without the boundary. */
  positiveControl: string;
  /** The real restricted attack: the same act, from inside the boundary. */
  attack: string;
  /** The mechanism the kernel or the broker used to refuse, named. */
  denial: string;
  /** The boundary facts observed by the trusted side for THIS control's arm. */
  observed: Record<string, string | number | boolean | null>;
  available: boolean;
}

/**
 * The trusted facts a deployment must have OBSERVED before a record is usable.
 *
 * `required` is the gate: every entry must be `true`, because a deployment in
 * which the broker does not own the key material, does not perform promotion, or
 * did not confine the caller is not a deployment of this boundary at all.
 *
 * The remaining fields are REPORTED, not gated. They are how the record states
 * its own limits — on this implementation the broker runs as the NORMAL USER
 * identity, so `separateBrokerIdentity` is `false` and `brokerAccountIsCaller` is
 * `true`. Recording that beside the controls is the difference between a measured
 * boundary and an implied privilege separation.
 */
export interface ConfinedDeploymentFacts {
  required: {
    brokerOwnsKeyMaterial: boolean;
    brokerNeverRunsCallerWork: boolean;
    promotionPerformedByBroker: boolean;
    callerConfinementMeasured: boolean;
    brokerIdentityReported: boolean;
  };
  separateBrokerIdentity: boolean;
  brokerIdentity: string;
  brokerAccountIsCaller: boolean;
  brokerName: string;
  callerIdentity: string;
  callerName: string;
}

/** One artifact digest of the corpus the boundary was measured against. */
export interface ConfinedCorpusDigest {
  corpus: string;
  digest: string;
  files: number;
}

export interface ConfinedMeasurementRecord {
  schema: typeof CONFINED_RECORD_SCHEMA;
  /** Where this record came from, and what it is not. */
  source: 'tooling/probes/v12-confined-caller.mjs';
  measuredAt: string;
  platform: string;
  host: { hostname: string; user: string };
  storeRoot: string;
  callerPackage: string;
  /** The broker's OWN reported identity, measured rather than assumed. */
  broker: { identity: string; name: string; isSystem: boolean };
  /** Bound to the tools on disk at measurement time. */
  tools: { digest: string; files: string[] };
  /** The corpus of candidate bytes the battery was run against. */
  corpus: ConfinedCorpusDigest;
  /** The battery's own count of controls and attacks, so a report can quote it. */
  battery: { pass: number; fail: number; inconclusive: number; durationMs: number };
  /** Fail-closed verdict of the deployment itself. */
  deployment: { complete: boolean; failures: string[]; facts: ConfinedDeploymentFacts };
  /** One entry per control; `available` is derived from the evidence below it. */
  controls: ConfinedControlObservation[];
  /** HMAC-SHA256 of the canonical payload under the store's custody key. */
  signature: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Building a record (used by the battery)
// ─────────────────────────────────────────────────────────────────────────────

/** The exact bytes a signature covers: the record with `signature` emptied. */
export function canonicalPayload(record: ConfinedMeasurementRecord): string {
  return JSON.stringify({ ...record, signature: '' });
}

/** HMAC-SHA256 in the broker's own format (lowercase hex). */
export function recordSignature(record: ConfinedMeasurementRecord, keyMaterial: string): string {
  return crypto.createHmac('sha256', keyMaterial).update(canonicalPayload(record), 'utf8').digest('hex');
}

export interface ConfinedFactsInput {
  control: BoundaryControl;
  subject: string;
  /** The unrestricted positive control, in words. */
  positiveControl: string;
  /** The attack from inside the boundary, in words. */
  attack: string;
  /** What the trusted side observed, as fields. */
  observed: Record<string, string | number | boolean | null>;
  /** The denial the boundary produced, when it did. */
  denial: string | null;
}

/**
 * Derive ONE control from its evidence. Every way of lacking evidence lands on
 * `available: false`:
 *   - no positive control recorded  -> the observation never proved the act is
 *     possible without the boundary, so a denial proves nothing;
 *   - no attack recorded            -> nothing was attempted;
 *   - no denial named               -> the attack was not refused;
 *   - the `observed` map is empty   -> there is no fact to rest the control on;
 *   - any observation recorded `null` or `undefined` -> the fact is ABSENT.
 *
 * `false` and `0` are NOT absences. "the confined caller did not inherit the
 * broker key" (`false`) and "zero capabilities" (`0`) are exactly the
 * measurements this boundary consists of; treating a negative measurement as a
 * missing one would make the controls unsatisfiable and would be the opposite
 * error from overclaiming.
 */
export function deriveControl(input: ConfinedFactsInput): ConfinedControlObservation {
  const missing: string[] = [];
  if (input.positiveControl.trim() === '') missing.push('no unrestricted positive control was recorded');
  if (input.attack.trim() === '') missing.push('no restricted attack was recorded');
  if (input.denial === null || input.denial.trim() === '') missing.push('no denial mechanism was observed');
  const observed = Object.entries(input.observed);
  if (observed.length === 0) missing.push('no observation was recorded for this control');
  for (const [key, value] of observed) {
    if (value === null || value === undefined) missing.push(`observation "${key}" is absent`);
  }
  return {
    control: input.control,
    subject: input.subject,
    positiveControl: input.positiveControl,
    attack: input.attack,
    denial: input.denial ?? '',
    observed: input.observed,
    available: missing.length === 0,
  };
}

/** Write a record, signed with the store's custody key material. */
export function writeConfinedMeasurement(
  record: Omit<ConfinedMeasurementRecord, 'signature'>,
  storeRoot: string,
): string {
  const key = readCustodyKey(storeRoot);
  if (key === null) throw new Error(`no custody key material in ${storeRoot}: a measurement cannot be signed`);
  const signed: ConfinedMeasurementRecord = { ...record, signature: recordSignature(record as ConfinedMeasurementRecord, key) };
  fs.mkdirSync(storeRoot, { recursive: true });
  const target = recordPath(storeRoot);
  fs.writeFileSync(target, JSON.stringify(signed, null, 2) + '\n', { encoding: 'utf8' });
  return target;
}

/**
 * Fill in the six controls from the battery's own observations, one entry per
 * control. Callers supply exactly the evidence they measured; a control that is
 * missing from the list is recorded as absent, which makes it unavailable.
 */
export function completeControls(entries: readonly ConfinedFactsInput[]): ConfinedControlObservation[] {
  const byName = new Map<BoundaryControl, ConfinedFactsInput>();
  for (const entry of entries) byName.set(entry.control, entry);
  return ALL_CONTROLS.map((name) => {
    const entry = byName.get(name);
    return entry === undefined
      ? { control: name, subject: '', positiveControl: '', attack: '', denial: '', observed: {}, available: false }
      : deriveControl(entry);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading and validating a record
// ─────────────────────────────────────────────────────────────────────────────

/** The broker's own custody key, as read from the trusted store. */
export function readCustodyKey(storeRoot: string): string | null {
  try {
    const key = fs.readFileSync(path.join(storeRoot, 'custody-key-material.txt'), 'utf8').trim();
    return key === '' ? null : key;
  } catch {
    return null;
  }
}

export interface RecordState {
  /** True only when every check below passed. */
  valid: boolean;
  /** The check that refused it, in the order the docblock lists them. */
  reason: string;
  measuredAt: string | null;
  ageMs: number | null;
  callerPackage: string | null;
  toolsDigest: string | null;
  deploymentComplete: boolean | null;
  /** Why the deployment itself failed closed, when it did. Never empty on failure. */
  deploymentFailures: string[];
  signatureVerified: boolean;
  hostname: string;
  recordPath: string;
  /** Present only when the file parsed as a record of the expected schema. */
  record: ConfinedMeasurementRecord | null;
  /** One entry per control, always all six, so a report never omits one. */
  controls: Record<BoundaryControl, { available: boolean; why: string }>;
}

const refuse = (reason: string): { available: boolean; why: string } => ({ available: false, why: reason });

/** All six controls unavailable for one reason. */
function allUnavailable(reason: string): Record<BoundaryControl, { available: boolean; why: string }> {
  return Object.fromEntries(ALL_CONTROLS.map((c) => [c, refuse(reason)])) as Record<BoundaryControl, { available: boolean; why: string }>;
}

export function recordPath(storeRoot: string): string {
  return path.join(storeRoot, CONFINED_RECORD_NAME);
}

/**
 * Validate the measurement record for this host and store. Never throws: every
 * failure is a closed state with a reason.
 */
export function readConfinedMeasurement(
  storeRoot: string,
  options: { maxAgeMs?: number; now?: number; hostname?: string; digest?: string | null } = {},
): RecordState {
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const now = options.now ?? Date.now();
  const hostname = options.hostname ?? os.hostname();
  const expectedDigest = options.digest === undefined ? toolsDigest() : options.digest;
  const file = recordPath(storeRoot);
  const state = (fields: Partial<RecordState> & { reason: string }): RecordState => ({
    valid: false, measuredAt: null, ageMs: null, callerPackage: null, toolsDigest: expectedDigest,
    deploymentComplete: null, deploymentFailures: [], signatureVerified: false, hostname, recordPath: file, record: null,
    ...fields,
    controls: fields.controls ?? allUnavailable(fields.reason),
  });

  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return state({ reason: `no confined-caller deployment has been measured in this store (expected ${file})` });
  }
  let record: ConfinedMeasurementRecord;
  try {
    record = JSON.parse(text) as ConfinedMeasurementRecord;
  } catch {
    return state({ reason: `the measurement record at ${file} is not valid JSON` });
  }
  if (record === null || typeof record !== 'object' || record.schema !== CONFINED_RECORD_SCHEMA) {
    return state({ reason: `the measurement record at ${file} does not declare schema ${CONFINED_RECORD_SCHEMA}` });
  }
  if (record.source !== CONFINED_RECORD_SOURCE) {
    return state({ reason: `the measurement record names source ${JSON.stringify(record.source)}; this build validates ${CONFINED_RECORD_SOURCE}` });
  }
  if (record.platform !== process.platform) {
    return state({ reason: `the measurement was taken on ${JSON.stringify(record.platform)}, not ${process.platform}` });
  }
  if (typeof record.measuredAt !== 'string' || typeof record.signature !== 'string' ||
      typeof record.storeRoot !== 'string' || typeof record.callerPackage !== 'string' ||
      !Array.isArray(record.controls) || record.controls.some(c => !c || typeof c !== 'object' ||
        typeof c.control !== 'string' || typeof c.subject !== 'string' ||
        typeof c.positiveControl !== 'string' || typeof c.attack !== 'string' ||
        typeof c.denial !== 'string' || !c.observed || typeof c.observed !== 'object' || Array.isArray(c.observed))) {
    return state({ reason: 'malformed measurement fields' });
  }
  const carried: Partial<RecordState> = {
    record,
    measuredAt: record.measuredAt ?? null,
    callerPackage: record.callerPackage ?? null,
    toolsDigest: record.tools?.digest ?? null,
    deploymentComplete: record.deployment?.complete ?? null,
    deploymentFailures: record.deployment?.failures ?? [],
  };

  const measuredAtMs = Date.parse(record.measuredAt ?? '');
  if (!Number.isFinite(measuredAtMs)) {
    return state({ ...carried, reason: `the measurement record carries no readable measuredAt (${JSON.stringify(record.measuredAt)})` });
  }
  const ageMs = now - measuredAtMs;
  if (!Number.isFinite(now) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0 || maxAgeMs > DEFAULT_MAX_AGE_MS || ageMs < -5000) {
    return state({ ...carried, ageMs, reason: 'invalid freshness limit or future-dated measurement' });
  }
  if (!record.battery || !Number.isSafeInteger(record.battery.pass) || record.battery.pass <= 0 ||
      record.battery.fail !== 0 || record.battery.inconclusive !== 0 ||
      !Number.isFinite(record.battery.durationMs) || record.battery.durationMs <= 0 ||
      !Array.isArray(record.deployment?.failures) || record.deployment.failures.length !== 0) {
    return state({ ...carried, ageMs, reason: 'battery evidence is empty, failed, inconclusive, or malformed' });
  }
  if (Number.isFinite(maxAgeMs) && maxAgeMs >= 0 && ageMs > maxAgeMs) {
    const hours = (ageMs / 3_600_000).toFixed(1);
    const limit = (maxAgeMs / 3_600_000).toFixed(1);
    return state({ ...carried, ageMs, reason: `the measurement is ${hours} h old (limit ${limit} h): re-run node tooling/probes/v12-confined-caller.mjs` });
  }
  if ((record.host?.hostname ?? '') !== hostname || record.host?.user !== os.userInfo().username) {
    return state({ ...carried, ageMs, reason: `the measurement host/user does not match the current host/user (${hostname})` });
  }
  if (path.resolve(record.storeRoot ?? '') !== path.resolve(storeRoot)) {
    return state({ ...carried, ageMs, reason: `the measurement names a different protected store (${record.storeRoot ?? 'none'})` });
  }
  // The toolchain check: a record must not outlive the deployment it measured.
  if (expectedDigest === null) {
    return state({ ...carried, ageMs, reason: 'the boundary tools are not all present, so no measurement can be bound to this deployment' });
  }
  if ((record.tools?.digest ?? '') !== expectedDigest) {
    return state({ ...carried, ageMs, reason: 'the boundary tools have changed since this deployment was measured, so the measurement does not describe them' });
  }
  const key = readCustodyKey(storeRoot);
  if (key === null) {
    return state({ ...carried, ageMs, reason: `no custody key material in ${storeRoot}, so the measurement cannot be authenticated` });
  }
  const expectedSignature = recordSignature(record, key);
  const given = record.signature ?? '';
  const givenBytes = Buffer.from(given, 'utf8');
  const expectedBytes = Buffer.from(expectedSignature, 'utf8');
  const verified = givenBytes.length === expectedBytes.length && crypto.timingSafeEqual(givenBytes, expectedBytes);
  if (!verified) {
    return state({ ...carried, ageMs, reason: 'the measurement signature is not this store\'s broker custody, so the record was not produced by the trusted side' });
  }

  const controls = controlsFromRecord(record);
  // The deployment verdict is re-derived from the FACTS, not read from the
  // `complete` boolean: a record may be signed and carry a `complete: true` flag,
  // and still report a required fact as unobserved. The facts win.
  const facts = record.deployment?.facts;
  const required = (facts?.required ?? {}) as Record<string, unknown>;
  const unobservedFacts = REQUIRED_DEPLOYMENT_FACTS.filter((name) => required[name] !== true);
  if (unobservedFacts.length > 0) {
    const reason = `the deployment did not observe ${unobservedFacts.length} required fact(s): ${unobservedFacts.join(', ')}`;
    return { ...state({ ...carried, ageMs, signatureVerified: true, reason }), controls };
  }
  if (record.deployment?.complete !== true) {
    const failures = record.deployment?.failures ?? [];
    const reason = failures.length > 0
      ? `the deployment failed closed: ${failures.join('; ')}`
      : 'the measurement does not declare the deployment complete';
    return { ...state({ ...carried, ageMs, signatureVerified: true, reason }), controls };
  }
  const unavailable = ALL_CONTROLS.filter((c) => controls[c].available === false);
  if (unavailable.length > 0) {
    const reason = `${unavailable.length} control(s) have no complete observation: ${unavailable.join(', ')}`;
    return { ...state({ ...carried, ageMs, signatureVerified: true, reason }), controls };
  }
  // Schema 1 was produced by a disposable harness with a disclosed HMAC key.
  // It contains no protected production enrollment or product-path verification.
  // Even a structurally repaired/re-signed record cannot establish that authority.
  // A successor requires a production producer and a new custody trust anchor;
  // adding a caller-authored "production: true" field must never reopen this gate.
  return state({ ...carried, ageMs, signatureVerified: true,
    reason: 'schema 1 is experimental harness evidence, not authenticated production enrollment; HARDENED cannot be established from it' });
}

/**
 * A DENIAL THIS CONTROL PRODUCES, stated as a fact about the payload rather than
 * as prose. Each rule is intentionally narrow: it fires ONLY on the one shape the
 * boundary was measured to produce, and a payload that carries any other shape is
 * left to the completeness check, never silently credited.
 */
interface Rule {
  control: BoundaryControl;
  because: string;
  contradicts: (observed: Record<string, unknown>) => boolean;
}
const is = (v: unknown, expected: unknown): boolean => v !== undefined && v !== expected;
const either = (v: unknown, a: unknown, b: unknown): boolean => v !== undefined && v !== a && v !== b;

/**
 * The value check. A record can be complete, fresh and correctly signed and still
 * contain a measurement that DENIES the control — "the confined caller connected",
 * "the identity check passed", "the broker applied the caller's bytes". Presence is
 * not enough: the payload is read.
 */
export const CONTRADICTION_RULES: readonly Rule[] = [
  {
    control: 'authorityCustody',
    because: 'the payload shows the confined caller reading or writing the trusted store, or the broker reading it with the caller\'s access',
    contradicts: (o) => either(o.confinedRead, 'EPERM', 'EACCES') || either(o.confinedWrite, 'EPERM', 'EACCES')
      || (o.junctionReadExit !== undefined && o.junctionReadExit !== 9)
      || (o.brokerImpersonatedStatus !== undefined && o.brokerImpersonatedStatus !== 403)
      || o.hasBrokerKeyInConfinedCaller === true,
  },
  {
    control: 'workerFilesystem',
    because: 'the measured caller token is not the confined one: appContainer/restricted/zero-capabilities/low-integrity must all hold, and the caller must still do its own work',
    contradicts: (o) => o.appContainer === false || o.restricted === false
      || (o.capabilities !== undefined && o.capabilities !== 0)
      || o.networkCapability === true
      || (o.integrity !== undefined && o.integrity !== 'S-1-16-4096')
      || is(o.workWrite, 'ALLOWED') || is(o.workRead, 'ALLOWED'),
  },
  {
    control: 'verificationSandbox',
    because: 'the payload shows a descendant escaping the boundary, or the confinement not having been measured before the caller ran',
    contradicts: (o) => o.descendantEscaped === true || o.confinedProcessCeased === false
      || o.launcherMeasuredBoundary === false || o.failClosedBeforeResume === false,
  },
  {
    control: 'authenticatedReview',
    because: 'the payload shows the broker ACCEPTING an identity that is not the confined one, or refusing the confined one',
    contradicts: (o) => (o.unrestrictedClaimStatus !== undefined && o.unrestrictedClaimStatus === 200)
      || o.unrestrictedIdentityOk === true
      || (o.impersonatedReadStatus !== undefined && o.impersonatedReadStatus !== 403)
      || o.packageMatchesClaim === false,
  },
  {
    control: 'protectedPromotion',
    because: 'the payload shows a forged or mismatched proposal accepted, or something other than the broker applying the bytes',
    contradicts: (o) => o.forgedAccepted === true || o.mismatchAccepted === true
      || (o.validAccepted !== undefined && o.validAccepted !== true)
      || (o.appliedBy !== undefined && o.appliedBy !== 'broker')
      || o.promotedMatchesReviewedBody === false,
  },
  {
    control: 'networkEgress',
    because: 'the payload shows the confined caller reaching the listener (or the listener being contacted)',
    contradicts: (o) => o.confinedEgress === 'CONNECTED' || o.listenerContactedByConfined === true,
  },
];

/** Per-control availability and reason, derived ONLY from the record's evidence. */
export function controlsFromRecord(record: ConfinedMeasurementRecord): Record<BoundaryControl, { available: boolean; why: string }> {
  if (!Array.isArray(record.controls) || record.controls.length !== ALL_CONTROLS.length ||
      new Set(record.controls.map(c => c?.control)).size !== ALL_CONTROLS.length) {
    return allUnavailable('exactly one observation for each required control is necessary');
  }
  const seen = new Map<BoundaryControl, ConfinedControlObservation>();
  for (const entry of record.controls ?? []) if (entry !== null && typeof entry === 'object') seen.set(entry.control, entry);
  return Object.fromEntries(ALL_CONTROLS.map((name) => {
    const entry = seen.get(name);
    if (entry === undefined) return [name, refuse(`the measurement has no observation for ${name}`)];
    const observed = (entry.observed ?? {}) as Record<string, unknown>;
    const requiredFields: Record<BoundaryControl, readonly string[]> = {
      authorityCustody: ['confinedRead', 'confinedWrite', 'junctionReadExit', 'brokerImpersonatedStatus', 'hasBrokerKeyInConfinedCaller'],
      workerFilesystem: ['appContainer', 'restricted', 'capabilities', 'networkCapability', 'integrity', 'workWrite', 'workRead'],
      verificationSandbox: ['descendantExit', 'descendantEscaped', 'confinedProcessCeased', 'launcherMeasuredBoundary', 'failClosedBeforeResume'],
      authenticatedReview: ['unrestrictedClaimStatus', 'unrestrictedIdentityOk', 'impersonatedReadStatus', 'packageMatchesClaim'],
      protectedPromotion: ['forgedAccepted', 'mismatchAccepted', 'validAccepted', 'appliedBy', 'promotedMatchesReviewedBody'],
      networkEgress: ['controlEgress', 'confinedEgress', 'listenerControlConnections', 'listenerConfinedConnections', 'attackExecuted', 'capabilities'],
    };
    if (requiredFields[name].some(key => observed[key] === undefined || observed[key] === null)) {
      return [name, refuse(`${name} is missing required raw observations`)];
    }
    if (name === 'networkEgress' && (observed.controlEgress !== 'CONNECTED' ||
        !['EACCES', 'EPERM'].includes(String(observed.confinedEgress)) ||
        observed.listenerControlConnections !== 1 || observed.listenerConfinedConnections !== 0 ||
        observed.attackExecuted !== true || observed.capabilities !== 0)) {
      return [name, refuse('egress requires independently observed connections and an executed policy denial; timeout is inconclusive')];
    }
    const rederived = deriveControl({
      control: name, subject: entry.subject ?? '', positiveControl: entry.positiveControl ?? '',
      attack: entry.attack ?? '', observed: entry.observed ?? {}, denial: entry.denial ?? null,
    });
    if (entry.available !== true) {
      // Re-derive, so a record that says "available" without its evidence cannot
      // be believed: the evidence is the authority, not the boolean.
      if (!rederived.available) return [name, refuse(`${name} has no complete observation: ${entry.attack || entry.subject}, denial ${entry.denial || 'unrecorded'}`)];
      return [name, refuse(`${name} is reported unavailable by the measurement`)];
    }
    if (!rederived.available) return [name, refuse(`${name} was claimed available but its own evidence is incomplete`)];
    // The VALUES are read, not just their presence: a payload that already says the
    // boundary held nothing back denies its own control, whatever the narration or
    // the boolean says.
    const contradictions = CONTRADICTION_RULES
      .filter((rule) => rule.control === name && rule.contradicts(observed))
      .map((rule) => rule.because);
    if (contradictions.length > 0) return [name, refuse(`${name}: ${contradictions.join('; ')}`)];
    return [name, { available: true, why: `${rederived.denial} (positive control: ${rederived.positiveControl}; attack: ${rederived.attack})` }];
  })) as Record<BoundaryControl, { available: boolean; why: string }>;
}
