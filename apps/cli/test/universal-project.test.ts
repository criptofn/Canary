/**
 * THE UNIVERSAL PROJECT CONTRACT (v1.1) — language-agnostic at the project level.
 *
 * What this file has to prove, in order of how easily it could be false:
 *
 *  1. an unknown, command-driven repository is ONBOARDED, not refused: its plan is
 *     discovered from its OWN evidence (or read from the manifest escape hatch) and
 *     sealed/pinned exactly like a native plan;
 *  2. NOTHING IS INVENTED — a command with no repository anchor is not proposed, and
 *     a directory with no anchor at all yields an EMPTY plan, which setup reports as
 *     NEEDS ATTENTION rather than as a guess;
 *  3. ambiguity is asked about, once, instead of resolved by preference;
 *  4. the escape hatch cannot become a shell: argv arrays only, no `env`, no per-check
 *     `cwd`, no wrapper interpreter, nothing absolute or `..`-escaping;
 *  5. an unknown runner can never earn a strong label, so printed text cannot mint
 *     evidence — asserted through the PRODUCT registry and a REAL executor round;
 *  6. nested/polyglot still works: a universal scope beside a native Node root
 *     composes and seals with no key collision.
 *
 * Part 2 runs the real CLI against a REAL unknown tool — a tiny Go binary Canary has
 * no adapter for, built here (workspace-local Go toolchain, no network).
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, describe, it } from 'node:test';

process.env['CANARY_TRUST_STORE'] = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-trust-universal-'));

import { Recorder } from '@canary-rn/executor';
import { observationCapabilityFor, RUNNER_ADAPTERS } from '@canary-rn/executor';
import { classify } from '@canary-rn/classification';
import { sanitizedEnv, sanitizedEnvKeys } from '@canary-rn/support';

import { ADAPTERS, composePlan } from '../src/project.js';
import { execDigest, planAuthorityDrift, readConfig, type CanaryConfig } from '../src/onboarding.js';
import {
  UNIVERSAL_MANIFEST, discoverUniversalChecks, readUniversalManifest, universalContractLevels,
} from '../src/universal.js';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const CLI = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');
const GO = path.join(REPO, '_toolchains', 'go', 'bin', 'go.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-universal-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

/** A project directory with the given files. */
function project(name: string, files: Record<string, string>): string {
  const root = path.join(TMP, name);
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  // v1.4 — declare the harness IN THE FIXTURE. `setup` requires a detected harness and reads
  // `<root>/.claude` or the operator's `~/.claude`, so without this the fixture passed only on a
  // machine that has Claude Code installed and failed on every CI runner.
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
  return root;
}

