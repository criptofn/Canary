/**
 * Post-sol M-1 — ONE DELIBERATE CONTRACT, TWO VIEWS, ZERO DRIFT.
 *
 * The audit demonstrated the runtime validator and the published JSON schema
 * had become independent definitions that disagreed in BOTH directions:
 * runtime accepted resealed bundles missing `commands`, `killedByTimeout`,
 * `startedAt`, `durationMs` (the published schema requires them), while the
 * published schema rejected legitimate round-3 evidence (its
 * `additionalProperties:false` never learned about `snapshots`,
 * `observationAnomalies`, `crashSignal`, `sweepFailed`).
 *
 * This module is the SINGLE SOURCE OF TRUTH for the structural floor:
 *  - `buildPublishedSchema()` generates `schemas/evidence.schema.json`
 *    (a test regenerates and deep-compares against the committed file, so
 *    editing the schema without the contract — or vice versa — fails CI);
 *  - `structuralIssues()` enforces the same presence + type + unknown-field
 *    policy inside `validateBundle()` (runtime);
 *  - fields whose requirement depends on the claimed label (the TRUSTFUL
 *    tier) are emitted into the schema as an `allOf/if/then` block AND
 *    enforced at runtime by validateBundle's semantic layer (which owns the
 *    refusal messages and the emptiness rules JSON Schema cannot express).
 *
 * Anything NOT listed here stays a semantic-layer (hand-written) check:
 * cross-field coherence, classification re-derivation, artifact-name
 * derivation, env-key allowlisting, round-index density — rules JSON Schema
 * cannot express.
 */

export type Req = 'always' | 'trustful' | 'optional';

type LeafKind =
  | 'string' | 'isoString' | 'sha40' | 'sha64' | 'bool' | 'int0' | 'intGE1'
  | 'num' | 'strMap' | 'enum' | 'argv';
interface Leaf { req: Req; kind: LeafKind; values?: readonly string[]; msg?: string }
interface ObjF { req: Req; obj: Record<string, Field> }
interface ArrF { req: Req; arr: Field }
type Field = Leaf | ObjF | ArrF;

const s = (req: Req = 'always'): Field => ({ req, kind: 'string' });
const iso = (req: Req = 'always'): Field => ({ req, kind: 'isoString' });
const hex64 = (req: Req = 'always'): Field => ({ req, kind: 'sha64' });
const bool = (req: Req = 'always'): Field => ({ req, kind: 'bool' });
const int0 = (req: Req = 'always'): Field => ({ req, kind: 'int0' });
const num = (req: Req = 'always'): Field => ({ req, kind: 'num' });
const argv = (req: Req = 'always'): Field => ({ req, kind: 'argv' });
const obj = (req: Req, fields: Record<string, Field>): Field => ({ req, obj: fields });
const arr = (req: Req, items: Field): Field => ({ req, arr: items });

/** The TRUSTFUL classification labels whose evidence floor is higher. */
export const TRUSTFUL_LABELS = ['PASS', 'CONFIRMED_REGRESSION', 'PRE_EXISTING_FAILURE'] as const;

/** CONTRACT: bundle shape. Req tiers:
 *  'always'   — every honest bundle carries it; absence is refused by BOTH views;
 *  'trustful' — required when classification.label is trustful (schema:
 *               allOf/if/then; runtime: the semantic layer's own refusals);
 *  'optional' — INTENTIONALLY optional (documented by the tier itself):
 *               a runner summary that cannot read pending counts, a round
 *               with no crash signature, a non-trustful run without retained
 *               trees, an un-annotated bundle. */
