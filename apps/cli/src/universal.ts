/**
 * THE UNIVERSAL PROJECT CONTRACT (v1.1) — Canary at the project level without
 * knowing a programming language.
 *
 * WHY THIS EXISTS. Canary's native adapters (Node, Python, Rust, Go) each know how
 * one ecosystem declares its checks. Everything else — C/C++, C#/.NET, Java/Kotlin,
 * Swift, Zig, PHP, Ruby, Elixir — had no path at all, not because Canary could not
 * verify them but because nothing could TELL Canary what their commands are. So a
 * repository becomes verifiable through two doors:
 *
 *   1. DISCOVERY (the normal path): Canary reads the project's EXISTING, EXECUTABLE
 *      truth — its CI workflow commands, its Makefile/Taskfile/justfile targets, its
 *      CMake/CTest/Meson configuration, its Gradle/Maven/dotnet/Swift/Zig/PHP/Ruby
 *      declarations — and proposes the plan those artifacts anchor. The user does not
 *      need to know their build system, or Canary's adapter model, or that this file
 *      exists.
 *   2. THE MANIFEST (the escape hatch and the explicit-authority format):
 *      `canary.project.json`, for a repository whose commands are not discoverable,
 *      or whose author wants to state them exactly.
 *
 * NOTHING IS INVENTED. A command is proposed only when a repository artifact anchors
 * it: a target that literally exists, a line the project itself runs in CI, a test
 * registration in its build files, or a wrapper the repository ships. Convention
 * alone (a `.gradle` file implying "there is probably a test task") is a WEAKER
 * anchor and is recorded as such in the evidence. When two equally-anchored
 * interpretations claim the same check kind, Canary does NOT pick: it reports one
 * concise clarification and seals nothing.
 *
 * WHAT IT CANNOT DO, stated here rather than discovered later:
 *   - It cannot make an unknown runner STRONG. A discovered `ctest` is observed by
 *     the runner registry as `unknown` ⇒ INCONCLUSIVE_ONLY, so a VALID execution
 *     observation is unreachable and rule 14 keeps strong labels out. Exit status,
 *     argv, executable identity and candidate binding are all still proven; the
 *     runner's INTERNALS are not. That is the honest ceiling of a universal adapter,
 *     and `universalContractLevels()` reports it as data.
 *   - It cannot introduce a shell. argv arrays only, spawned `shell: false`.
 *   - It cannot introduce environment. A manifest-declared `env` is REFUSED, not
 *     merged: the narrow allowlisted toolchain door belongs to reviewed adapter code,
 *     never to project input (audit F9's rule, kept).
 *   - It cannot point a step at an arbitrary working directory. `cwd` is expressed as
 *     a SCOPE, which is validated to be a contained directory and SEALED with the
 *     plan; a per-check `cwd` is refused for exactly that reason.
 */
import fs from 'node:fs';
import path from 'node:path';

import { TOOLCHAIN_ENV_KEYS } from '@canary-rn/support';

import {
  assertStepArgv, parseJsonOrNull, planAuthorityDrift, sealPlanAuthority,
  type AuthorityCarrier, type DiscoveredProject, type PlanAuthority, type PlanStep,
  type ProjectAdapter, type ProjectDetection, type PlanKind,
} from './project.js';

/** The explicit-authority manifest (the escape hatch, never required). */
export const UNIVERSAL_MANIFEST = 'canary.project.json';
export const UNIVERSAL_MANIFEST_SCHEMA = 'canary-project/1';

/** What the capability levels mean, as data, so no surface has to remember them. */
export interface ContractLevels {
  /** Any command-driven project: representable through this contract. */
  universal: string;
  /** Canary has ecosystem-specific discovery/defaults for it. */
  native: string[];
  /** Canary has runner-specific execution observation for it. */
  observed: string[];
  /** Canary has sufficient independent observation AND binding for it. */
  strong: string[];
}

export function universalContractLevels(): ContractLevels {
  return {
    universal: 'argv-based checks addressed by an explicit, sealed plan: exit status, executable identity, working directory, candidate binding and authority drift are all PROVEN for any command-driven project, however unusual',
    native: ['node', 'python', 'rust', 'go'],
    observed: ['python-unittest', 'pytest', 'node-test', 'mocha'],
    strong: ['mocha', 'node-test', 'pytest', 'unittest'],
  };
}

// ─────────────────────────── the manifest ───────────────────────────

interface ManifestCheck { kind: PlanKind; name: string; argv: string[] }
interface ManifestScope { path: string; checks: ManifestCheck[] }

const PLAN_KINDS: readonly PlanKind[] = ['tests', 'build', 'typecheck', 'bench', 'e2e'];

