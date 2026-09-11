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

// The non-Node ecosystems are declarations that hang off this same interface.
// The import is a cycle on purpose and is safe: ecosystems.ts uses this
// module's helpers only at CALL time, never during module evaluation, while the
// adapter objects it exports are plain constants this module needs at init.
import { ECOSYSTEM_ADAPTERS } from './ecosystems.js';
// The fast-path declaration validator. The import is a cycle (fastpath.ts uses
// this module's `stepKey`/`PlanStep`) and is safe for the same reason the
// ecosystems cycle is: nothing here is called during module evaluation.
import { validateStepPaths } from './fastpath.js';

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

/**
 * One normalized check in the sealed plan.
 *
 * 1.0 shape was `{kind, script}` — a package.json script name, re-invoked
 * later as `<pm> run <script>`. That shape cannot describe a check in a project
 * that has no package.json, and `cfg.pm` (one flat runner per repo) cannot
 * describe a polyglot repo at all.
 *
 * The 1.1 fields are ADDITIVE and optional, and absent fields keep 1.0
 * behaviour byte-for-byte:
 *   - `argv`    the exact command, as data, when the ecosystem does not run
 *               through a package-manager script (python/rust/go). When
 *               present it is the sealed authority for this step and it is
 *               what the executor spawns — never re-derived later.
 *   - `adapter` which ecosystem declared this check (audit/provenance).
 *   - `scope`   the project root this check belongs to, relative to the repo
 *               root ('' or absent = the repo root). Two ecosystems in one
 *               repo need two scopes, and digests must not collide across them.
 */
export interface PlanStep {
  kind: PlanKind;
  script: string;
  adapter?: string;
  scope?: string;
  argv?: string[];
}

/** The sealed-identity key of a step. Legacy steps (no scope) key on the bare
 *  script name — the 1.0 digest map, unchanged. Scoped steps are qualified, so
 *  a `test` script in `web/` can never be mistaken for a `test` script in
 *  `backend/` (same name, different bytes, different authority). */
export function stepKey(step: PlanStep): string {
  return step.scope ? `${step.scope}::${step.script}` : step.script;
}

/** Canonical form for hashing. Field ORDER is fixed and new fields appear ONLY
 *  when present, so a 1.0 plan hashes exactly as it did before 1.1 — every
 *  existing seal stays valid, which is what lets the store and the config stay
 *  byte-identical across the upgrade. */
function canonicalStep(step: PlanStep): Record<string, unknown> {
  const out: Record<string, unknown> = { kind: step.kind, script: step.script };
  if (step.adapter !== undefined) out.adapter = step.adapter;
  if (step.scope !== undefined) out.scope = step.scope;
  if (step.argv !== undefined) out.argv = [...step.argv];
  return out;
}

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

/**
 * Validate an EXPLICIT argv (a non-script ecosystem's declared command).
 *
 * No shell is ever involved (`shell: false` everywhere), so this is not shell-
 * quoting hygiene: it is the fact that this argv becomes SEALED AUTHORITY and
 * is spawned verbatim. Rules:
 *   - non-empty array of non-empty strings, bounded in size and count;
 *   - `argv[0]` is a bare program name or an absolute path — never empty, never
 *     a path fragment like `./tool` or `..\\tool` that resolves relative to a
 *     candidate's working directory;
 *   - no NUL bytes (the one character that cannot survive an OS exec call).
 * Anything else is refused by THROWING; a step that cannot be validated is
 * never "run anyway".
 */
export function assertStepArgv(argv: unknown): string[] {
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > 32) {
    throw new Error('a plan step argv must be a non-empty array of at most 32 arguments');
  }
  for (const a of argv) {
    if (typeof a !== 'string' || a.length === 0 || a.length > 512) throw new Error('plan step argv entries must be non-empty strings under 512 characters');
    if (a.includes('\0')) throw new Error('plan step argv entries must not contain NUL');
  }
  const head = argv[0] as string;
  const isAbsolute = path.isAbsolute(head);
  const isBareProgram = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(head);
  if (!isAbsolute && !isBareProgram) {
    throw new Error(`plan step program ${JSON.stringify(head)} must be a bare program name or an absolute path — a relative path would resolve against whatever directory the step happens to run in`);
  }
  return [...argv] as string[];
}