export const BUNDLE_CONTRACT: Field = obj('always', {
  schemaVersion: num(),
  runId: s(),
  createdAt: iso(),
  canaryVersion: s(),
  experimentId: s(),
  dependency: obj('always', {
    package: s(), baselineVersion: s(), candidateVersion: s(),
  }),
  downstream: obj('always', {
    repositoryUrl: s(),
    commitSha: { req: 'always', kind: 'sha40', msg: 'downstream.commitSha must be a full 40-hex SHA' },
    fetchMethod: { req: 'always', kind: 'enum', values: ['tarball-by-sha'] },
    tarballSha256: hex64(),
  }),
  environment: obj('always', {
    nodeVersion: s(), npmVersion: s(), packageManagerUsed: s(),
    platform: s(), arch: s(),
    toolchainOverrides: { req: 'always', kind: 'strMap' },
  }),
  commands: obj('always', {
    prepare: arr('always', argv()),
    build: arr('always', argv()),
    swap: argv(),
    test: argv(),
  }),
  rounds: arr('always', obj('always', {
    arm: { req: 'always', kind: 'enum', values: ['baseline', 'candidate'] },
    round: { req: 'always', kind: 'intGE1' },
    exitCode: num(), // integer & >= -1 are semantic-layer rules
    killedByTimeout: bool(),
    hasRunnerSummary: bool(),
    infraSignal: { req: 'trustful', kind: 'bool' },
    reportedPassing: int0('optional'),
    reportedFailing: int0('optional'),
    reportedPending: int0('optional'),
    failingTestNames: { req: 'optional', arr: s() },
    crashSignal: { req: 'optional', kind: 'bool' },
    sweepFailed: { req: 'optional', kind: 'bool' },
    // Post-GLM observation hardening (panel E): Canary's OWN per-round
    // execution record. REQUIRED on every round of every bundle — an honest
    // run always carries it (ABSENT with a reason when Canary did not inject;
    // old bundles failing here is the intended fail-closed direction).
    // Cross-field iff-rules are SEMANTIC (validateBundle): VALID⇔counts+
    // versions+tree-sha; INVALID⇔invalidReason; ABSENT⇔absentKind;
    // strayFd3Sha256⇔strayFd3Bytes. JSON Schema presence cannot express them.
    executionObservation: obj('always', {
      status: { req: 'always', kind: 'enum', values: ['VALID', 'ABSENT', 'INVALID'] },
      observedFailingIdentities: { req: 'always', arr: s() },
      framesSha256: hex64(),
      frameCount: int0(),
      observedCounts: obj('optional', { passing: int0(), failing: int0(), pending: int0() }),
      expectedMochaVersion: s('optional'),
      observedMochaVersion: s('optional'),
      expectedRunnerTreeSha256: hex64('optional'),
      observedRunnerTreeSha256: hex64('optional'),
      invalidReason: s('optional'),
      absentKind: { req: 'optional', kind: 'enum', values: ['not-mocha-bin', 'no-injection', 'runner-identity-unpinned'] },
      strayFd3Bytes: bool('optional'),
      strayFd3Sha256: hex64('optional'),
    }),
    startedAt: iso(),
    durationMs: int0(),
    rawStdoutSha256: hex64(),
    rawStderrSha256: hex64(),
    normalizedStdoutSha256: hex64(),
    normalizedStderrSha256: hex64(),
    logPath: s(),
    argv: argv(),
    envKeys: arr('always', s()),
  })),
  treeComparison: obj('always', {
    baselineTreeSha256: hex64(),
    candidateTreeSha256: hex64(),
    driftConfinedToDependency: bool(),
    observationStatus: obj('always', {
      baseline: { req: 'always', kind: 'enum', values: ['VALID', 'INCOMPLETE', 'INVALID'] },
      candidate: { req: 'always', kind: 'enum', values: ['VALID', 'INCOMPLETE', 'INVALID'] },
    }),
    resolvedVersions: obj('always', { baseline: s(), candidate: s() }),
    dependencyCopies: obj('always', { baseline: int0(), candidate: int0() }),
    snapshots: obj('trustful', {
      baseline: obj('always', {
        rawStdoutLog: s(), rawStdoutSha256: hex64(),
        rawStderrLog: s(), rawStderrSha256: hex64(),
        canonicalLog: s(), canonicalSha256: hex64(),
      }),
      candidate: obj('always', {
        rawStdoutLog: s(), rawStdoutSha256: hex64(),
        rawStderrLog: s(), rawStderrSha256: hex64(),
        canonicalLog: s(), canonicalSha256: hex64(),
      }),
    }),
    observationAnomalies: obj('trustful', {
      baseline: obj('always', { json: arr('always', s()) }),
      candidate: obj('always', { json: arr('always', s()) }),
    }),
  }),
  classification: obj('always', {
    label: {
      req: 'always', kind: 'enum',
      msg: 'classification.label must be one of the six deterministic labels',
      values: ['PASS', 'CONFIRMED_REGRESSION', 'PRE_EXISTING_FAILURE', 'FLAKY', 'INFRASTRUCTURE_FAILURE', 'INCONCLUSIVE'],
    },
    rule: num(),
    reason: s(),
    reproductionCount: { req: 'always', kind: 'intGE1', msg: 'classification.reproductionCount must be >= 1' },
  }),
  integrity: obj('always', {
    version: num(),
    manifestSha256: hex64(),
  }),
  ai: obj('optional', {
    provider: s(), summary: s(), attachedAt: iso(),
  }),
});