/** The kinds a universal check may declare. A universal check can be a test, a
 *  build, a type check or a lint; anything else is not a verification kind Canary
 *  has an obligation model for, so it is refused rather than invented. */
function asPlanKind(v: unknown): PlanKind | null {
  return typeof v === 'string' && (PLAN_KINDS as readonly string[]).includes(v) ? v as PlanKind : null;
}

/** Programs a check may NOT be: they make argv a shell in disguise. Kept in sync
 *  with the executor's own wrapper refusal by reusing the same idea, not the same
 *  list — the executor denies what a SPEC may execute; this denies what a PROJECT
 *  may declare, and a project has no business naming any of these at all. */
const SHELL_WRAPPERS = new Set([
  'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe',
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh',
  'env', 'xargs', 'nohup', 'sudo', 'doas', 'pkexec', 'wsl', 'wsl.exe', 'sh -c',
]);

function argvProblem(argv: unknown, at: string): string | null {
  if (!Array.isArray(argv) || argv.length === 0) return `${at}: "argv" must be a non-empty array of strings`;
  if (!argv.every((a) => typeof a === 'string' && a.length > 0)) return `${at}: every "argv" entry must be a non-empty string`;
  const head = path.basename(String(argv[0])).toLowerCase();
  if (SHELL_WRAPPERS.has(head)) {
    return `${at}: "${argv[0]}" is a shell or wrapper — the universal contract takes an argv ARRAY and never a command line, so a shell here would be the escape hatch this format exists to prevent`;
  }
  for (const a of argv as string[]) {
    if (a.includes('\0') || /[\r\n]/.test(a)) return `${at}: an argv entry contains a control character`;
    // `$...` tokens are Canary's own spec vocabulary; a project manifest does not
    // get to name them.
    if (a.startsWith('$')) return `${at}: "${a}" starts with '$' — that is Canary's own spec token vocabulary, not a command`;
  }
  return null;
}

export interface UniversalManifestRead {
  manifest: { scopes: ManifestScope[] } | null;
  problems: string[];
}

/**
 * Read + validate `canary.project.json`. Every problem is a REFUSAL, never a
 * silently dropped check: a manifest Canary cannot honour must stop setup rather
 * than seal a plan that quietly omits what the author declared.
 */