describe('the universal contract — the manifest is an authority format, not a shell', () => {
  it('reads a valid manifest into scoped argv steps', () => {
    const root = project('manifest-ok', {
      [UNIVERSAL_MANIFEST]: JSON.stringify({
        schema: 'canary-project/1',
        scopes: [
          { path: '.', checks: [{ name: 'build', kind: 'build', argv: ['cmake', '--build', 'build'] }] },
          { path: 'native', checks: [{ name: 'tests', kind: 'tests', argv: ['ctest', '--test-dir', 'build'] }] },
        ],
      }),
      'native/placeholder.txt': 'x\n',
    });
    const read = readUniversalManifest(root);
    assert.deepEqual(read.problems, [], 'a well-formed manifest must have no problems');
    assert.equal(read.manifest?.scopes.length, 2);
    const disc = ADAPTERS['universal']!.discoverChecks(root);
    // Sorted by kind then name: a cosmetic reordering of the manifest cannot change
    // the sealed plan.
    assert.deepEqual(disc.plan.map((s) => [s.kind, s.script, s.argv, s.scope ?? '']), [
      ['build', 'build', ['cmake', '--build', 'build'], ''],
      ['tests', 'tests', ['ctest', '--test-dir', 'build'], 'native'],
    ]);
  });

  it('REFUSES env, cwd, shell wrappers, escaping scopes, unknown kinds and duplicates', () => {
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ['env', { name: 'x', kind: 'tests', argv: ['ctest'], env: { PATH: '/tmp/evil' } }, /"env" is not part of the universal contract/],
      ['cwd', { name: 'x', kind: 'tests', argv: ['ctest'], cwd: '/etc' }, /"cwd" is not part of the universal contract/],
      ['shell wrapper', { name: 'x', kind: 'tests', argv: ['bash', '-c', 'ctest'] }, /is a shell or wrapper/],
      ['powershell', { name: 'x', kind: 'tests', argv: ['pwsh', '-Command', 'ctest'] }, /is a shell or wrapper/],
      ['spec token', { name: 'x', kind: 'tests', argv: ['$npm', 'test'] }, /Canary's own spec token vocabulary/],
      ['unknown kind', { name: 'x', kind: 'deploy', argv: ['ctest'] }, /"kind" must be one of/],
      ['empty argv', { name: 'x', kind: 'tests', argv: [] }, /non-empty array/],
      ['non-string argv', { name: 'x', kind: 'tests', argv: ['ctest', 7] }, /non-empty string/],
    ];
    for (const [label, check, re] of cases) {
      const root = project(`manifest-bad-${label.replace(/\W+/g, '-')}`, {
        [UNIVERSAL_MANIFEST]: JSON.stringify({ schema: 'canary-project/1', scopes: [{ path: '.', checks: [check] }] }),
      });
      const read = readUniversalManifest(root);
      assert.equal(read.manifest, null, `${label}: must be refused`);
      assert.match(read.problems.join(' | '), re, `${label}: ${read.problems.join(' | ')}`);
    }
    // A scope that escapes the repository, and a duplicate check name.
    const escaping = project('manifest-escape', {
      [UNIVERSAL_MANIFEST]: JSON.stringify({ schema: 'canary-project/1', scopes: [{ path: '../outside', checks: [{ name: 'x', kind: 'tests', argv: ['ctest'] }] }] }),
    });
    assert.match(readUniversalManifest(escaping).problems.join(' '), /must not be absolute or contain "\.\."/);
    const dup = project('manifest-dup', {
      [UNIVERSAL_MANIFEST]: JSON.stringify({ schema: 'canary-project/1', scopes: [{ path: '.', checks: [
        { name: 'x', kind: 'tests', argv: ['ctest'] }, { name: 'x', kind: 'build', argv: ['cmake', '--build', 'build'] },
      ] }] }),
    });
    assert.match(readUniversalManifest(dup).problems.join(' '), /declared twice/);
    // A malformed manifest must not silently become an empty plan.
    const broken = project('manifest-broken', { [UNIVERSAL_MANIFEST]: '{ not json' });
    assert.match(readUniversalManifest(broken).problems.join(' '), /not valid JSON/);
  });
});

