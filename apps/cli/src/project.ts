/**
 * Project model (1.1 §1): what a repo IS and which checks it DECLARES — behind
 * one ProjectAdapter interface, so the verification/promotion core never learns
 * a per-language pipeline. This file is pure: it spawns nothing, writes
 * nothing, and knows no agent provider. The Node code below was lifted out of
 * onboarding.ts unchanged — same functions, same strings, same digests — so
 * 1.0 behavior is preserved byte-for-byte; adding an ecosystem means adding an
 * adapter here, not a second plan/seal/drift path elsewhere.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const sha256 = (s: string): string => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

/** null = parse failure (caller must refuse, never overwrite). */
export function parseJsonOrNull(file: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch { return null; }
}

// ---------- Node project model (moved verbatim from onboarding.ts) ----------

export const LOCKFILES: Array<[string, string]> = [
  ['package-lock.json', 'npm'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
];
/** Script names we accept into a plan; also blocks any shell-shaped name. */
export const isSafeScriptName = (s: string): boolean => /^[A-Za-z0-9_:.-]{1,64}$/.test(s);
/** Conventional script name -> plan kind. Exact names only; conservative.
 *  M6 (spec M5) adds bench/e2e: a performance or UI task is only PROVEN if a
 *  human actually put a benchmark/e2e script in the sealed plan — detection of
 *  those names is what gives the obligation its chance to reach `met`. */
const PLAN_KINDS = ['typecheck', 'tests', 'build', 'bench', 'e2e'] as const;
export type PlanKind = (typeof PLAN_KINDS)[number];
const SCRIPT_KINDS: Array<[string, PlanKind]> = [
  ['typecheck', 'typecheck'], ['type-check', 'typecheck'], ['test', 'tests'], ['build', 'build'],
  ['bench', 'bench'], ['benchmark', 'bench'], ['e2e', 'e2e'], ['test:e2e', 'e2e'],
];
const PLAN_ORDER: Record<PlanKind, number> = { typecheck: 0, tests: 1, build: 2, bench: 3, e2e: 4 };

export interface PlanStep { kind: PlanKind; script: string }

export function detectPm(root: string): { pm: string; note: string } {
  for (const [file, pm] of LOCKFILES) {
    if (fs.existsSync(path.join(root, file))) return { pm, note: `${file} found` };
  }
  return { pm: 'npm', note: 'no lockfile found — defaulted to npm' };
}

export function detectPlan(pkgScripts: Record<string, unknown>): PlanStep[] {
  const steps: PlanStep[] = [];
  for (const [name, kind] of SCRIPT_KINDS) {
    if (typeof pkgScripts[name] === 'string' && isSafeScriptName(name) && pkgScripts[name].trim()) {
      if (!steps.some((s) => s.kind === kind)) steps.push({ kind, script: name });
    }
  }
  return steps.sort((a, b) => PLAN_ORDER[a.kind] - PLAN_ORDER[b.kind]);
}

/** Reconstruct argv for one step. Only validated fragments ever reach here. */
export function stepArgv(pm: string, script: string): string[] {
  if (!/^(npm|pnpm|yarn|bun)$/.test(pm) || !isSafeScriptName(script)) {
    throw new Error(`refused unsafe plan step ${JSON.stringify({ pm, script })}`);
  }
  return [pm, 'run', script];
}

/** sha256 over the canonical plan ([{kind,script}] in order). The per-step
 *  executed argv is recorded separately; this binds WHICH plan was in force. */
export function planDigest(plan: PlanStep[]): string {
  return sha256(JSON.stringify(plan.map((s) => ({ kind: s.kind, script: s.script }))));
}

// ---------- M5 trusted verification plan ----------
/**
 * The worker must not redefine success after implementing its solution. The
 * plan and the script TEXTS sealed at setup are TRUSTED authority — whoever or
 * whatever ran setup (including --yes, no review) is what the seal attests;
 * the candidate controls only the implementation. This seal catches the
 * subtle attack the exit-code oracle cannot: `"test": "vitest"` swapped for
 * `"test": "echo all good"` still exits 0 — a "pass" of a hollowed-out check
 * certifies nothing. So the seal is verified BEFORE anything executes, and a
 * drifted command is never run as proof at all.
 *
 * Detected here (mid-task drift against the setup-time seal): plan edits
 * (cfg.plan — the test/build/typecheck script choice, kind relabels
 * included) and package-script TEXT edits. NOT claimed: any seal over the
 * tool config files a sealed command reads (vitest.config.ts, tsconfig …) —
 * editing those is the same attack class arriving through an UNSEALED door,
 * and working-tree visibility is the detection path M7 builds on; overclaim
 * it not. Containment of an agent that re-runs setup itself is likewise not
 * claimed — re-sealing is a visible act that re-smokes the new command — and
 * honest containment of candidate edits to Canary's own protected files
 * (.canary state, hooks) is M7's protected-surface work. Per-test-name
 * inventory drift (427→426) is out of scope too: M4's observedCounts record
 * the raw material; no seal over test names exists yet. A config with no
 * seal (pre-M5) verifies exactly as before — additive, and `canary setup`
 * is what creates the authority.
 */
export interface PlanAuthority {
  /** when this seal was captured (the last genuine setup run) */
  at: string;
  planDigest: string;
  /** sha256 of the exact package.json script text, keyed by script name */
  scriptDigests: Record<string, string>;
  /** Explicit task/requirement digest -> plan script, sealed by setup. */
  proofBindings?: Record<string, string>;
}

/** The subset of the onboarding config a drift check reads (CanaryConfig
 *  satisfies it structurally; declared here so this module owns no import
 *  from onboarding — the seam is one-way). */
export interface AuthorityCarrier {
  plan: PlanStep[];
  planAuthority?: PlanAuthority;
}

/** Capture the authority this setup run seals: the plan plus the verbatim
 *  text of every script it references. detectPlan guarantees plan scripts
 *  exist as non-empty strings in pkgScripts; anything else is left unsealed
 *  and the drift check fails closed on it. */
export function sealPlanAuthority(plan: PlanStep[], pkgScripts: Record<string, unknown>, bindings?: unknown): PlanAuthority {
  const scriptDigests: Record<string, string> = {};
  for (const s of plan) {
    const t = pkgScripts[s.script];
    if (typeof t === 'string') scriptDigests[s.script] = sha256(t);
  }
  if (bindings !== undefined && (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)
    || !Object.entries(bindings).every(([d,s]) => /^[0-9a-f]{64}$/.test(d) && typeof s === 'string' && plan.some(p => p.script === s)))) {
    throw new Error('package.json canary.proofs must map full task/requirement digests to recognized plan scripts');
  }
  return { at: new Date().toISOString(), planDigest: planDigest(plan), scriptDigests,
    proofBindings: Object.fromEntries(Object.entries((bindings ?? {}) as Record<string,string>).sort(([a],[b]) => a.localeCompare(b))) };
}

