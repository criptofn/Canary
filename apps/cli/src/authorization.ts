/** Canonical declaration identity. Digests identify declarations, never their truth.
 * Requirements are a sorted multiset: order is immaterial, duplicates count.
 * No timestamp, display prose, verdict status or filesystem cache participates. */
import crypto from 'node:crypto';

export const TASK_KINDS = ['bugfix', 'refactor', 'dependency', 'performance', 'ui', 'multi'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
export const MAX_REQUIREMENTS = 64;
export const digest = (s: string): string => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
export const canonicalText = (s: string): string => s.trim().replace(/\s+/gu, ' ');
export const materialDigest = (s: string): string => digest(canonicalText(s));
const HEX = /^[0-9a-f]{64}$/;
export interface ObjectiveTarget { digest: string; kind: 'bench' | 'e2e' }
export interface TaskIdentity {
  taskDigest: string;
  kinds: TaskKind[];
  requirementCount: number;
  requirementDigests: string[];
  subjectiveVisual: boolean;
  subjectivePerformance: boolean;
  objectiveTargets: ObjectiveTarget[];
}
const aesthetic = /\b(prett\w*|beautiful\w*|aesthetic\w*|stylish|elegan\w*|warmer|cooler|nicer|polish\w*|better[- ]looking|look and feel|make it pop)\b/i;
const numericPerformance = /\d+(?:\.\d+)?\s*(?:ms|msecs?|secs?|seconds?|minutes?|fps|[kmgt]?bytes?|[kmgt]b|%|hz)\b|\d+(?:\.\d+)?\s*%/i;
const numericUi = /#[\da-f]{3,8}\b|\d+(?:\.\d+)?\s*(?:px|rem|em)\b/i;

export function declaredTask(text: string, kinds: TaskKind[], requirements: string[]): TaskIdentity {
  if (requirements.length > MAX_REQUIREMENTS) throw new Error(`at most ${MAX_REQUIREMENTS} requirements are supported; nothing was registered`);
  const parts = [text, ...requirements];
  return canonicalTask({
    taskDigest: materialDigest(text), kinds,
    requirementCount: requirements.length,
    requirementDigests: requirements.map(materialDigest),
    subjectiveVisual: parts.some(s => aesthetic.test(s)),
    subjectivePerformance: parts.some(s => /\b(feel\w*|snapp\w*|smooth\w*|responsive\w*)\b/i.test(s)) && kinds.includes('performance'),
    objectiveTargets: parts.flatMap(s => numericPerformance.test(s)
      ? [{ digest: materialDigest(s), kind: 'bench' }]
      : numericUi.test(s) ? [{ digest: materialDigest(s), kind: 'e2e' }] : []),
  })!;
}

/** Strict at every reader, including frozen records. Legacy incomplete identities
 * require registration + re-isolation; absence never means an empty safe scope. */
export function canonicalTask(value: unknown): TaskIdentity | null {
  if (!value || typeof value !== 'object') return null;
  const t = value as TaskIdentity;
  if (typeof t.taskDigest !== 'string' || !HEX.test(t.taskDigest)
    || !Array.isArray(t.kinds) || !t.kinds.every(k => TASK_KINDS.includes(k))
    || !Number.isInteger(t.requirementCount) || t.requirementCount < 0 || t.requirementCount > MAX_REQUIREMENTS
    || !Array.isArray(t.requirementDigests) || t.requirementDigests.length !== t.requirementCount
    || !t.requirementDigests.every(d => typeof d === 'string' && HEX.test(d))
    || typeof t.subjectiveVisual !== 'boolean' || typeof t.subjectivePerformance !== 'boolean' || !Array.isArray(t.objectiveTargets)
    || !t.objectiveTargets.every(o => o && HEX.test(o.digest) && (o.kind === 'bench' || o.kind === 'e2e')
      && (o.digest === t.taskDigest || t.requirementDigests.includes(o.digest)))) return null;
  return {
    taskDigest: t.taskDigest, kinds: [...new Set(t.kinds)].sort(),
    requirementCount: t.requirementCount, requirementDigests: [...t.requirementDigests].sort(),
    subjectiveVisual: t.subjectiveVisual,
    subjectivePerformance: t.subjectivePerformance,
    objectiveTargets: [...new Map(t.objectiveTargets.map(o => [`${o.kind}:${o.digest}`, { digest: o.digest, kind: o.kind }])).values()]
      .sort((a,b) => `${a.kind}:${a.digest}`.localeCompare(`${b.kind}:${b.digest}`)),
  };
}

export function taskWeakening(frozen: TaskIdentity, live: TaskIdentity | null): string[] {
  if (!live) return ['registered task identity is missing or malformed'];
  const reasons: string[] = [];
  if (frozen.taskDigest !== live.taskDigest) reasons.push('material task changed; prior acceptance is STALE — re-isolate for the new request');
  for (const kind of frozen.kinds) if (!live.kinds.includes(kind)) reasons.push(`task kind "${kind}" registered at isolation is gone from the task record`);
  const remaining = [...live.requirementDigests];
  for (const d of frozen.requirementDigests) {
    const i = remaining.indexOf(d);
    if (i < 0) { reasons.push('frozen requirement removed or replaced; re-isolate for revised requirements'); break; }
    remaining.splice(i, 1);
  }
  if (frozen.subjectiveVisual && !live.subjectiveVisual) reasons.push('frozen subjective visual intent removed');
  if (frozen.subjectivePerformance && !live.subjectivePerformance) reasons.push('frozen subjective performance intent removed');
  for (const target of frozen.objectiveTargets) if (!live.objectiveTargets.some(o => o.digest === target.digest && o.kind === target.kind)) reasons.push('frozen objective target removed');
  return reasons;
}

export interface AuthorizationSubject {
  candidate: string;
  candidateCommit: string;
  candidateTree: string;
  baseHead: string;
  baseTree: string;
  baseAuthorityIdentity: string;
  frozenTask: TaskIdentity;
  liveTask: TaskIdentity;
  subjectiveDuties: string[];
}
export function subjectDigest(subject: AuthorizationSubject): string {
  return digest(JSON.stringify({
    candidate: subject.candidate, candidateCommit: subject.candidateCommit, candidateTree: subject.candidateTree,
    baseHead: subject.baseHead, baseTree: subject.baseTree, baseAuthorityIdentity: subject.baseAuthorityIdentity,
    frozenTask: canonicalTask(subject.frozenTask), liveTask: canonicalTask(subject.liveTask),
    subjectiveDuties: [...new Set(subject.subjectiveDuties)].sort(),
  }));
}