describe('the universal contract — discovery is anchored, never conventional-by-default', () => {
  it('discovers a declared Makefile target and calls it what it is', () => {
    const root = project('make', { Makefile: 'all: build\n\nbuild:\n\ttrue\n\ntest:\n\ttrue\n\nlint:\n\ttrue\n' });
    const found = discoverUniversalChecks(root);
    assert.equal(found.ambiguity, undefined);
    assert.deepEqual(found.checks.map((c) => [c.kind, c.argv.join(' '), c.anchor]), [
      ['build', 'make build', 'declared'],
      ['tests', 'make test', 'declared'],
      ['typecheck', 'make lint', 'declared'],
    ]);
    // `lint` maps onto the typecheck KIND (the kind the obligation engine understands
    // as "a static check ran") while the label still names the real tool — the same
    // rule the Python adapter applies to ruff. Asserted above; also asserted here
    // explicitly so the mapping cannot drift silently.
    assert.ok(discoverUniversalChecks(root).checks.some((c) => c.kind === 'typecheck' && c.argv.join(' ') === 'make lint'));
  });

  it('discovers CMake/CTest only when the repository CONFIGURES tests', () => {
    const without = project('cmake-no-tests', { 'CMakeLists.txt': 'add_executable(app main.cpp)\n', 'build/CMakeCache.txt': 'x\n' });
    const a = discoverUniversalChecks(without);
    assert.equal(a.checks.some((c) => c.kind === 'tests'), false, 'no add_test/enable_testing: ctest would run nothing, so it is not proposed');
    assert.ok(a.checks.some((c) => c.kind === 'build' && c.argv.join(' ') === 'cmake --build build'), 'the configured build tree IS proposed');

    const withTests = project('cmake-tests', {
      'CMakeLists.txt': 'enable_testing()\nadd_test(NAME smoke COMMAND app)\n',
      'build/CMakeCache.txt': 'x\n',
    });
    const b = discoverUniversalChecks(withTests);
    assert.deepEqual(b.checks.filter((c) => c.kind === 'tests').map((c) => [c.argv.join(' '), c.anchor]),
      [['ctest --test-dir build --output-on-failure', 'configured']]);
  });

  it('discovers a command the project itself RUNS in CI', () => {
    const root = project('ci', {
      '.github/workflows/ci.yml': [
        'jobs:',
        '  build:',
        '    steps:',
        '      - uses: actions/checkout@v4',
        '      - run: ctest --test-dir build --output-on-failure',
        '      - run: |',
        '          cmake --build build',
      ].join('\n'),
    });
    const found = discoverUniversalChecks(root);
    const tests = found.checks.find((c) => c.kind === 'tests');
    assert.ok(tests, `expected a tests check: ${JSON.stringify(found.checks)}`);
    assert.equal(tests.anchor, 'observed');
    assert.match(tests.evidence, /\.github\/workflows\/ci\.yml runs/);
  });

  it('refuses a CI line that is a SHELL command rather than a command', () => {
    const root = project('ci-shell', {
      '.github/workflows/ci.yml': 'steps:\n  - run: ctest --test-dir build && echo done\n  - run: ctest --test-dir build > out.txt\n',
    });
    assert.equal(discoverUniversalChecks(root).checks.length, 0,
      'a line with && or a redirect is a shell command and is never turned into a check');
  });

  it('invents NOTHING when the repository anchors nothing', () => {
    const root = project('empty-repo', { 'README.md': '# a repository with no build system at all\n', 'src/main.c': 'int main(void){return 0;}\n' });
    const found = discoverUniversalChecks(root);
    assert.deepEqual(found.checks, []);
    assert.equal(found.ambiguity, undefined);
    const det = ADAPTERS['universal']!.detect(root);
    assert.equal(det.detected, false, 'a C file alone is not evidence of a command Canary may run');
    assert.match(det.reason, /no repository evidence anchors a check/);
  });

  it('asks ONE concise clarification when two equally-anchored interpretations collide', () => {
    const root = project('ambiguous', { 'Taskfile.yml': 'version: "3"\ntasks:\n  test:\n    cmds: [true]\n', Justfile: 'test:\n  true\n' });
    const found = discoverUniversalChecks(root);
    assert.equal(found.checks.length, 0, 'nothing is chosen while the ambiguity stands');
    assert.ok(found.ambiguity, 'an ambiguity must be reported');
    assert.match(found.ambiguity!, /^the tests check is ambiguous:/);
    assert.match(found.ambiguity!, /task test/);
    assert.match(found.ambiguity!, /just test/);
    assert.match(found.ambiguity!, new RegExp(UNIVERSAL_MANIFEST.replace('.', '\\.')), 'and it says how to resolve it');
    assert.equal(found.ambiguity!.split('\n').length, 1, 'exactly ONE line, not a wall of text');

    // The MANIFEST is the resolution: with it, the ambiguity is gone.
    const resolved = project('ambiguous-resolved', {
      'Taskfile.yml': 'tasks:\n  test:\n    cmds: [true]\n', Justfile: 'test:\n  true\n',
      [UNIVERSAL_MANIFEST]: JSON.stringify({ schema: 'canary-project/1', scopes: [{ path: '.', checks: [{ name: 'tests', kind: 'tests', argv: ['just', 'test'] }] }] }),
    });
    const disc = ADAPTERS['universal']!.discoverChecks(resolved);
    assert.deepEqual(disc.plan.map((s) => s.argv), [['just', 'test']], 'the author decision wins over discovery');
  });

  it('a shipped wrapper is DECLARED evidence, a bare build file is only CONVENTION', () => {
    const withWrapper = project('gradle-wrapper', { gradlew: '#!/bin/sh\nexec gradle "$@"\n', 'build.gradle': 'plugins {}\n' });
    const a = discoverUniversalChecks(withWrapper);
    // v1.4 — the spelling of argv[0] is a HOST fact, not a product fact: a wrapper is
    // invoked as `./gradlew` on POSIX (there is no `.` on PATH) and as `gradlew` on
    // Windows (`universal.ts:451`). The Windows spelling used to be hard-coded here, so
    // this assertion failed on Linux for every push. What the test MEANS is: the command
    // is the repository's own shipped wrapper plus `test`, and it is anchored DECLARED
    // rather than CONVENTION — which is what it now asserts, on either host.
    const wrapper = process.platform === 'win32' ? 'gradlew' : './gradlew';
    assert.deepEqual(a.checks.filter((c) => c.kind === 'tests').map((c) => [c.argv.join(' '), c.anchor]),
      [[`${wrapper} test`, 'declared']], 'the repository ships the wrapper, so it states the command');

    const noWrapper = project('gradle-bare', { 'build.gradle': 'plugins {}\n' });
    const b = discoverUniversalChecks(noWrapper);
    const conv = b.checks.find((c) => c.kind === 'tests');
    assert.equal(conv?.anchor, 'convention');
    assert.match(conv!.evidence, /conventional test task/, 'and the evidence SAYS it is convention rather than fact');
  });
});