/** sha256 over the canonical plan ([{kind,script,…}] in order, new fields only
 *  when present). The per-step executed argv is recorded separately; this binds
 *  WHICH plan was in force. */
export function planDigest(plan: PlanStep[]): string {
  return sha256(JSON.stringify(plan.map((s) => canonicalStep(s))));
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
  /** 1.1 §23 — the project's own declaration of which PATHS each check depends
   *  on, sealed here so the fast path can never rest on a guess. Absent means
   *  "undeclared", and an undeclared check always runs. */
  stepPaths?: Record<string, string[]>;
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
export function sealPlanAuthority(plan: PlanStep[], pkgScripts: Record<string, unknown>, bindings?: unknown, declaredPaths?: unknown): PlanAuthority {
  const scriptDigests: Record<string, string> = {};
  for (const s of plan) {
    const key = stepKey(s);
    if (s.argv !== undefined) {
      // A non-script ecosystem's authority is its exact command, as data: the
      // sealed bytes and the spawned bytes are the same array, so a swapped
      // command is drift, not a detail.
      scriptDigests[key] = sha256(JSON.stringify(assertStepArgv(s.argv)));
      continue;
    }
    const t = pkgScripts[s.script];
    if (typeof t === 'string') scriptDigests[key] = sha256(t);
  }
  // 1.1 §23 — the fast-path declaration is SEALED with the plan, and validated
  // before it is: a malformed one is refused by setup rather than quietly
  // ignored, because a project that believes it declared something it did not
  // would be making a decision on authority it never gave.
  const stepPaths = validateStepPaths(declaredPaths, plan);
  if (bindings !== undefined && (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)
    || !Object.entries(bindings).every(([d,s]) => /^[0-9a-f]{64}$/.test(d) && typeof s === 'string' && plan.some(p => p.script === s)))) {
    throw new Error('package.json canary.proofs must map full task/requirement digests to recognized plan scripts');
  }
  return { at: new Date().toISOString(), planDigest: planDigest(plan), scriptDigests,
    ...(Object.keys(stepPaths).length > 0 ? { stepPaths } : {}),
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
  // A plan made only of explicit-argv steps (python/rust/go) declares no
  // package.json scripts, so unreadable package.json is not drift for it.
  const needsPkg = cfg.plan.some((s) => s.argv === undefined);
  const pkgBytes = pkg === undefined ? (needsPkg ? parseJsonOrNull(path.join(root, 'package.json')) : null) : pkg;
  const scripts = pkgBytes ? (pkgBytes.scripts ?? {}) as Record<string, unknown> : null;
  if (scripts === null && needsPkg && cfg.plan.length > 0) drift.push('package.json cannot be read to compare the sealed scripts');
  // 1.1 §23 — a live edit to the fast-path declaration IS drift. The sealed copy
  // still governs (an undeclared check always runs, and only the seal can justify
  // a skip), but a project that edited `canary.paths` and believes it changed
  // what may be left out must be told that it did not: the recovery is a
  // deliberate `canary setup` re-seal, not a silent edit.
  if (seal.stepPaths !== undefined) {
    const livePaths = (pkgBytes?.canary as { paths?: unknown } | undefined)?.paths;
    const canon = (v: unknown): string => JSON.stringify(Object.fromEntries(
      Object.entries((v ?? {}) as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))));
    if (canon(livePaths) !== canon(seal.stepPaths)) {
      drift.push('the fast-path declaration (canary.paths) changed since setup sealed it');
    }
  }
  for (const s of cfg.plan) {
    const key = stepKey(s);
    const safe = isSafeScriptName(s.script) && (s.scope === undefined || /^[A-Za-z0-9._/-]{0,120}$/.test(s.scope));
    const name = safe ? key : '<odd plan entry>'; // never echo raw config text
    if (!Object.hasOwn(seal.scriptDigests, key)) {
      drift.push(`script "${name}" is in the plan but was never sealed`);
      continue;
    }
    if (s.argv !== undefined) {
      if (sha256(JSON.stringify(assertStepArgv(s.argv))) !== seal.scriptDigests[key]) {
        drift.push(`check "${name}" changed since setup sealed it`);
      }
      continue;
    }
    if (scripts === null) continue; // unreadable pkg already reported
    const cur = scripts[s.script];
    if (typeof cur !== 'string') drift.push(`script "${name}" no longer exists in package.json`);
    else if (sha256(cur) !== seal.scriptDigests[key]) drift.push(`script "${name}" changed since setup sealed it`);
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
  /** Absolute directories this ecosystem's programs may be resolved from, in
   *  addition to the runner's baseline trusted dirs. PATH is never consulted,
   *  so an ecosystem whose toolchain lives outside the OS-managed dirs states
   *  its conventional locations HERE (fixed literals, like gitExe's candidate
   *  list) or the step refuses with a message naming the problem. Empty is a
   *  complete answer: it means "the baseline dirs are enough". */
  readonly trustedProgramDirs: readonly string[];
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
    return sealPlanAuthority(plan, (source.scripts ?? {}) as Record<string, unknown>, bindings,
      (source.canary as { paths?: unknown } | undefined)?.paths);
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
  trustedProgramDirs: [], // npm-family runners resolve from the running Node's own install dir
};

/** Registered project adapters. A config may only name an id present HERE —
 *  validConfigShape rejects anything else as corrupt, so a repo Canary cannot
 *  model fails closed to NEEDS ATTENTION instead of silently running the Node
 *  pipeline against a foreign project. Node stays FIRST and unchanged: 1.0
 *  configs name no adapter at all and must keep resolving to it. */
export const ADAPTERS: Record<string, ProjectAdapter> = {
  node: nodeAdapter,
  ...Object.fromEntries(ECOSYSTEM_ADAPTERS.map((a) => [a.id, a])),
};

/** The adapter a config names. Absent means 'node': every config written
 *  before 1.1 describes a Node project, and setup keeps omitting the field
 *  until detection can legitimately write it — 1.0 config bytes are stable. */
export function adapterFor(cfg: { project?: string }): ProjectAdapter {
  const id = cfg.project ?? 'node';
  const adapter = Object.hasOwn(ADAPTERS, id) ? ADAPTERS[id] : undefined;
  if (!adapter) throw new Error(`project adapter "${id}" is not registered in this Canary build`);
  return adapter;
}

// ---------- 1.1 §17: deterministic polyglot composition ----------

/** One ecosystem rooted at one directory. `scope` is repo-root-relative with
 *  forward slashes; '' means the repository root. */
export interface ProjectScope {
  adapter: ProjectAdapter;
  scope: string;
}

/** Directories never worth descending into for discovery: dependency stores,
 *  VCS metadata, virtualenvs and build outputs. Scanning them would be slow and
 *  would discover checks that belong to a dependency, not to this project. */
const DISCOVERY_SKIP = new Set([
  'node_modules', '.git', '.hg', '.svn', '__pycache__', '.venv', 'venv', 'env',
  'target', 'dist', 'build', 'out', 'vendor', 'coverage', '.tox', '.mypy_cache', '.pytest_cache',
]);

/**
 * Find every ecosystem that declares checks, deterministically.
 *
 * Determinism is a requirement, not a nicety: the composite plan is SEALED, so
 * a discovery order that depended on filesystem enumeration order would make a
 * project's sealed authority depend on the machine. Sorted directory names,
 * fixed adapter order (Node, then the registered ecosystems), and shallowest
 * scope first give the same answer twice.
 *
 * Scope rules:
 *   - Node is REPO-ROOT ONLY (unchanged 1.0 semantics — its checks are the root
 *     package.json scripts).
 *   - A non-Node ecosystem is discovered at the shallowest directory that
 *     declares it, and the walk does not descend past that directory for the
 *     same ecosystem (a Go workspace with several modules is one scope, which
 *     is what `go test ./...` means; a nested duplicate is not a second check).
 *   - Depth is bounded (default 2), so discovery cannot walk a monorepo forever.
 */
export function discoverScopes(root: string, maxDepth = 2): ProjectScope[] {
  const scopes: ProjectScope[] = [];
  if (nodeAdapter.detect(root).detected) scopes.push({ adapter: nodeAdapter, scope: '' });
  const claimed = new Set<string>(); // `${adapterId}` already rooted somewhere
  const walk = (dir: string, scope: string, depth: number): void => {
    for (const adapter of ECOSYSTEM_ADAPTERS) {
      if (claimed.has(adapter.id)) continue;
      if (adapter.detect(dir).detected) {
        claimed.add(adapter.id);
        scopes.push({ adapter, scope });
      }
    }
    if (depth >= maxDepth) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (!e.isDirectory() || DISCOVERY_SKIP.has(e.name) || e.name.startsWith('.')) continue;
      walk(path.join(dir, e.name), scope ? `${scope}/${e.name}` : e.name, depth + 1);
    }
  };
  walk(root, '', 0);
  return scopes;
}

