/**
 * 1.1 §12–17 — the non-Node ecosystems, as DECLARATIONS rather than pipelines.
 *
 * One verification core, several ecosystems: everything here is pure local
 * reading (no spawn, no write, no agent provider), and every adapter answers the
 * SAME ProjectAdapter questions the Node adapter answers. There is no per-
 * language plan/seal/drift path — the shared helpers in project.ts own those, so
 * a new ecosystem is a table entry plus a discovery function, never a fork.
 *
 * The rule that shapes all of it (master directive, and Canary's own doctrine):
 * **discovery invents nothing.** A check appears only when the project actually
 * declares it — a config section, a declared tool, or a conventional test
 * directory the tooling would itself discover. "Python files exist" is not a
 * reason to run pytest, and an empty plan stays a complete, honest answer that
 * `setup`/`status` already convert into NEEDS ATTENTION rather than READY.
 *
 * Plans are argv steps (see PlanStep.argv): the exact command is data, sealed at
 * setup and spawned verbatim later. `script` remains the stable human LABEL
 * (`pytest`, `cargo test`), which is what proof bindings and drift messages use.
 *
 * Program resolution is deliberately NOT an adapter concern: an adapter names
 * the programs its checks need, and setup pins them to absolute paths at the one
 * human-authorized moment (never a PATH lookup at verification time).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  assertStepArgv, planAuthorityDrift, sealPlanAuthority,
  type PlanKind, type PlanStep, type PlanAuthority, type ProjectAdapter,
  type ProjectDetection, type DiscoveredProject, type AuthorityCarrier,
} from './project.js';
import { universalAdapter } from './universal.js';

const readText = (file: string): string | null => {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
};
const has = (root: string, ...names: string[]): boolean => names.some((n) => fs.existsSync(path.join(root, n)));
/** Is any immediate entry of `dir` a file matching `re`? (one level, no walk) */
function dirHas(root: string, dir: string, re: RegExp): boolean {
  try { return fs.readdirSync(path.join(root, dir)).some((f) => re.test(f)); } catch { return false; }
}

/** A discovered check: the label that identifies it, and the exact command. */
interface EcoCheck { kind: PlanKind; script: string; argv: string[] }

/** What one ecosystem declares. `discover` returns null when the ecosystem is
 *  not present here; an ecosystem that is present but declares nothing returns
 *  an empty check list, which is a complete and honest answer. */
interface Ecosystem {
  id: string;
  describe: string;
  /** Files whose presence means "this ecosystem is here". */
  manifests: readonly string[];
  /** Base names whose change means the dependency set moved (M6 signal). */
  dependencyPaths: readonly string[];
  /** Programs the checks need; setup pins these to absolute paths. */
  programs: readonly string[];
  discover(root: string): { checks: EcoCheck[]; note: string; reason: string; confidence: 'high' | 'medium' | 'low' } | null;
  /**
   * Absolute directories this ecosystem's programs may be resolved from, in
   * addition to the baseline trusted dirs. Computed (not static) for ecosystems
   * whose toolchain location depends on rustup's own home variables.
   */
  trustedProgramDirs?: readonly string[];
  /**
   * Environment this ecosystem's programs need under Canary's SANITIZED env, or
   * undefined when they need none (see `ProjectAdapter.toolchainEnv`).
   *
   * Measured, not speculative: under the sanitized env Go aborts with
   * `build cache is required, but could not be located: GOCACHE is not defined
   * and %LocalAppData% is not defined`, and declaring a workspace-scoped
   * GOCACHE/GOPATH was VERIFIED to make `go test` and `go test -json` run inside
   * a Canary step (tooling/probes/runner-channels-rust-go.mjs).
   */
  toolchainEnv?(ctx: { dir: string; workspace: string }): Record<string, string>;
}

/** Comment and prose lines removed. A tool named in a sentence is not a
 *  declaration, and getting this wrong fails in the worst direction: the
 *  examples smoke probe caught a project whose pyproject.toml SAID "no pytest
 *  declaration" in a comment, and Canary then ran pytest on it and failed the
 *  project for not having pytest installed. */