describe('the universal contract — capability honesty', () => {
  it('an unknown tool is not a runner, and an unknown runner can never be STRONG', () => {
    const unknown = observationCapabilityFor({ program: 'acmetest' });
    assert.equal(unknown.runner, 'unknown');
    assert.equal(unknown.capability, 'INCONCLUSIVE_ONLY');
    assert.equal(unknown.observation, undefined, 'no channel, no contract, no strong label');
    // `ctest` is a real tool Canary has no adapter for: same answer.
    assert.equal(observationCapabilityFor({ program: 'ctest' }).capability, 'INCONCLUSIVE_ONLY');
    // And the registry's own STRONG set does not contain anything universal.
    const strong = RUNNER_ADAPTERS.filter((a) => a.capability === 'STRONG').map((a) => a.id);
    assert.deepEqual(strong.sort(), ['mocha', 'node-test', 'pytest', 'unittest']);
  });

  it('the four capability levels are stated as data, and UNIVERSAL is not a language claim', () => {
    const levels = universalContractLevels();
    assert.deepEqual(levels.native, ['node', 'python', 'rust', 'go']);
    assert.deepEqual(levels.strong, ['mocha', 'node-test', 'pytest', 'unittest']);
    assert.match(levels.universal, /argv-based checks/);
    assert.doesNotMatch(JSON.stringify(levels), /understands every language|any language/i,
      'the contract must never claim to understand languages');
  });

  it('the universal door adds NO environment and NO new sanitized variable', () => {
    const ws = { root: project('env-check', {}), fixture: project('env-check-fixture', {}) };
    const keys = sanitizedEnvKeys(sanitizedEnv({ ws, nodeDir: path.dirname(process.execPath) }));
    // A universal plan is argv + a sealed program path; it contributes nothing to
    // the child environment, which is what keeps audit F9's rule intact.
    assert.equal(keys.includes('CANARY_UNIVERSAL'), false);
    assert.deepEqual(keys.filter((k) => k.startsWith('CANARY_')), []);
  });
});