/* ------------------------------------------------------------------ */
/* JSON Schema (draft 2020-12) generation                              */
/* ------------------------------------------------------------------ */

function leafSchema(f: Leaf): Record<string, unknown> {
  switch (f.kind) {
    case 'string': return { type: 'string', minLength: 1 };
    case 'isoString': return { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T' };
    case 'sha40': return { type: 'string', pattern: '^[0-9a-f]{40}$' };
    case 'sha64': return { type: 'string', pattern: '^[0-9a-f]{64}$' };
    case 'bool': return { type: 'boolean' };
    case 'int0': return { type: 'integer', minimum: 0 };
    case 'intGE1': return { type: 'integer', minimum: 1 };
    case 'num': return { type: 'number' };
    case 'strMap': return { type: 'object', additionalProperties: { type: 'string' } };
    case 'enum': return f.values && f.values.length > 0 ? { enum: [...f.values] } : { type: 'number' };
    case 'argv': return { type: 'array', items: { type: 'string' }, minItems: 1 };
  }
}

function toSchema(f: Field): Record<string, unknown> {
  if ('kind' in f) return leafSchema(f);
  if ('arr' in f) return { type: 'array', items: toSchema(f.arr) };
  const o = f.obj;
  const required = Object.entries(o).filter(([, v]) => v.req === 'always').map(([k]) => k).sort();
  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) props[k] = toSchema(v);
  return {
    type: 'object',
    additionalProperties: false,
    ...(required.length > 0 ? { required } : {}),
    properties: props,
  };
}

/**
 * Generate the PUBLISHED schema. The TRUSTFUL tier becomes an
 * `allOf/if/then` block: when classification.label is one of the trustful
 * labels, per-round infraSignal plus treeComparison.snapshots and
 * treeComparison.observationAnomalies are required — exactly what
 * validateBundle's semantic layer enforces at runtime.
 */
export function buildPublishedSchema(): Record<string, unknown> {
  const root = toSchema(BUNDLE_CONTRACT) as Record<string, unknown>;
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://canary-reliability-network.local/schemas/evidence.schema.json',
    title: 'Canary Evidence Bundle',
    description:
      'Machine-readable output of one Canary experiment. GENERATED FILE — the single source of truth is packages/evidence/schema/src/contract.ts (schema.test.ts regenerates and deep-compares; edit the contract, never this file). The classification field is produced exclusively by the deterministic decision table (docs/PLAN.md section 6); no field in this schema can be authored by an AI provider. Trustful-tier fields (round infraSignal; treeComparison.snapshots/observationAnomalies) are required exactly when classification.label is PASS/CONFIRMED_REGRESSION/PRE_EXISTING_FAILURE — see the allOf block; the runtime validator enforces the same tier and additionally requires the anomaly lists to be EMPTY for a trustful label (a rule beyond JSON-schema presence).',
    ...root,
    allOf: [{
      if: {
        properties: { classification: { properties: { label: { enum: [...TRUSTFUL_LABELS] } } } },
      },
      then: {
        properties: {
          rounds: { items: { required: ['infraSignal'] } },
          treeComparison: { required: ['snapshots', 'observationAnomalies'] },
        },
      },
    }],
  };
}