/** A scope's plan, discovered by its own adapter, with scope/adapter stamped on
 *  every step that is not the Node root (1.0 steps keep their exact shape). */
export function planForScope(root: string, s: ProjectScope): DiscoveredProject {
  const dir = s.scope ? path.join(root, ...s.scope.split('/')) : root;
  const disc = s.adapter.discoverChecks(dir);
  const plan = disc.plan.map((step) => (s.adapter.id === 'node' && s.scope === ''
    ? step
    : { ...step, adapter: s.adapter.id, ...(s.scope ? { scope: s.scope } : {}) }));
  return { ...disc, plan: plan.sort((a, b) => PLAN_ORDER[a.kind] - PLAN_ORDER[b.kind]) };
}

export interface CompositePlan {
  scopes: ProjectScope[];
  plan: PlanStep[];
  /** One honest line per scope: what it is and what it declared. */
  notes: string[];
  /** Scopes that declared nothing — reported, never silently dropped. */
  empty: string[];
  /** How the scope set was decided: 'root-only' (no declaration) or 'declared'.
   *  Recorded so the two are never confused in a report. */
  scopeSource: 'root-only' | 'declared';
  /** Anything wrong with the scope declaration. Non-empty ⇒ setup must REFUSE;
   *  a declaration Canary cannot honour is never quietly ignored. */
  problems: string[];
}