/** How the current repo state deviates from the sealed verification authority
 *  — a human-readable sentence (script names sanitized; no candidate-controlled
 *  prose can ride the message), or null when there is no drift (or no seal). */
export function planAuthorityDrift(root: string, cfg: AuthorityCarrier, pkg?: Record<string, unknown> | null): string | null {
  const seal = cfg.planAuthority;
  if (seal === undefined) return null; // pre-M5 config: nothing sealed, nothing to drift from
  if (typeof seal !== 'object' || seal === null
    || typeof seal.at !== 'string' || !/^[0-9a-f]{64}$/.test(String(seal.planDigest))
    || typeof seal.scriptDigests !== 'object' || seal.scriptDigests === null || Array.isArray(seal.scriptDigests)
    || !Object.values(seal.scriptDigests).every((d) => typeof d === 'string' && /^[0-9a-f]{64}$/.test(d))) {
    return 'the sealed verification authority in .canary/canary.local.json is malformed (hand-edited?)';
  }
  const drift: string[] = [];
  if (seal.proofBindings !== undefined && (!seal.proofBindings || typeof seal.proofBindings !== 'object' || Array.isArray(seal.proofBindings)
    || !Object.entries(seal.proofBindings).every(([d,s]) => /^[0-9a-f]{64}$/.test(d) && typeof s === 'string' && cfg.plan.some(p => p.script === s)))) return 'malformed sealed proof bindings';
  if (planDigest(cfg.plan) !== seal.planDigest) drift.push('the plan no longer matches the sealed plan');
  // pkg may be the caller's already-read copy (candidate.ts's seal check reads
  // the same file one line later for the lifecycle-hook scan); absent = read.
  const pkgBytes = pkg === undefined ? parseJsonOrNull(path.join(root, 'package.json')) : pkg;
  const scripts = pkgBytes ? (pkgBytes.scripts ?? {}) as Record<string, unknown> : null;
  if (scripts === null && cfg.plan.length > 0) drift.push('package.json cannot be read to compare the sealed scripts');
  for (const s of cfg.plan) {
    const name = isSafeScriptName(s.script) ? s.script : '<odd plan entry>'; // never echo raw config text
    if (!Object.hasOwn(seal.scriptDigests, s.script)) {
      drift.push(`script "${name}" is in the plan but was never sealed`);
      continue;
    }
    if (scripts === null) continue; // unreadable pkg already reported
    const cur = scripts[s.script];
    if (typeof cur !== 'string') drift.push(`script "${name}" no longer exists in package.json`);
    else if (sha256(cur) !== seal.scriptDigests[s.script]) drift.push(`script "${name}" changed since setup sealed it`);
  }
  return drift.length ? drift.join('; ') : null;
}