export function readUniversalManifest(root: string): UniversalManifestRead {
  const file = path.join(root, UNIVERSAL_MANIFEST);
  if (!fs.existsSync(file)) return { manifest: null, problems: [] };
  const raw = parseJsonOrNull(file) as { schema?: unknown; scopes?: unknown } | null;
  if (raw === null) return { manifest: null, problems: [`${UNIVERSAL_MANIFEST} is not valid JSON`] };
  if (raw.schema !== UNIVERSAL_MANIFEST_SCHEMA) {
    return { manifest: null, problems: [`${UNIVERSAL_MANIFEST} must declare "schema": "${UNIVERSAL_MANIFEST_SCHEMA}" (found ${JSON.stringify(raw.schema)})`] };
  }
  if (!Array.isArray(raw.scopes) || raw.scopes.length === 0) {
    return { manifest: null, problems: [`${UNIVERSAL_MANIFEST} must declare a non-empty "scopes" array — an empty declaration is ambiguous, so delete the file instead`] };
  }
  const problems: string[] = [];
  const scopes: ManifestScope[] = [];
  const seenScope = new Set<string>();
  for (const [i, entry] of raw.scopes.entries()) {
    const at = `${UNIVERSAL_MANIFEST} scopes[${i}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) { problems.push(`${at} must be an object { path, checks }`); continue; }
    const { path: p, checks } = entry as { path?: unknown; checks?: unknown };
    if (typeof p !== 'string' || p === '') { problems.push(`${at}: "path" must be a non-empty repository-relative directory (use "." for the repository root)`); continue; }
    if (path.isAbsolute(p) || p.split(/[\\/]/).includes('..')) { problems.push(`${at}: "path" must not be absolute or contain ".." — a check may not run outside the repository`); continue; }
    const rel = p === '.' ? '' : p.split('\\').join('/');
    if (seenScope.has(rel)) { problems.push(`${at}: "${p}" is declared twice`); continue; }
    let isDir = false;
    try { isDir = fs.statSync(rel === '' ? root : path.join(root, ...rel.split('/'))).isDirectory(); } catch { isDir = false; }
    if (!isDir) { problems.push(`${at}: "${p}" is not a directory in this repository`); continue; }
    if (!Array.isArray(checks) || checks.length === 0) { problems.push(`${at}: "checks" must be a non-empty array`); continue; }
    const out: ManifestCheck[] = [];
    for (const [j, c] of checks.entries()) {
      const cat = `${at}.checks[${j}]`;
      if (typeof c !== 'object' || c === null || Array.isArray(c)) { problems.push(`${cat} must be an object { name, kind, argv }`); continue; }
      const { name, kind, argv, cwd, env } = c as { name?: unknown; kind?: unknown; argv?: unknown; cwd?: unknown; env?: unknown };
      if (env !== undefined) {
        problems.push(`${cat}: "env" is not part of the universal contract — project-supplied environment is exactly the arbitrary-env escape this format refuses; a toolchain variable belongs to reviewed adapter code (allowlisted keys: ${[...TOOLCHAIN_ENV_KEYS].sort().join(', ')})`);
        continue;
      }
      if (cwd !== undefined) {
        problems.push(`${cat}: "cwd" is not part of the universal contract — express a different working directory as its own scope entry, so it is validated and SEALED with the plan instead of being an unsealed per-check detail`);
        continue;
      }
      if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
        problems.push(`${cat}: "name" must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`); continue;
      }
      const k = asPlanKind(kind);
      if (k === null) { problems.push(`${cat}: "kind" must be one of ${PLAN_KINDS.join(', ')} (found ${JSON.stringify(kind)})`); continue; }
      const bad = argvProblem(argv, cat);
      if (bad !== null) { problems.push(bad); continue; }
      out.push({ kind: k, name, argv: (argv as string[]).map((a) => a) });
    }
    if (out.length === 0) { problems.push(`${at}: no usable check remained after validation`); continue; }
    const names = new Set<string>();
    for (const c of out) {
      if (names.has(c.name)) problems.push(`${at}: check name "${c.name}" is declared twice`);
      names.add(c.name);
    }
    // Sorted by name so a cosmetic reordering cannot change the sealed plan.
    scopes.push({ path: rel, checks: out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) });
    seenScope.add(rel);
  }
  if (problems.length > 0) return { manifest: null, problems };
  return { manifest: { scopes: scopes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) }, problems: [] };
}

// ─────────────────────────── discovery ───────────────────────────

/** One discovered check and the repository evidence that anchors it. */
export interface DiscoveredCheck {
  kind: PlanKind;
  script: string;
  argv: string[];
  /** The artifact that made this a fact rather than a guess. */
  evidence: string;
  /**
   * How strong the anchor is.
   *  - declared   the project's own entry point states it (a manifest, a Makefile
   *               target, a Taskfile/justfile target, a shipped wrapper)
   *  - configured the build/test system is CONFIGURED for it (a registered test, a
   *               CMake cache that names a build tree)
   *  - observed   the project RUNS it in its own CI, verbatim
   *  - convention the ecosystem's normal command, with no repository statement
   *               beyond the ecosystem being present (the weakest; last resort)
   */
  anchor: 'declared' | 'configured' | 'observed' | 'convention';
}

export interface UniversalDiscovery {
  checks: DiscoveredCheck[];
  /** Trees an existing build directory gives us, for build/test commands. */
  notes: string[];
  /** Set when two equally-anchored interpretations claim the same kind. */
  ambiguity?: string;
}

function readIfPresent(root: string, rel: string): string | null {
  try { return fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8'); } catch { return null; }
}
function has(root: string, rel: string): boolean {
  try { return fs.statSync(path.join(root, ...rel.split('/'))).isFile(); } catch { return false; }
}
function dirEntries(root: string, rel = '.'): string[] {
  try { return fs.readdirSync(rel === '.' ? root : path.join(root, ...rel.split('/'))).sort(); } catch { return []; }
}
function isDir(root: string, rel: string): boolean {
  try { return fs.statSync(path.join(root, ...rel.split('/'))).isDirectory(); } catch { return false; }
}

/** A build directory that ALREADY EXISTS and is configured by a known system. */
function configuredBuildDirs(root: string): { dir: string; system: 'cmake' | 'meson' | 'ninja' }[] {
  const out: { dir: string; system: 'cmake' | 'meson' | 'ninja' }[] = [];
  const candidates = ['build', 'out', 'cmake-build-debug', 'cmake-build-release', 'builddir', '_build'];
  for (const d of candidates) {
    if (!isDir(root, d)) continue;
    if (has(root, `${d}/CMakeCache.txt`)) out.push({ dir: d, system: 'cmake' });
    else if (has(root, `${d}/build.ninja`) && has(root, `${d}/meson-info/intro-projectinfo.json`)) out.push({ dir: d, system: 'meson' });
    else if (has(root, `${d}/build.ninja`)) out.push({ dir: d, system: 'ninja' });
  }
  return out;
}

/** Does any CMake source register a test? That is the difference between "ctest
 *  would run nothing" and "this project has tests ctest can run". */
function cmakeRegistersTests(root: string): boolean {
  const files = ['CMakeLists.txt', ...dirEntries(root).filter((f) => f.endsWith('.cmake'))];
  for (const f of files) {
    const text = readIfPresent(root, f);
    if (text !== null && /(^|\n)\s*(enable_testing\s*\(|add_test\s*\(|gtest_discover_tests\s*\()/.test(text)) return true;
  }
  return false;
}

/** Makefile targets that literally exist. */
function makeTargets(text: string): Set<string> {
  const out = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*:(?!=)/.exec(line);
    if (m) out.add(m[1]!);
  }
  return out;
}

/** `run:` commands a CI workflow actually executes, with the file that says so. */
function ciCommands(root: string): { file: string; command: string }[] {
  const out: { file: string; command: string }[] = [];
  const files: string[] = [];
  for (const f of dirEntries(root, '.github/workflows')) {
    if (/\.ya?ml$/i.test(f)) files.push(`.github/workflows/${f}`);
  }
  for (const f of ['.gitlab-ci.yml', 'azure-pipelines.yml', 'bitbucket-pipelines.yml', '.circleci/config.yml']) {
    if (has(root, f)) files.push(f);
  }
  for (const f of files) {
    const text = readIfPresent(root, f);
    if (text === null) continue;
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*-?\s*run\s*:\s*(.+?)\s*$/.exec(line) ?? /^\s*(?:script|command)\s*:\s*(.+?)\s*$/.exec(line);
      if (m === null) continue;
      const command = m[1]!.replace(/^['"]|['"]$/g, '').trim();
      if (command !== '') out.push({ file: f, command });
    }
  }
  return out;
}

/** Split a CI command line into argv, refusing anything shell-shaped. This is a
 *  READ of the project's own text, and the result still has to pass the same
 *  `argvProblem` gate the manifest passes — a `&&`, a pipe or a redirect means the
 *  line is a shell command and is therefore NOT usable as a check. */
function ciArgv(command: string): string[] | null {
  if (/[|&;<>`$()]/.test(command)) return null;
  const parts = command.split(/\s+/).filter(Boolean);
  return parts.length > 0 ? parts : null;
}