// ---------- 1.1 §B: explicit nested ecosystem scopes ----------

/**
 * The repo-root file a project uses to declare nested scopes.
 *
 * WHY A SEPARATE FILE AND NOT a key in a manifest: the layout this exists for
 * (web/ Node, backend/ Python, service/ Go) usually has NO manifest at the
 * repository root, so a declaration living inside "the root manifest" would have
 * nowhere to live. It is deliberately NOT under `.canary/` either — that is the
 * authority store (sealed, quarantined, never hand-edited), while this is a
 * human-authored PROJECT INPUT that setup seals like any other declaration.
 *
 * WHY DECLARATIONS AT ALL: discovery walking into subdirectories would let a
 * directory the user does not consider part of the project add checks to it —
 * this repository is itself the example (`archive/python-golden-prototype/`
 * would silently contribute a pytest step). A plan is SEALED AUTHORITY, so the
 * scope set is stated by the human and nothing else is ever added.
 */
export const SCOPES_FILE = 'canary.scopes.json';
export const SCOPES_SCHEMA = 'canary-scopes/1';
const MAX_SCOPE_PATH = 120;

export interface DeclaredScope { path: string; ecosystem: string }
export interface ScopeDeclarationRead {
  scopes: DeclaredScope[];
  /** Everything wrong with the declaration, in full — never just the first. */
  problems: string[];
}