describe('the universal contract — nested and polyglot composition', () => {
  it('composes beside a native Node root, in its own scope, with no key collision', () => {
    const root = project('polyglot', {
      'package.json': JSON.stringify({ name: 'root', scripts: { test: 'node -e "process.exit(0)"' } }),
      'tools/Makefile': 'test:\n\ttrue\n',
      'canary.scopes.json': JSON.stringify({ schema: 'canary-scopes/1', scopes: [{ path: 'tools', ecosystem: 'universal' }] }),
    });
    const composed = composePlan(root);
    assert.deepEqual(composed.problems, []);
    const universal = composed.scopes.find((s) => s.adapter.id === 'universal');
    assert.ok(universal, `the universal scope must be composed: ${JSON.stringify(composed.scopes.map((s) => s.adapter.id))}`);
    assert.equal(universal!.scope, 'tools');
    const steps = composed.plan;
    const keys = steps.map((s) => (s.scope ? `${s.scope}::${s.script}` : s.script));
    assert.equal(new Set(keys).size, keys.length, `step keys must be unique: ${JSON.stringify(keys)}`);
    assert.ok(steps.some((s) => s.adapter === 'universal' && s.scope === 'tools' && s.argv?.join(' ') === 'make test'));
  });

  it('a declared universal scope with nothing to anchor it is REFUSED, not silently empty', () => {
    const root = project('polyglot-empty', {
      'package.json': JSON.stringify({ name: 'root', scripts: { test: 'node -e "process.exit(0)"' } }),
      'tools/README.md': 'nothing to discover here\n',
      'canary.scopes.json': JSON.stringify({ schema: 'canary-scopes/1', scopes: [{ path: 'tools', ecosystem: 'universal' }] }),
    });
    const composed = composePlan(root);
    assert.match(composed.problems.join(' '), /declared as ecosystem "universal" but nothing there declares it/);
  });

  it('DEFERS to a native adapter that is present, so a command is never discovered twice', () => {
    // A Rust repository whose CI runs its own runner. The RUST adapter owns that
    // check (from Cargo.toml); a universal scope claiming the same command at the
    // same path would produce two steps with the SAME sealed key — a colliding seal
    // and a duplicated execution. Both halves are asserted, because "no duplicate"
    // and "the check still exists" are different facts.
    const rust = project('native-priority', {
      'Cargo.toml': '[package]\nname = "x"\nversion = "0.1.0"\n',
      '.github/workflows/ci.yml': 'jobs:\n  t:\n    steps:\n      - run: cargo test --all\n',
    });
    assert.deepEqual(discoverUniversalChecks(rust).checks, [],
      'a native-owned command is not re-proposed by the universal door');
    assert.equal(ADAPTERS['universal']!.detect(rust).detected, false);

    const composed = composePlan(rust);
    assert.deepEqual(composed.problems, []);
    assert.deepEqual(composed.scopes.map((s) => s.adapter.id), ['rust'], 'only the native adapter claims it');
    const keys = composed.plan.map((s) => (s.scope ? `${s.scope}::${s.script}` : s.script));
    assert.equal(new Set(keys).size, keys.length, `step keys must be unique: ${JSON.stringify(keys)}`);
    assert.ok(composed.plan.some((s) => s.script === 'cargo test'), 'and the check itself is not lost');

    // The same command in a repository with NO native adapter still arrives through
    // the universal door: deference is not a capability limit.
    const cmdOnly = project('defer-not-limit', {
      '.github/workflows/ci.yml': 'jobs:\n  t:\n    steps:\n      - run: cargo test --all\n',
    });
    assert.ok(discoverUniversalChecks(cmdOnly).checks.some((c) => c.argv.join(' ') === 'cargo test --all'),
      'with no Cargo.toml there is no native adapter to defer to, so the CI line IS the evidence');
  });
});

// ---------------------------------------------------------------------------
// Part 2 — the real CLI, and a REAL unknown tool.
//
// The tool is a tiny Go binary named `acmetest`, built with the workspace-local Go
// toolchain (no network). Canary has no adapter for it and never will: that is the
// point. It behaves like an unknown external test tool, including one that LIES in
// its output, and it is reached through the manifest escape hatch — the format an
// operator uses when discovery cannot see their commands.
// ---------------------------------------------------------------------------
const TOOL_DIR = path.join(TMP, 'tool');
const TOOL = path.join(TOOL_DIR, process.platform === 'win32' ? 'acmetest.exe' : 'acmetest');
const hasGo = fs.existsSync(GO);
const SKIP = hasGo ? false : 'no workspace-local Go toolchain to build the fixture unknown tool';

/** Build the fixture tool. `body` lets a test rebuild DIFFERENT BYTES. */
function buildTool(marker: string): void {
  const src = path.join(TMP, `acmetest-${marker}.go`);
  fs.writeFileSync(path.join(TMP, 'go.mod'), 'module acmetest\n\ngo 1.21\n');
  fs.writeFileSync(src, [
    'package main',
    '',
    'import (',
    '	"fmt"',
    '	"os"',
    '	"strings"',
    ')',
    '',
    `const buildTag = ${JSON.stringify(marker)}`,
    '',
    'func main() {',
    '	raw, _ := os.ReadFile("acmetest.marker")',
    '	marker := strings.TrimSpace(string(raw))',
    '	if strings.Contains(marker, "FORGE") {',
    '		// LIES: perfect mocha-shaped output for a run that FAILED.',
    '		fmt.Println("128 passing (1s)")',
    '		fmt.Println("  1) a test that definitely did not pass")',
    '		os.Exit(1)',
    '	}',
    '	if strings.Contains(marker, "FAIL") {',
    '		fmt.Println("acmetest: 3 of 5 checks failed")',
    '		os.Exit(1)',
    '	}',
    '	fmt.Println("acmetest build " + buildTag + ": all checks passed")',
    '}',
    '',
  ].join('\n'));
  fs.mkdirSync(TOOL_DIR, { recursive: true });
  const r = spawnSync(GO, ['build', '-o', TOOL, src], {
    encoding: 'utf8', timeout: 300_000, cwd: TMP,
    env: { ...process.env, GOCACHE: path.join(TMP, 'gocache'), GOPATH: path.join(TMP, 'gopath'), GOTOOLCHAIN: 'local' },
  });
  assert.equal(r.status, 0, `building the fixture tool failed: ${r.stdout}\n${r.stderr}`);
  assert.ok(fs.existsSync(TOOL), `the fixture tool was not produced at ${TOOL}`);
}