/** Map a well-known tool invocation to a check kind, or null when it is not one. */
function kindOfCommand(argv: string[]): PlanKind | null {
  const prog = path.basename(argv[0]!).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
  const rest = argv.slice(1).map((a) => a.toLowerCase());
  const hasWord = (w: string): boolean => rest.some((a) => a === w || a.startsWith(`${w}:`));
  if (['ctest', 'pytest', 'jest', 'vitest', 'ava', 'mocha', 'phpunit', 'rspec'].includes(prog)) return 'tests';
  if (['make', 'task', 'just'].includes(prog)) {
    if (rest.some((a) => /^(test|tests|check|spec|verify)$/.test(a))) return 'tests';
    if (rest.some((a) => /^(build|all|compile)$/.test(a))) return 'build';
    if (rest.some((a) => /^(lint|vet|fmt-check)$/.test(a))) return 'typecheck';
    return null;
  }
  if (['gradle', 'gradlew', 'mvn', 'mvnw', 'dotnet', 'swift', 'zig', 'bundle', 'rake', 'composer', 'mix', 'shard', 'meson', 'cmake', 'ninja'].includes(prog)) {
    if (hasWord('test') || hasWord('spec') || hasWord('check')) return 'tests';
    if (hasWord('build') || hasWord('compile')) return 'build';
    if (hasWord('lint')) return 'typecheck';
    return null;
  }
  if (['cargo', 'go'].includes(prog)) return hasWord('test') ? 'tests' : null;
  if (prog === 'npm' || prog === 'pnpm' || prog === 'yarn' || prog === 'bun') {
    if (rest.some((a) => /^(test|check)$/.test(a))) return 'tests';
    if (rest.some((a) => /^build$/.test(a))) return 'build';
    if (rest.some((a) => /^lint$/.test(a))) return 'typecheck';
    return null;
  }
  if (prog === 'python' || prog === 'python3' || prog === 'py') {
    if (hasWord('-m') && rest.includes('pytest')) return 'tests';
    if (hasWord('-m') && rest.includes('unittest')) return 'tests';
    return null;
  }
  if (prog === 'node') return null; // `node --test` is the native Node path
  return null;
}