/** A repo-relative scope directory, or the reason it may not be one. */
function scopePathProblem(p: unknown): string | null {
  if (typeof p !== 'string' || p.length === 0) return 'path must be a non-empty string';
  if (p.length > MAX_SCOPE_PATH) return `path is longer than ${MAX_SCOPE_PATH} characters`;
  if (/^[A-Za-z]:/.test(p)) return 'path must be repo-relative, not drive-qualified';
  if (p.startsWith('/') || p.startsWith('\\')) return 'path must be repo-relative, not absolute';
  if (p.includes('\\')) return 'path must use forward slashes';
  if (p.endsWith('/')) return 'path must not end with a slash';
  for (const seg of p.split('/')) {
    if (seg === '') return 'path must not contain an empty segment';
    if (seg === '.' || seg === '..') return 'path must not contain "." or ".." segments';
    if (seg.startsWith('.')) return `path segment "${seg}" is hidden; a declared scope must be an ordinary project directory`;
    if (DISCOVERY_SKIP.has(seg)) return `path segment "${seg}" is a dependency or build store, never a project scope`;
  }
  return null;
}

/**
 * Read + validate the scope declaration. Absent file = no declaration (the 1.0
 * root-only default), which is NOT a problem. Every other defect is reported:
 * an unhonourable declaration must stop setup, not be ignored.
 */