function declarationText(raw: string): string {
  return raw
    .split(/\r?\n/)
    .filter((line) => !/^\s*[#;]/.test(line))                 // whole-line comments
    .map((line) => line.replace(/\s+[#;].*$/, ''))            // trailing comments
    .filter((line) => !/^\s*(?:description|readme|long_description|keywords|classifiers|authors)\s*=/.test(line)) // prose values
    .join('\n');
}

/** Is `tool` DECLARED here — a section, or a dependency entry — rather than
 *  merely mentioned? Each shape below is a real declaration; nothing else is. */
function declaresTool(text: string, tool: string): boolean {
  const t = tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp([
    `\\[tool\\.${t}`,                                // pyproject: [tool.ruff]
    `\\[tool:${t}`,                                  // setup.cfg / tox.ini: [tool:pytest]
    `^\\s*\\[${t}(?:\\]|\\.)`,                       // ini section: [pytest]
    `(?:^|\\n)\\s*["']?${t}["']?\\s*(?:[<>=~!,\\[\\]]|$)`, // dependency line: pytest>=7 / pytest / "pytest"
    `["']${t}["']`,                                  // quoted dependency entry: dev = ["pytest"]
    `(?:^|\\n)\\s*${t}\\s*=`,                        // Pipfile / setup.cfg key: pytest = "*"
  ].join('|'), 'im').test(text);
}

// ---------------------------------------------------------------- Python ----
// Conservative on purpose. `pytest` must be DECLARED (a config section or a
// dependency mention), and `unittest` is accepted only from a real test-layout
// convention. Static analysis (mypy/pyright/ruff) maps to the `typecheck` kind
// because that is the kind the obligation engine already understands as "a
// static check ran"; the step label keeps naming the actual tool, so no display
// ever claims ruff is a type checker.
// Tool-config files count as manifests too: a repository whose only Python
// declaration is `pytest.ini` (or a ruff/mypy config) plus .py sources IS a
// Python project, and refusing to see it would report UNSUPPORTED on a project
// Canary can verify perfectly well. Note `declares()` below still requires a
// real declaration — this list only decides whether the ecosystem is present.
const PY_MANIFESTS = ['pyproject.toml', 'setup.py', 'setup.cfg', 'tox.ini', 'Pipfile', 'requirements.txt',
  'pytest.ini', 'mypy.ini', 'ruff.toml', '.ruff.toml', 'pyrightconfig.json'] as const;
const PY_DEPS = ['pyproject.toml', 'poetry.lock', 'uv.lock', 'Pipfile', 'Pipfile.lock', 'requirements.txt', 'setup.cfg', 'setup.py'] as const;

const pythonEcosystem: Ecosystem = {
  id: 'python',
  describe: 'Python project (checks declared in pyproject.toml / setup.cfg / tox.ini / requirements)',
  manifests: PY_MANIFESTS,
  dependencyPaths: PY_DEPS,
  programs: ['python'],
  discover(root) {
    if (!has(root, ...PY_MANIFESTS)) return null;
    // Every declaration source we read, plus requirements*.txt by name pattern.
    const sources = ['pyproject.toml', 'setup.cfg', 'tox.ini', 'Pipfile', 'requirements.txt', 'requirements-dev.txt', 'dev-requirements.txt']
      .map((f) => readText(path.join(root, f)) ?? '');
    try {
      for (const f of fs.readdirSync(root)) if (/^requirements.*\.txt$/i.test(f)) sources.push(readText(path.join(root, f)) ?? '');
    } catch { /* unreadable root: the manifest gate above already answered */ }
    const text = declarationText(sources.join('\n'));
    const declares = (tool: string): boolean => declaresTool(text, tool);

    const checks: EcoCheck[] = [];
    const pytestDeclared = declares('pytest') || has(root, 'pytest.ini');
    const testsDir = ['tests', 'test'].find((d) => dirHas(root, d, /^(test_.*|.*_test)\.py$/i));
    if (pytestDeclared) checks.push({ kind: 'tests', script: 'pytest', argv: ['python', '-m', 'pytest'] });
    else if (/\[testenv/i.test(text)) checks.push({ kind: 'tests', script: 'tox', argv: ['tox'] });
    else if (testsDir) checks.push({ kind: 'tests', script: 'unittest', argv: ['python', '-m', 'unittest', 'discover', '-v'] });

    if (declares('mypy')) checks.push({ kind: 'typecheck', script: 'mypy', argv: ['python', '-m', 'mypy', '.'] });
    else if (declares('pyright')) checks.push({ kind: 'typecheck', script: 'pyright', argv: ['pyright'] });
    else if (declares('ruff')) checks.push({ kind: 'typecheck', script: 'ruff', argv: ['python', '-m', 'ruff', 'check', '.'] });

    const head = has(root, 'pyproject.toml') ? 'pyproject.toml' : PY_MANIFESTS.find((m) => has(root, m)) ?? 'python manifest';
    if (checks.length === 0) {
      return { checks, note: `${head} found, but no test or static-check tool is declared`, reason: `${head} found (no checks declared)`, confidence: 'medium' };
    }
    return { checks, note: `${head} found`, reason: `${head} found`, confidence: has(root, 'pyproject.toml') ? 'high' : 'medium' };
  },
};

// ------------------------------------------------------------------ Rust ----
// Cargo itself is the declaration: `cargo test`/`cargo check` are the toolchain's
// own commands for a crate that has tests and a manifest. clippy stays OUT unless
// the project configures it (it is a separate component and not always
// installed); `cargo check` already occupies the static-check kind.
const rustEcosystem: Ecosystem = {
  id: 'rust',
  describe: 'Rust project (checks declared by Cargo.toml)',
  manifests: ['Cargo.toml'],
  dependencyPaths: ['Cargo.toml', 'Cargo.lock'],
  programs: ['cargo'],
  /**
   * Rust's toolchain lives OUTSIDE the OS-managed dirs, and the PATH entry rustup
   * installs is a PROXY that cannot run under Canary's sanitized environment
   * (measured: "rustup could not choose a version of cargo to run" once
   * RUSTUP_HOME/HOME are redirected), while the REAL toolchain binary needs no
   * environment and runs fine. So the adapter declares the literal locations a
   * rustup install keeps its toolchains in, and setup prefers them: sealing a
   * proxy would seal a step that can never execute.
   *
   * `RUSTUP_HOME`/`CARGO_HOME` are honored when set, because that is rustup's own
   * documented way to relocate them (and how this repository's workspace-local
   * toolchain is declared).
   */
  get trustedProgramDirs(): readonly string[] {
    const homes = [
      process.env.RUSTUP_HOME?.trim() || path.join(os.homedir(), '.rustup'),
      process.env.CARGO_HOME?.trim() || path.join(os.homedir(), '.cargo'),
    ];
    const dirs: string[] = [];
    for (const home of homes) {
      dirs.push(path.join(home, 'bin'));
      try {
        for (const tc of fs.readdirSync(path.join(home, 'toolchains'))) dirs.push(path.join(home, 'toolchains', tc, 'bin'));
      } catch { /* no toolchains dir: PATH stays the fallback */ }
    }
    return dirs;
  },
  discover(root) {
    const manifest = readText(path.join(root, 'Cargo.toml'));
    if (manifest === null) return null;
    const isWorkspace = /^\s*\[workspace\]/m.test(manifest);
    const checks: EcoCheck[] = [
      { kind: 'tests', script: 'cargo test', argv: ['cargo', 'test'] },
      { kind: 'typecheck', script: 'cargo check', argv: ['cargo', 'check'] },
    ];
    if (has(root, path.join('src', 'main.rs'), path.join('src', 'lib.rs'))) {
      checks.push({ kind: 'build', script: 'cargo build', argv: ['cargo', 'build'] });
    }
    if (has(root, 'clippy.toml', '.clippy.toml')) {
      // Configured, but the static-check kind is taken by `cargo check`; say so
      // rather than silently dropping it or running two checks under one kind.
      return { checks, note: 'Cargo.toml found (clippy configured but `cargo check` already holds the static-check step)', reason: 'Cargo.toml found', confidence: 'high' };
    }
    return { checks, note: `Cargo.toml found${isWorkspace ? ' (workspace)' : ''}`, reason: 'Cargo.toml found', confidence: 'high' };
  },
};

// -------------------------------------------------------------------- Go ----
// go.mod/go.work IS the declaration: `go test ./...` and `go vet ./...` are the
// toolchain's own scope-respecting commands. The module/workspace scope is the
// directory that holds the manifest, which is why this adapter is always run
// against that directory (see the composite plan) rather than the repo root.
const goEcosystem: Ecosystem = {
  id: 'go',
  describe: 'Go module or workspace (checks declared by go.mod / go.work)',
  manifests: ['go.mod', 'go.work'],
  dependencyPaths: ['go.mod', 'go.sum', 'go.work', 'go.work.sum'],
  programs: ['go'],
  // The one ecosystem whose toolchain cannot run under Canary's sanitized env
  // without a declaration: Go derives its build cache from HOME/%LocalAppData%,
  // and both are redirected. Workspace-scoped, so `sanitizedEnv` accepts it and a
  // project cannot steer it.
  toolchainEnv: ({ workspace }) => ({
    GOCACHE: path.join(workspace, 'canary-toolchain', 'go-build'),
    GOPATH: path.join(workspace, 'canary-toolchain', 'go-path'),
    // Never let a step silently download a different toolchain mid-verification.
    GOTOOLCHAIN: 'local',
  }),
  discover(root) {
    if (!has(root, 'go.mod', 'go.work')) return null;
    const checks: EcoCheck[] = [
      { kind: 'tests', script: 'go test', argv: ['go', 'test', './...'] },
      { kind: 'typecheck', script: 'go vet', argv: ['go', 'vet', './...'] },
    ];
    const workspace = has(root, 'go.work');
    return { checks, note: `${workspace ? 'go.work' : 'go.mod'} found`, reason: `${workspace ? 'go.work' : 'go.mod'} found`, confidence: 'high' };
  },
};

/** A program's DECLARED identity: its base name without a Windows shim
 *  extension. Setup pins argv[0] to an absolute path, so a later re-discovery
 *  (which sees the declared name again) must still recognize the same check —
 *  comparing the raw strings would report every python/rust/go plan as
 *  no-longer-declared the moment it was pinned. */
const programIdentity = (p: string): string => path.basename(p).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();

/** Is this discovered declaration the same check the plan sealed? The program
 *  is compared by identity and everything AFTER it byte-for-byte: the sealed
 *  authority is the command, and only the pin may legitimately differ. */
function sameDeclaration(declared: EcoCheck, sealed: PlanStep): boolean {
  if (sealed.argv === undefined) return false;
  if (declared.kind !== sealed.kind || declared.script !== sealed.script) return false;
  const a = declared.argv;
  const b = sealed.argv;
  return a.length === b.length
    && programIdentity(a[0] as string) === programIdentity(b[0] as string)
    && JSON.stringify(a.slice(1)) === JSON.stringify(b.slice(1));
}

/**
 * Build a ProjectAdapter from an ecosystem declaration.
 *
 * Drift and sealing reuse the SHARED helpers, so an argv plan is sealed and
 * drift-checked by exactly the same code that guards a Node script plan. The
 * only ecosystem-specific question left is "does the project still declare
 * this check?", answered by re-running discovery — a plan problem is reported,
 * never silently repaired.
 */
export function commandAdapter(eco: Ecosystem): ProjectAdapter {
  const discoverStep = (root: string): EcoCheck[] => eco.discover(root)?.checks ?? [];
  return {
    id: eco.id,
    // Passed through so the executor can put the toolchain's own needs into the
    // child environment; absent for ecosystems that need none.
    ...(eco.toolchainEnv !== undefined ? { toolchainEnv: eco.toolchainEnv } : {}),
    detect(root): ProjectDetection {
      const found = eco.discover(root);
      if (found === null) return { detected: false, confidence: 'high', reason: `no ${eco.manifests.join(' / ')}` };
      return { detected: true, confidence: found.confidence, reason: found.reason };
    },
    discoverChecks(root): DiscoveredProject {
      const found = eco.discover(root);
      const plan: PlanStep[] = (found?.checks ?? []).map((c) => ({
        kind: c.kind, script: c.script, adapter: eco.id, argv: [...c.argv],
      }));
      // source is empty on purpose: an argv step's sealed authority is its own
      // command, so there is no external script text to digest.
      return { pm: eco.id, note: found?.note ?? `${eco.manifests.join(' / ')} not found`, plan, source: {} };
    },
    validateEnvironment(pm) {
      return pm === eco.id
        ? null
        : `runner "${pm}" is not this project's ecosystem (${eco.id})`;
    },
    describe() { return eco.describe; },
    seal(plan: PlanStep[], _source: Record<string, unknown>, bindings?: unknown): PlanAuthority {
      return sealPlanAuthority(plan, {}, bindings);
    },
    drift(root: string, cfg: AuthorityCarrier): string | null {
      return planAuthorityDrift(root, cfg);
    },
    planProblems(root: string, plan: PlanStep[]): string[] {
      const declared = discoverStep(root);
      const problems: string[] = [];
      for (const s of plan) {
        if (!declared.some((c) => sameDeclaration(c, s))) {
          problems.push(`plan references the ${eco.id} check "${s.script}" which this project no longer declares`);
        }
      }
      return problems;
    },
    stepArgv(_pm, step) {
      if (step.argv === undefined) throw new Error(`${eco.id} plan step "${step.script}" carries no argv — this build never synthesizes one`);
      return assertStepArgv(step.argv);
    },
    dependencyPaths: eco.dependencyPaths,
    // Absolute sealed paths are the authority; setup pins them, so no
    // conventional-directory guessing happens at verification time. An ecosystem
    // whose toolchain lives outside the OS-managed dirs still declares its
    // literal locations HERE, for setup to prefer over a PATH proxy.
    trustedProgramDirs: eco.trustedProgramDirs ?? [],
  };
}

export const pythonAdapter = commandAdapter(pythonEcosystem);
export const rustAdapter = commandAdapter(rustEcosystem);
export const goAdapter = commandAdapter(goEcosystem);

/** The NATIVE ecosystems: the ones Canary has ecosystem-specific discovery for. */
export const NATIVE_ADAPTERS: readonly ProjectAdapter[] = [pythonAdapter, rustAdapter, goAdapter];

/**
 * Registered in this order when several ecosystems share a repository root.
 *
 * `universal` is appended LAST and claims only a directory no native adapter
 * claimed, so a project Canary has native discovery for always keeps its native
 * path. It is what makes an unknown ecosystem a SUPPORTED project rather than an
 * unsupported one — with an honest observation ceiling (an unknown runner can
 * never earn a strong label; see the runner registry).
 */
export const ECOSYSTEM_ADAPTERS: readonly ProjectAdapter[] = [...NATIVE_ADAPTERS, universalAdapter];