/**
 * Discover a project's checks from its own artifacts.
 *
 * Deliberately READ-ONLY and deterministic: same directory, same answer, no clock,
 * no network, no filesystem enumeration order leakage (every listing is sorted).
 */
export function discoverUniversalChecks(root: string): UniversalDiscovery {
  const checks: DiscoveredCheck[] = [];
  const notes: string[] = [];
  const add = (c: DiscoveredCheck): void => {
    if (checks.some((x) => x.kind === c.kind && x.script === c.script)) return;
    checks.push(c);
  };

  // ── 1. the project's own declared entry points (strongest: it states them) ──
  const makefile = readIfPresent(root, 'Makefile') ?? readIfPresent(root, 'makefile') ?? readIfPresent(root, 'GNUmakefile');
  if (makefile !== null) {
    const targets = makeTargets(makefile);
    for (const [kind, names] of [['tests', ['test', 'tests', 'check']], ['build', ['build', 'all']], ['typecheck', ['lint', 'vet']]] as const) {
      const hit = names.find((n) => targets.has(n));
      if (hit !== undefined) add({ kind, script: `make ${hit}`, argv: ['make', hit], evidence: `Makefile declares a "${hit}" target`, anchor: 'declared' });
    }
  }
  for (const [file, prog, targets] of [['Taskfile.yml', 'task', ['test', 'check']], ['Taskfile.yaml', 'task', ['test', 'check']], ['Taskfile.dist.yml', 'task', ['test', 'check']], ['Justfile', 'just', ['test', 'check']], ['justfile', 'just', ['test', 'check']]] as const) {
    const text = readIfPresent(root, file);
    if (text === null) continue;
    // Taskfile declares its targets as YAML keys INDENTED under `tasks:`; a justfile
    // declares them at column 0. Both mean "the project states this target exists",
    // so both shapes are recognized. MEASURED while writing this test file: an
    // indentation-blind parse found no target in a Taskfile and so turned a real
    // ambiguity into a silent single choice — the exact failure the ambiguity rule
    // exists to prevent.
    const declared = new Set<string>();
    if (prog === 'task') {
      let inTasks = false;
      for (const line of text.split(/\r?\n/)) {
        if (/^tasks:\s*$/.test(line)) { inTasks = true; continue; }
        if (!inTasks) continue;
        if (line.trim() !== '' && /^\S/.test(line)) { inTasks = false; continue; }
        const m = /^\s+([A-Za-z0-9_][A-Za-z0-9_.-]*):\s*$/.exec(line);
        if (m) declared.add(m[1]!);
      }
    } else {
      for (const line of text.split(/\r?\n/)) {
        const m = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*:/.exec(line);
        if (m) declared.add(m[1]!);
      }
    }
    const hit = targets.find((t) => declared.has(t));
    if (hit !== undefined) add({ kind: 'tests', script: `${prog} ${hit}`, argv: [prog, hit], evidence: `${file} declares a "${hit}" target`, anchor: 'declared' });
  }
  const shippedWrapper = (name: string): string | null => {
    for (const w of process.platform === 'win32' ? [name, `${name}.bat`] : [name]) {
      if (has(root, w)) return process.platform === 'win32' ? w.replace(/\\/g, '/') : `./${w}`;
    }
    return null;
  };
  const gradlew = shippedWrapper('gradlew');
  if (gradlew !== null) add({ kind: 'tests', script: 'gradlew test', argv: [gradlew, 'test'], evidence: 'the repository ships its own Gradle wrapper (gradlew)', anchor: 'declared' });
  const mvnw = shippedWrapper('mvnw');
  if (mvnw !== null) add({ kind: 'tests', script: 'mvnw test', argv: [mvnw, '-B', 'test'], evidence: 'the repository ships its own Maven wrapper (mvnw)', anchor: 'declared' });

  // ── 2. configured build/test systems (the project is SET UP for it) ──
  const builds = configuredBuildDirs(root);
  const cmakeDir = builds.find((b) => b.system === 'cmake');
  if (cmakeDir !== undefined) {
    add({ kind: 'build', script: 'cmake --build', argv: ['cmake', '--build', cmakeDir.dir], evidence: `${cmakeDir.dir}/CMakeCache.txt configures a CMake build tree`, anchor: 'configured' });
    if (cmakeRegistersTests(root)) {
      add({ kind: 'tests', script: 'ctest', argv: ['ctest', '--test-dir', cmakeDir.dir, '--output-on-failure'], evidence: `CMake test registration (enable_testing/add_test) plus the configured tree ${cmakeDir.dir}`, anchor: 'configured' });
    }
  } else if (has(root, 'CMakeLists.txt') && cmakeRegistersTests(root)) {
    // Tests are registered but nothing is configured yet: the honest check is the
    // CONFIGURE + BUILD + CTest sequence, which is what the project itself needs.
    add({ kind: 'build', script: 'cmake -S . -B build', argv: ['cmake', '-S', '.', '-B', 'build'], evidence: 'CMakeLists.txt with registered tests and no configured build tree', anchor: 'configured' });
    add({ kind: 'tests', script: 'ctest', argv: ['ctest', '--test-dir', 'build', '--output-on-failure'], evidence: 'CMake test registration (enable_testing/add_test)', anchor: 'configured' });
  }
  const mesonDir = builds.find((b) => b.system === 'meson');
  if (mesonDir !== undefined) {
    add({ kind: 'build', script: 'meson compile', argv: ['meson', 'compile', '-C', mesonDir.dir], evidence: `${mesonDir.dir}/meson-info configures a Meson build tree`, anchor: 'configured' });
    add({ kind: 'tests', script: 'meson test', argv: ['meson', 'test', '-C', mesonDir.dir], evidence: `${mesonDir.dir}/meson-info configures a Meson build tree`, anchor: 'configured' });
  } else if (has(root, 'meson.build')) {
    add({ kind: 'build', script: 'meson setup', argv: ['meson', 'setup', 'build'], evidence: 'meson.build (no configured build directory yet)', anchor: 'configured' });
    add({ kind: 'tests', script: 'meson test', argv: ['meson', 'test', '-C', 'build'], evidence: 'meson.build declares the project test suite', anchor: 'configured' });
  }
  if (has(root, 'phpunit.xml') || has(root, 'phpunit.xml.dist')) {
    add({ kind: 'tests', script: 'phpunit', argv: ['phpunit'], evidence: 'a PHPUnit configuration file is present', anchor: 'configured' });
  }
  if (has(root, 'Package.swift')) {
    add({ kind: 'tests', script: 'swift test', argv: ['swift', 'test'], evidence: 'Package.swift declares the Swift package', anchor: 'configured' });
  }
  const zigBuild = readIfPresent(root, 'build.zig');
  if (zigBuild !== null) {
    add({ kind: 'build', script: 'zig build', argv: ['zig', 'build'], evidence: 'build.zig declares the Zig build', anchor: 'configured' });
    if (/addTest\s*\(|test_step|step\(\s*"test"/.test(zigBuild)) {
      add({ kind: 'tests', script: 'zig build test', argv: ['zig', 'build', 'test'], evidence: 'build.zig registers a test step', anchor: 'configured' });
    }
  }
  if (has(root, 'mix.exs')) add({ kind: 'tests', script: 'mix test', argv: ['mix', 'test'], evidence: 'mix.exs declares the Elixir project', anchor: 'configured' });
  if (has(root, 'shard.yml')) add({ kind: 'tests', script: 'shard spec', argv: ['shard', 'spec'], evidence: 'shard.yml declares the Crystal project', anchor: 'configured' });
  const gemfile = readIfPresent(root, 'Gemfile');
  const rakefile = readIfPresent(root, 'Rakefile') ?? readIfPresent(root, 'rakefile');
  if (rakefile !== null && /task\s+:test\b|task\s+"test"/.test(rakefile)) {
    add({ kind: 'tests', script: 'rake test', argv: gemfile !== null ? ['bundle', 'exec', 'rake', 'test'] : ['rake', 'test'], evidence: 'Rakefile defines a :test task', anchor: 'declared' });
  }
  const composer = parseJsonOrNull(path.join(root, 'composer.json')) as { scripts?: Record<string, unknown> } | null;
  if (composer !== null) {
    const scripts = composer.scripts ?? {};
    // Only a key the project actually declares becomes a check: Composer runs
    // scripts through a shell, so the command has to be one we can spell as argv.
    const declared = ['test', 'check'].find((s) => typeof scripts[s] === 'string');
    if (declared !== undefined) add({ kind: 'tests', script: `composer ${declared}`, argv: ['composer', declared], evidence: `composer.json declares a "${declared}" script`, anchor: 'declared' });
  }

  // ── 3. what the project RUNS in its own CI (observed) ──
  for (const { file, command } of ciCommands(root)) {
    const argv = ciArgv(command);
    if (argv === null) continue;
    const kind = kindOfCommand(argv);
    if (kind === null) continue;
    const prog = path.basename(argv[0]!).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
    // A CI line that runs a package-manager script belongs to the native Node
    // adapter, and a `make test` line is already covered above.
    if (['npm', 'pnpm', 'yarn', 'bun', 'node', 'python', 'python3'].includes(prog)) continue;
    add({ kind, script: argv.join(' '), argv, evidence: `${file} runs \`${command}\``, anchor: 'observed' });
  }

  // ── 4. convention, only as a LAST resort for a kind nothing else anchored ──
  if (has(root, 'pom.xml') && !checks.some((c) => c.kind === 'tests')) {
    add({ kind: 'tests', script: 'mvn test', argv: ['mvn', '-B', 'test'], evidence: 'pom.xml declares a Maven project (its conventional test phase; nothing in the repository states the command)', anchor: 'convention' });
  }
  if (has(root, 'build.gradle') || has(root, 'build.gradle.kts')) {
    if (!checks.some((c) => c.kind === 'tests')) {
      add({ kind: 'tests', script: 'gradle test', argv: ['gradle', 'test'], evidence: 'a Gradle build file is present (its conventional test task; no wrapper is shipped and nothing states the command)', anchor: 'convention' });
    }
  }
  if (dirEntries(root).some((f) => /\.(sln|csproj)$/i.test(f)) && !checks.some((c) => c.kind === 'tests')) {
    add({ kind: 'tests', script: 'dotnet test', argv: ['dotnet', 'test'], evidence: 'a .NET project/solution file is present (its conventional test command)', anchor: 'convention' });
  }

  // ── ambiguity: two equally-anchored claims for the SAME kind ──
  const best = new Map<PlanKind, DiscoveredCheck[]>();
  const rank = { declared: 0, configured: 1, observed: 2, convention: 3 } as const;
  for (const c of checks) {
    if (!best.has(c.kind)) best.set(c.kind, []);
    best.get(c.kind)!.push(c);
  }
  let ambiguity: string | undefined;
  const winners: DiscoveredCheck[] = [];
  for (const [kind, list] of [...best.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const sorted = [...list].sort((a, b) => rank[a.anchor] - rank[b.anchor]);
    const top = rank[sorted[0]!.anchor];
    const tied = sorted.filter((c) => rank[c.anchor] === top);
    const distinct = new Set(tied.map((c) => path.basename(c.argv[0]!).toLowerCase()));
    if (distinct.size > 1) {
      ambiguity ??= `the ${kind} check is ambiguous: ${tied.map((c) => `\`${c.argv.join(' ')}\` (${c.evidence})`).join(' and ')} are equally anchored — Canary will not choose between them; declare the intended one in ${UNIVERSAL_MANIFEST}`;
      continue;
    }
    winners.push(tied[0]!);
  }
  if (ambiguity !== undefined) return { checks: [], notes, ambiguity };
  return {
    checks: winners.sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : (a.script < b.script ? -1 : 1))),
    notes,
    ...(builds.length > 0 ? { notes: notes.concat(`configured build trees: ${builds.map((b) => `${b.dir} (${b.system})`).join(', ')}`) } : {}),
  };
}

// ─────────────────────────── the adapter ───────────────────────────

/** Programs a universal plan may name. Setup pins them to absolute paths from the
 *  trusted PATH exactly like every other adapter; this list only decides which
 *  discovered programs setup is willing to look for. It is intentionally a
 *  DESCRIPTION, not an allowlist: discovery may only emit these, and the pin step
 *  is what makes them concrete. */
export const UNIVERSAL_PROGRAMS: readonly string[] = [
  'cmake', 'ctest', 'meson', 'ninja', 'make', 'task', 'just',
  'gradle', 'gradlew', 'mvn', 'mvnw', 'dotnet', 'swift', 'zig', 'phpunit',
  'composer', 'bundle', 'rake', 'mix', 'shard',
];

export const universalAdapter: ProjectAdapter = {
  id: 'universal',
  detect(root): ProjectDetection {
    const manifest = readUniversalManifest(root);
    if (manifest.manifest !== null) return { detected: true, confidence: 'high', reason: `${UNIVERSAL_MANIFEST} found` };
    if (manifest.problems.length > 0) return { detected: true, confidence: 'high', reason: `${UNIVERSAL_MANIFEST} found but not honourable` };
    const found = discoverUniversalChecks(root);
    if (found.ambiguity !== undefined) return { detected: true, confidence: 'low', reason: 'ambiguous repository evidence' };
    if (found.checks.length === 0) return { detected: false, confidence: 'high', reason: 'no repository evidence anchors a check' };
    return {
      detected: true,
      confidence: found.checks.some((c) => c.anchor === 'declared' || c.anchor === 'configured') ? 'high' : 'medium',
      reason: found.checks.map((c) => c.evidence).join('; '),
    };
  },
  discoverChecks(root): DiscoveredProject {
    const manifest = readUniversalManifest(root);
    if (manifest.problems.length > 0) {
      return { pm: 'universal', note: manifest.problems.join('; '), plan: [], source: {} };
    }
    if (manifest.manifest !== null) {
      const plan: PlanStep[] = [];
      for (const scope of manifest.manifest.scopes) {
        for (const c of scope.checks) {
          plan.push({
            kind: c.kind, script: c.name, adapter: 'universal', argv: [...c.argv],
            ...(scope.path !== '' ? { scope: scope.path } : {}),
          });
        }
      }
      const note = `${UNIVERSAL_MANIFEST}: ${plan.length} declared check(s) across ${manifest.manifest.scopes.length} scope(s)`;
      return { pm: 'universal', note, plan, source: {} };
    }
    const found = discoverUniversalChecks(root);
    if (found.ambiguity !== undefined) return { pm: 'universal', note: found.ambiguity, plan: [], source: {} };
    const plan: PlanStep[] = found.checks.map((c) => ({
      kind: c.kind, script: c.script, adapter: 'universal', argv: [...c.argv],
    }));
    const note = found.checks.length === 0
      ? 'no repository evidence anchors a check (a CI workflow line, a Makefile/Taskfile/justfile target, a configured CMake/Meson tree, a shipped wrapper, or a build manifest)'
      : found.checks.map((c) => `${c.script} [${c.anchor}: ${c.evidence}]`).join('; ');
    return { pm: 'universal', note, plan, source: {} };
  },
  validateEnvironment(pm) {
    return pm === 'universal' ? null : `runner "${pm}" is not this project's contract (universal)`;
  },
  describe() {
    return `Any command-driven project (checks DISCOVERED from the repository's own evidence, or declared in ${UNIVERSAL_MANIFEST})`;
  },
  seal(plan, _source, bindings): PlanAuthority {
    // An argv plan's authority is its own command array: sealPlanAuthority
    // digests assertStepArgv(argv) for every argv step, so the same sealed bytes
    // are both the plan and the spawn.
    return sealPlanAuthority(plan, {}, bindings);
  },
  drift(root, cfg: AuthorityCarrier): string | null {
    return planAuthorityDrift(root, cfg);
  },
  planProblems(root, plan): string[] {
    const problems: string[] = [];
    const manifest = readUniversalManifest(root);
    if (manifest.problems.length > 0) return manifest.problems.map((p) => `plan cannot be re-verified: ${p}`);
    if (manifest.manifest !== null) {
      const declared = new Set<string>();
      for (const scope of manifest.manifest.scopes) for (const c of scope.checks) declared.add(`${scope.path}::${c.name}`);
      for (const s of plan) {
        if (!declared.has(`${s.scope ?? ''}::${s.script}`)) {
          problems.push(`plan references the declared check "${s.script}"${s.scope ? ` in ${s.scope}` : ''} which ${UNIVERSAL_MANIFEST} no longer declares`);
        }
      }
      return problems;
    }
    // Discovery-based plans: the check must still be anchored by the same command.
    //
    // The PROGRAM is compared by IDENTITY, not by string: setup PINS argv[0] to an
    // absolute path, while discovery (which sees the repository again) produces the
    // bare name it was written with. Comparing raw strings reported every discovered
    // check as "no longer anchored" the moment it was correctly pinned — a permanent
    // false drift that made `doctor` refuse a healthy project. MEASURED, and fixed
    // here with the same rule the native adapters use (`sameDeclaration`).
    const programIdentity = (p: string): string =>
      path.basename(p).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
    const found = discoverUniversalChecks(root);
    if (found.ambiguity !== undefined) { problems.push(found.ambiguity); return problems; }
    for (const s of plan) {
      if (s.argv === undefined) { problems.push(`universal plan step "${s.script}" carries no argv`); continue; }
      const stillFound = found.checks.some((c) => c.kind === s.kind
        && programIdentity(c.argv[0]!) === programIdentity(s.argv![0]!)
        && JSON.stringify(c.argv.slice(1)) === JSON.stringify(s.argv!.slice(1)));
      if (!stillFound) {
        problems.push(`plan references the discovered check "${s.script}" which this repository no longer anchors — nothing was invented in its place`);
      }
    }
    return problems;
  },
  stepArgv(_pm, step): string[] {
    if (step.argv === undefined) throw new Error(`universal plan step "${step.script}" carries no argv — this build never synthesizes one`);
    return assertStepArgv(step.argv);
  },
  dependencyPaths: [],
  // A universal step's program is pinned to an absolute path at setup exactly
  // like every other adapter's, so PATH is never consulted at verification time.
  trustedProgramDirs: [],
};