export function readScopeDeclaration(root: string): ScopeDeclarationRead {
  const file = path.join(root, SCOPES_FILE);
  if (!fs.existsSync(file)) return { scopes: [], problems: [] };
  const raw = parseJsonOrNull(file) as { schema?: unknown; scopes?: unknown } | null;
  if (raw === null) return { scopes: [], problems: [`${SCOPES_FILE} is not valid JSON`] };
  if (raw.schema !== SCOPES_SCHEMA) {
    return { scopes: [], problems: [`${SCOPES_FILE} must declare "schema": "${SCOPES_SCHEMA}" (found ${JSON.stringify(raw.schema)})`] };
  }
  if (!Array.isArray(raw.scopes) || raw.scopes.length === 0) {
    return { scopes: [], problems: [`${SCOPES_FILE} must declare a non-empty "scopes" array — an empty declaration is ambiguous, so delete the file instead`] };
  }
  const problems: string[] = [];
  const out: DeclaredScope[] = [];
  const seen = new Set<string>();
  for (const [i, entry] of raw.scopes.entries()) {
    const at = `${SCOPES_FILE} scopes[${i}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      problems.push(`${at} must be an object { path, ecosystem }`); continue;
    }
    const { path: p, ecosystem } = entry as { path?: unknown; ecosystem?: unknown };
    if (typeof ecosystem !== 'string' || ADAPTERS[ecosystem] === undefined) {
      problems.push(`${at}: ecosystem ${JSON.stringify(ecosystem)} is not one Canary can model (known: ${Object.keys(ADAPTERS).sort().join(', ')})`);
      continue;
    }
    const bad = scopePathProblem(p);
    if (bad !== null) { problems.push(`${at}: ${bad}`); continue; }
    const relPath = p as string;
    const key = `${relPath}::${ecosystem}`;
    if (seen.has(key)) { problems.push(`${at}: "${relPath}" is declared twice for ecosystem "${ecosystem}"`); continue; }
    seen.add(key);
    const dir = path.join(root, ...relPath.split('/'));
    let isDir = false;
    try { isDir = fs.statSync(dir).isDirectory(); } catch { isDir = false; }
    if (!isDir) { problems.push(`${at}: "${relPath}" is not a directory in this repository`); continue; }
    // A declaration that detects nothing is a declaration Canary cannot honour.
    // It is refused rather than recorded as an empty scope: the human asked for
    // these checks, and silently shipping a plan without them is the failure
    // mode this whole feature exists to prevent.
    if (!ADAPTERS[ecosystem]!.detect(dir).detected) {
      problems.push(`${at}: "${relPath}" is declared as ecosystem "${ecosystem}" but nothing there declares it — Canary will not invent a check`);
      continue;
    }
    out.push({ path: relPath, ecosystem });
  }
  return { scopes: out, problems };
}

/**
 * The scope set a declaration names: the repo root when it declares something
 * (1.0 semantics, unchanged), plus each declared scope.
 *
 * Sorted by path, not by declaration order, so that merely reordering the
 * declaration cannot change the sealed plan — a cosmetic edit must never
 * invalidate a seal or, worse, silently re-order authority.
 */
export function scopesForDeclaration(root: string, declared: readonly DeclaredScope[]): ProjectScope[] {
  const out: ProjectScope[] = [];
  if (nodeAdapter.detect(root).detected) out.push({ adapter: nodeAdapter, scope: '' });
  const sorted = [...declared].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1
    : (a.ecosystem < b.ecosystem ? -1 : a.ecosystem > b.ecosystem ? 1 : 0)));
  for (const d of sorted) out.push({ adapter: ADAPTERS[d.ecosystem]!, scope: d.path });
  return out;
}

/** The whole repository's plan: every declaring ecosystem at the ROOT, as one
 *  sealed plan. An empty plan is a complete answer (setup turns it into NEEDS
 *  ATTENTION), never a reason to invent a check.
 *
 *  TWO MODES, and only two:
 *   - NO declaration (`canary.scopes.json` absent): ROOT ONLY, depth 0. Walking
 *     would let a directory the user does not consider part of the project add
 *     checks to it — `archive/python-golden-prototype/pyproject.toml` would
 *     silently contribute a pytest step to this very repository.
 *   - DECLARATION present: EXACTLY the declared scopes (plus the root when it
 *     declares something). Nothing is walked, so an undeclared `vendor/`,
 *     `archive/` or `examples/` tree can never add authority.
 *
 *  A declaration Canary cannot honour is returned as `problems` and the caller
 *  refuses; it is never partially applied. */
export function composePlan(root: string, maxDepth = 0): CompositePlan {
  const decl = readScopeDeclaration(root);
  if (decl.problems.length) {
    return { scopes: [], plan: [], notes: [], empty: [], scopeSource: 'declared', problems: decl.problems };
  }
  const declared = decl.scopes.length > 0;
  const scopes = declared ? scopesForDeclaration(root, decl.scopes) : discoverScopes(root, maxDepth);
  const plan: PlanStep[] = [];
  const notes: string[] = [];
  const empty: string[] = [];
  for (const s of scopes) {
    const disc = planForScope(root, s);
    const where = s.scope || '.';
    if (disc.plan.length === 0) {
      empty.push(`${where} (${s.adapter.id}): ${disc.note}`);
      continue;
    }
    notes.push(`${where} (${s.adapter.id}): ${disc.note}`);
    plan.push(...disc.plan);
  }
  return { scopes, plan, notes, empty, scopeSource: declared ? 'declared' : 'root-only', problems: [] };
}

/**
 * The adapter that owns one plan step: the step's own `adapter` when it has one
 * (every 1.1 step does), else the configured project, else Node — the exact
 * 1.0 resolution. One function, so no caller can invent a different rule.
 */
export function adapterForStep(cfg: { project?: string }, step: PlanStep): ProjectAdapter {
  return adapterFor(step.adapter !== undefined ? { project: step.adapter } : cfg);
}

/** The directory a step runs in: its scope under the repo root, or the root. */
export function scopeDir(root: string, step: PlanStep): string {
  return step.scope ? path.join(root, ...step.scope.split('/')) : root;
}

/** Plan problems across ecosystems: each step is judged by its OWN adapter in
 *  its OWN scope, so a Python step is never checked against package.json. For a
 *  1.0 config this is the same list the single Node adapter produced. */
export function planProblemsForConfig(root: string, cfg: { project?: string }, plan: PlanStep[]): string[] {
  const problems: string[] = [];
  for (const step of plan) problems.push(...adapterForStep(cfg, step).planProblems(scopeDir(root, step), [step]));
  return problems;
}