/* ------------------------------------------------------------------ */
/* Runtime structural floor (drives validateBundle)                    */
/* ------------------------------------------------------------------ */

const ISO_RE = /^\d{4}-\d{2}-\d{2}T/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const SHA40_RE = /^[0-9a-f]{40}$/;

function checkLeaf(path: string, f: Leaf, v: unknown): string[] {
  const bad = (m: string): string[] => [m];
  switch (f.kind) {
    case 'string': return typeof v === 'string' && v.length > 0 ? [] : bad(`${path} missing/empty`);
    case 'isoString': return typeof v === 'string' && ISO_RE.test(v) ? [] : bad(`${path} must be an ISO-8601 timestamp string (YYYY-MM-DDTHH:mm:ssZ)`);
    case 'sha40': return SHA40_RE.test(String(v ?? '')) ? [] : bad(f.msg ?? `${path} must be a full 40-hex SHA`);
    case 'sha64': return HEX64_RE.test(String(v ?? '')) ? [] : bad(`${path} invalid`);
    case 'bool': return typeof v === 'boolean' ? [] : bad(`${path} must be a boolean`);
    case 'int0': return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? [] : bad(`${path} must be a non-negative integer`);
    case 'intGE1': return typeof v === 'number' && Number.isInteger(v) && v >= 1 ? [] : bad(f.msg ?? `${path} must be an integer >= 1`);
    case 'num': return typeof v === 'number' && Number.isFinite(v) ? [] : bad(`${path} must be a number`);
    case 'strMap':
      return typeof v === 'object' && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string')
        ? [] : bad(`${path} must be a string->string map`);
    case 'enum':
      if (f.values && f.values.length > 0) {
        return f.values.includes(String(v)) ? [] : bad(f.msg ?? `${path} must be one of: ${f.values.join(', ')}`);
      }
      return typeof v === 'number' ? [] : bad(`${path} must be a number`);
    case 'argv':
      return Array.isArray(v) && v.length >= 1 && v.every((x) => typeof x === 'string')
        ? [] : bad(`${path} must be a non-empty array of strings`);
  }
}

/**
 * Enforce the structural floor from the shared contract: presence, types,
 * and the UNKNOWN-FIELD policy (additionalProperties:false everywhere by
 * contract — an unannounced field is a contract divergence, refused).
 * TRUSTFUL-tier fields are SHAPE-checked when present; their PRESENCE for
 * trustful labels is refused by validateBundle's semantic layer with its
 * established messages (kept there because "anomaly list present AND EMPTY"
 * is one rule the schema can only half-express).
 */
export function structuralIssues(b: Record<string, unknown>): string[] {
  const issues: string[] = [];
  const walk = (f: Field, v: unknown, path: string): void => {
    if (v === undefined) {
      if (f.req === 'always') {
        issues.push(`${path} missing — required by the published contract (schema/contract.ts, post-sol M-1)`);
      }
      return;
    }
    if ('kind' in f) { issues.push(...checkLeaf(path, f, v)); return; }
    if ('arr' in f) {
      if (!Array.isArray(v)) { issues.push(`${path} must be an array`); return; }
      v.forEach((item, i) => walk(f.arr, item, `${path}[${i}]`));
      return;
    }
    if (typeof v !== 'object' || v === null || Array.isArray(v)) { issues.push(`${path} must be an object`); return; }
    const o = v as Record<string, unknown>;
    for (const k of Object.keys(o)) {
      if (!(k in f.obj)) issues.push(`${path}.${k} is not a field of the published contract (unknown fields are refused by policy — post-sol M-1)`);
    }
    for (const [k, sub] of Object.entries(f.obj)) {
      walk(sub, o[k], path ? `${path}.${k}` : k);
    }
  };
  walk(BUNDLE_CONTRACT, b, '');
  return issues;
}