// ---------- 1.1 §1: the project adapter interface ----------
/**
 * One adapter per ecosystem, one canonical pipeline. Everything the plan
 * machinery needs to know about a project is answered HERE, in pure local
 * code; how a step is SPAWNED (hardened env, trusted dirs, evidence) is the
 * executor's job and stays language-agnostic. An adapter may only report
 * checks the project genuinely DECLARES — discovery invents nothing, and the
 * empty plan (=> NEEDS ATTENTION, never READY) is a complete answer.
 */
export interface ProjectDetection {
  detected: boolean;
  /** how sure the detection is — polyglot ambiguity is resolved by the
   *  caller asking a human, never by the adapter guessing */
  confidence: 'high' | 'medium' | 'low';
  /** the plain fact the decision rests on ("package.json found", …) */
  reason: string;
}
/** What the project declares: runner + its note, the check plan, and the
 *  parsed declaration source the seal digests. */
export interface DiscoveredProject {
  pm: string;
  note: string;
  plan: PlanStep[];
  source: Record<string, unknown>;
}

export interface ProjectAdapter {
  readonly id: string;
  /** Is this ecosystem present here, and on what evidence? */
  detect(root: string): ProjectDetection;
  /** The checks the project actually declares (may be empty — that is honest). */
  discoverChecks(root: string): DiscoveredProject;
  /** Why the stored runner name cannot be one we execute — plain words, or
   *  null. Pure name-shape only; the live "is it actually runnable here"
   *  probe belongs to the hardened executor, never to an adapter. */
  validateEnvironment(pm: string): string | null;
  /** One human-sized line naming what kind of project this is. */
  describe(): string;
  /** Freeze the declared checks exactly as setup sealed them. */
  seal(plan: PlanStep[], source: Record<string, unknown>, bindings?: unknown): PlanAuthority;
  /** How live state deviates from the sealed authority, or null. `source` may
   *  be a caller's already-read copy (two-edge freshness reads stay deliberate). */
  drift(root: string, cfg: AuthorityCarrier, source?: Record<string, unknown> | null): string | null;
  /** Problems with plan steps referencing declarations that no longer exist. */
  planProblems(root: string, plan: PlanStep[]): string[];
  /** Reconstruct argv for one step; throws rather than build an unsafe command. */
  stepArgv(pm: string, step: PlanStep): string[];
  /** Base names whose change means the dependency set moved (M6 signal). */
  readonly dependencyPaths: readonly string[];
}

export const nodeAdapter: ProjectAdapter = {
  id: 'node',
  detect(root) {
    if (fs.existsSync(path.join(root, 'package.json'))) {
      return { detected: true, confidence: 'high', reason: 'package.json found' };
    }
    return { detected: false, confidence: 'high', reason: 'no package.json' };
  },
  discoverChecks(root) {
    const { pm, note } = detectPm(root);
    const source = parseJsonOrNull(path.join(root, 'package.json')) ?? {};
    const plan = detectPlan((source.scripts ?? {}) as Record<string, unknown>);
    return { pm, note, plan, source };
  },
  validateEnvironment(pm) {
    return /^(npm|pnpm|yarn|bun)$/.test(pm)
      ? null
      : `package manager "${pm}" is not one Canary can run (npm, pnpm, yarn or bun)`;
  },
  describe() { return 'Node-style project (checks declared as package.json scripts)'; },
  seal(plan, source, bindings) {
    return sealPlanAuthority(plan, (source.scripts ?? {}) as Record<string, unknown>, bindings);
  },
  drift(root, cfg, source) { return planAuthorityDrift(root, cfg, source); },
  planProblems(root, plan) {
    const pkg = parseJsonOrNull(path.join(root, 'package.json'));
    const scripts = (pkg?.scripts ?? {}) as Record<string, unknown>;
    const problems: string[] = [];
    for (const s of plan) {
      if (!scripts[s.script]) problems.push(`plan references script "${s.script}" which no longer exists in package.json`);
    }
    return problems;
  },
  stepArgv(pm, step) { return stepArgv(pm, step.script); },
  dependencyPaths: LOCKFILES.map(([f]) => f),
};

/** Registered project adapters. A config may only name an id present HERE —
 *  validConfigShape rejects anything else as corrupt, so a repo Canary cannot
 *  model fails closed to NEEDS ATTENTION instead of silently running the Node
 *  pipeline against a foreign project. */
export const ADAPTERS: Record<string, ProjectAdapter> = { node: nodeAdapter };

/** The adapter a config names. Absent means 'node': every config written
 *  before 1.1 describes a Node project, and setup keeps omitting the field
 *  until detection can legitimately write it — 1.0 config bytes are stable. */
export function adapterFor(cfg: { project?: string }): ProjectAdapter {
  const id = cfg.project ?? 'node';
  const adapter = Object.hasOwn(ADAPTERS, id) ? ADAPTERS[id] : undefined;
  if (!adapter) throw new Error(`project adapter "${id}" is not registered in this Canary build`);
  return adapter;
}