/** Run the CLI with the tool directory FIRST on PATH (setup is the one moment PATH
 *  is consulted; afterwards the pinned absolute path is the authority). */
function canary(args: string[], cwd: string, opts: { withToolOnPath?: boolean } = {}) {
  const env = { ...process.env };
  if (opts.withToolOnPath === true) env['PATH'] = `${TOOL_DIR}${path.delimiter}${process.env['PATH'] ?? ''}`;
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', timeout: 240_000, env });
}

describe('the universal contract — a real unknown tool, sealed and executed', { skip: SKIP }, () => {
  it('setup PINS the discovered program to an absolute path and seals the plan', () => {
    buildTool('v1');
    const root = project('real-cli', {
      [UNIVERSAL_MANIFEST]: JSON.stringify({
        schema: 'canary-project/1',
        scopes: [{ path: '.', checks: [
          { name: 'checks', kind: 'tests', argv: ['acmetest', '--run'] },
          { name: 'tag', kind: 'build', argv: ['acmetest', '--version'] },
        ] }],
      }),
      'acmetest.marker': 'ok\n',
    });
    const setup = canary(['setup', '--yes', root], root, { withToolOnPath: true });
    assert.equal(setup.status, 0, `setup must succeed on a universal project: ${setup.stdout}\n${setup.stderr}`);

    const cfg = readConfig(root) as CanaryConfig | null;
    assert.ok(cfg !== null, 'setup must write a readable config');
    // The contract is recorded per STEP (`adapter`), which is what verification
    // resolves through (`adapterForStep`), and the config's `pm` names it too — so
    // the universal path is not silently re-checked as a Node project.
    assert.equal(cfg.pm, 'universal');
    assert.deepEqual([...new Set(cfg.plan.map((s) => s.adapter))], ['universal']);
    const step = cfg.plan.find((s) => s.script === 'checks');
    assert.ok(step?.argv, `the plan must carry argv: ${JSON.stringify(cfg.plan)}`);
    assert.equal(step.argv[0], TOOL, 'the program is pinned ABSOLUTE — PATH is never consulted again');
    assert.deepEqual(step.argv.slice(1), ['--run']);
    assert.deepEqual(cfg.plan.map((s) => s.kind).sort(), ['build', 'tests']);
    assert.equal(planAuthorityDrift(root, cfg), null, 'the seal matches the plan it sealed');
    // The executor agrees that this is not a runner Canary can observe.
    assert.equal(observationCapabilityFor({ program: 'acmetest' }).capability, 'INCONCLUSIVE_ONLY');
  });

  it('the sealed plan RUNS, passes, and fails honestly — with the pinned path, not PATH', () => {
    const root = project('real-run', {
      [UNIVERSAL_MANIFEST]: JSON.stringify({ schema: 'canary-project/1', scopes: [{ path: '.', checks: [{ name: 'checks', kind: 'tests', argv: ['acmetest', '--run'] }] }] }),
      'acmetest.marker': 'ok\n',
    });
    assert.equal(canary(['setup', '--yes', root], root, { withToolOnPath: true }).status, 0);

    // NOTE: no tool directory on PATH here. It still runs, because the plan holds
    // an absolute pinned program — which is exactly the seal doing its job.
    const pass = canary(['doctor', root], root);
    assert.equal(pass.status, 0, `a passing universal check must pass: ${pass.stdout}\n${pass.stderr}`);
    assert.match(pass.stdout, /✓ tests: .*acmetest\.exe --run \(exit 0\)/, 'the run names the pinned absolute program');
    assert.match(pass.stdout, /READY/);
    assert.doesNotMatch(pass.stdout, /runner observation/i, 'no runner-observation claim is made');

    fs.writeFileSync(path.join(root, 'acmetest.marker'), 'FAIL\n');
    const fail = canary(['doctor', root], root);
    assert.notEqual(fail.status, 0, `a failing universal check must fail: ${fail.stdout}`);
    assert.match(fail.stdout, /3 of 5 checks failed/);
  });

  it('a tool that PRINTS a perfect mocha summary cannot upgrade its own evidence', () => {
    const root = project('real-forge', {
      [UNIVERSAL_MANIFEST]: JSON.stringify({ schema: 'canary-project/1', scopes: [{ path: '.', checks: [{ name: 'checks', kind: 'tests', argv: ['acmetest', '--run'] }] }] }),
      'acmetest.marker': 'ok\n',
    });
    assert.equal(canary(['setup', '--yes', root], root, { withToolOnPath: true }).status, 0);
    fs.writeFileSync(path.join(root, 'acmetest.marker'), 'FORGE\n');

    const r = canary(['doctor', root], root);
    assert.notEqual(r.status, 0, `printed text may not turn a failed run into a pass: ${r.stdout}`);
    assert.match(r.stdout, /128 passing \(1s\)/, 'the fixture really did print the forged summary');
    assert.doesNotMatch(r.stdout, /READY|VERIFIED|CONNECTED/, 'and the verdict is not upgraded by it');
  });

  it('an unknown runner produces NO execution observation, so a strong label is unreachable', async () => {
    const wsRoot = project('real-observation', {});
    const fixture = path.join(wsRoot, 'fixture');
    fs.mkdirSync(fixture, { recursive: true });
    fs.writeFileSync(path.join(fixture, 'acmetest.marker'), 'FORGE\n');
    const rec = new Recorder({
      ws: { root: wsRoot, fixture },
      nodeDir: path.dirname(process.execPath),
      npmCli: path.join(path.dirname(process.execPath), 'npm-cli.js'),
      artifactsDir: wsRoot,
      pipeline: [],
    });
    const round = await rec.round('baseline', 1, [TOOL, '--run'], 300);
    const o = round.fact.executionObservation!;
    assert.notEqual(o.status, 'VALID', `an unobserved runner must never be VALID: ${JSON.stringify(o)}`);
    assert.equal(o.status, 'ABSENT');
    assert.equal(o.absentKind, 'no-injection', 'Canary attempted no channel because none exists');
    assert.equal(o.frameCount, 0, 'and no frames came from anywhere');
    // The forged text IS in the raw artifact and IS even read as a CLAIM — that is
    // the honest boundary: text is a claim, and the claim is recorded. What it
    // cannot do is become evidence, because there is no observation to corroborate
    // it, so no strong label is reachable.
    assert.equal(round.run.stdout.includes('128 passing'), true, 'the forged text is in the raw artifact');
    assert.equal(round.fact.reportedPassing, 128, 'and it is recorded as the CLAIM it is');
    assert.equal(round.fact.executionObservation!.status, 'ABSENT', 'while the observation says nothing was watched');
    // The verdict: two arms of an unobserved, forged run cannot reach a strong label.
    const verdict = classify([
      { ...round.fact, arm: 'baseline', round: 1 },
      { ...round.fact, arm: 'candidate', round: 1 },
    ]);
    assert.notEqual(verdict.classification, 'PASS', `printed text must not reach PASS: ${JSON.stringify(verdict)}`);
    assert.match(verdict.classification, /INCONCLUSIVE|INFRASTRUCTURE_FAILURE/);
  });

  it('the executable identity is BOUND to bytes: a rebuild changes the recorded digest', () => {
    buildTool('v1');
    const before = execDigest(TOOL);
    assert.ok(before, 'the pinned program has a digest');
    buildTool('v2-changed-bytes');
    const after = execDigest(TOOL);
    assert.ok(after);
    assert.notEqual(before, after,
      'replacing the pinned program with different bytes yields a different recorded identity — '
      + 'a swap is therefore EVIDENCE in every step result rather than an invisible change');
  });
});
