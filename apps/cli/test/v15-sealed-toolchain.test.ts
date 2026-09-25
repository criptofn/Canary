/**
 * v1.5 AUDIT BLOCKER 6 — sealed toolchain and truthful failure attribution.
 *
 * The probe (tooling/probes/v15-sealed-toolchain.mjs) measures the PRODUCT end to end on this host.
 * This suite pins the MECHANISM the product rests on, so a later edit cannot quietly turn a
 * measurement back into a guess:
 *
 *  - the sealed step environment is BUILT (Node install dir + OS dirs) and an operator-authorized
 *    directory is only ever APPENDED, never substituted for the trusted dirs;
 *  - `extraPathDirs` fails closed on a relative or missing directory, and is absent by default (so
 *    every child environment built before this change is byte-identical);
 *  - the attribution rules: environment only when the child named a program that genuinely does not
 *    resolve in the directories the child was handed, and never because the output merely says so;
 *  - a path with SPACES survives validation, sealing and the child's PATH verbatim;
 *  - git / node / npm resolve through an authorized directory on ANY host (they are what this repo
 *    itself requires), while python and java are asserted only where this host actually has them —
 *    and when it does not, the test says so instead of passing quietly.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, describe, it } from 'node:test';
process.env.CANARY_TRUST_STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-trust-v15st-'));

import { sanitizedEnv } from '@canary-rn/support';
import {
  PROJECT_CHECK_FAILURE, SEALED_ENV_CANNOT_RESOLVE, TOOLCHAIN_CANDIDATES,
  attributeFailures, attributeStepFailure, inventoryOperatorToolchain, notFoundPrograms,
  npmScriptDirs, pathEntries, programNames, resolvesIn, validateToolchainDir,
  type ToolchainSeal,
} from '../src/sealed-toolchain.js';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const CLI = path.join(REPO, 'apps', 'cli', 'dist', 'src', 'main.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-v15st-unit-'));
const NODE_DIR = path.dirname(process.execPath);

after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });

const WINDOWS = process.platform === 'win32';
/** A staged directory whose name contains spaces — the regression this repository keeps meeting. */
const SPACED_DIR = path.join(TMP, 'a tool chain with spaces', 'bin');
fs.mkdirSync(SPACED_DIR, { recursive: true });
fs.writeFileSync(path.join(SPACED_DIR, WINDOWS ? 'stagedtool.exe' : 'stagedtool'), 'staged\n');

const ws = { root: TMP, fixture: TMP };
const sealedPath = (extraPathDirs?: string[]): string[] =>
  pathEntries(sanitizedEnv({ ws, nodeDir: NODE_DIR, materialize: false, ...(extraPathDirs === undefined ? {} : { extraPathDirs }) }));

describe('the sealed step environment: built from trusted dirs, plus what an OPERATOR authorized', () => {
  it('is unchanged when nothing was authorized (every existing child keeps its byte shape)', () => {
    const plain = sealedPath();
    assert.deepEqual(plain, [NODE_DIR, ...(WINDOWS ? [path.join(process.env['SystemRoot'] ?? 'C:\\WINDOWS', 'System32'), process.env['SystemRoot'] ?? 'C:\\WINDOWS'] : ['/usr/bin', '/bin'])]);
    assert.deepEqual(sealedPath([]), plain, 'an empty authorization list must not change the environment');
    assert.ok(!plain.some((d) => d.toLowerCase() === SPACED_DIR.toLowerCase()), 'a staged directory leaked into the default environment');
  });

  it('APPENDS an authorized directory after the trusted ones, never in front of them', () => {
    const withDir = sealedPath([SPACED_DIR]);
    assert.equal(withDir[withDir.length - 1], SPACED_DIR, 'the authorized directory must come last');
    assert.deepEqual(withDir.slice(0, sealedPath().length), sealedPath(), 'the trusted prefix changed');
    assert.ok(withDir.includes(SPACED_DIR), 'a directory with spaces must survive verbatim');
  });

  it('deduplicates and fails closed on a relative or missing directory', () => {
    assert.deepEqual(sealedPath([SPACED_DIR, SPACED_DIR]), sealedPath([SPACED_DIR]));
    assert.throws(() => sealedPath(['relative/dir']), /absolute path/);
    assert.throws(() => sealedPath([path.join(TMP, 'does-not-exist')]), /does not exist/);
  });

  it('a program in an authorized directory resolves through the SAME walk the OS loader uses', () => {
    assert.equal(resolvesIn('stagedtool', sealedPath([SPACED_DIR]), process.platform), path.join(SPACED_DIR, WINDOWS ? 'stagedtool.exe' : 'stagedtool'));
    assert.equal(resolvesIn('stagedtool', sealedPath(), process.platform), null, 'a staged program resolved without being authorized');
    assert.deepEqual(programNames('x', 'win32'), ['x.exe', 'x.cmd', 'x.bat', 'x']);
  });
});

describe('git, node, npm, python, java — where this host actually has them', () => {
  const ambientPath = process.env.PATH ?? '';
  const inventory = inventoryOperatorToolchain(ambientPath);
  /** Tools this REPOSITORY itself requires: their absence is a broken host, not a skip. */
  const REQUIRED = ['git', 'node', 'npm'];

  for (const tool of ['git', 'node', 'npm', 'python', 'python3', 'java']) {
    it(`${tool}: an authorized directory makes it resolvable inside the sealed environment`, () => {
      const where = inventory[tool] ?? null;
      if (where === null) {
        if (REQUIRED.includes(tool)) assert.fail(`this host has no \`${tool}\` on PATH, so the sealed-environment claim cannot be measured — that is a broken host, not a skip`);
        console.log(`     host-bound: this host has no \`${tool}\` on PATH — nothing to assert (NOT a pass)`);
        return;
      }
      const dir = path.dirname(where);
      // node/npm live in the Node install dir, which is ALREADY a trusted sealed directory — so the
      // "invisible without authorization" half is only assertable for tools outside Canary's own dirs.
      if (!sealedPath().some((d) => d.toLowerCase() === dir.toLowerCase())) {
        assert.equal(resolvesIn(tool, sealedPath(), process.platform), null, `${tool} resolved without being authorized`);
      } else {
        console.log(`     ${tool} already lives in a trusted sealed directory (${dir}) — visibility asserted, authorization not needed`);
      }
      const resolved = resolvesIn(tool, sealedPath([dir]), process.platform);
      assert.equal(resolved, where, `authorizing ${dir} must resolve ${tool} to the same bytes the operator has`);
    });
  }

  it('records an inventory at setup time WITHOUT making it authority (it is remediation evidence)', () => {
    for (const name of REQUIRED) assert.ok(Object.hasOwn(inventory, name), `the inventory is missing ${name}`);
    assert.ok(TOOLCHAIN_CANDIDATES.includes('java'), 'java must be in the candidate list');
    // The inventory is only ever read to SUGGEST a directory in a sentence; nothing executes from it.
    const dirs = sealedPath();
    for (const hit of Object.values(inventory)) {
      if (typeof hit !== 'string') continue;
      const dir = path.dirname(hit);
      if (dirs.some((d) => d.toLowerCase() === dir.toLowerCase())) continue; // a trusted dir (Node's own) is in the PATH by construction, not by inventory
      assert.ok(!dirs.includes(dir), `an inventory hit leaked into the sealed PATH without being authorized: ${dir}`);
    }
  });
});

describe('validateToolchainDir refuses the one authority a worker could grant itself', () => {
  it('accepts an absolute, existing directory outside the repository', () => {
    const ok = validateToolchainDir(REPO, SPACED_DIR);
    assert.equal(ok.ok, true);
    if (ok.ok) assert.equal(ok.dir, fs.realpathSync.native(SPACED_DIR));
  });

  it('refuses a relative path, a file, a missing directory, and anything inside the repository', () => {
    const file = path.join(TMP, 'not-a-dir.txt');
    fs.writeFileSync(file, 'x\n');
    for (const [dir, why] of [
      ['relative/dir', /absolute path/],
      [path.join(TMP, 'missing-xyz'), /does not exist/],
      [file, /not a directory/],
      [path.join(REPO, 'node_modules'), /inside the repository/],
      [REPO, /inside the repository/],
    ] as Array<[string, RegExp]>) {
      const r = validateToolchainDir(REPO, dir);
      assert.equal(r.ok, false, `expected refusal for ${dir}`);
      if (!r.ok) assert.match(r.problem, why);
    }
  });
});

describe('notFoundPrograms reads the loaders\' published failure text', () => {
  it('recognizes cmd.exe, POSIX sh, PowerShell, node ENOENT and Go exec shapes', () => {
    const cases: Array<[string, string[]]> = [
      ["'git' is not recognized as an internal or external command,\r\noperable program or batch file.", ['git']],
      ['sh: 1: java: not found', ['java']],
      ['python3: command not found', ['python3']],
      ['command not found: gradle', ['gradle']],
      ["The term 'mvn' is not recognized as the name of a cmdlet, function, script file, or operable program.", ['mvn']],
      ['Error: spawnSync git ENOENT', ['git']],
      ['exec: "java": executable file not found in $PATH', ['java']],
    ];
    for (const [text, expected] of cases) assert.deepEqual(notFoundPrograms(text), expected, text);
  });

  it('recognizes the LOCALIZED cmd.exe sentence this host actually printed, and the exit-code door', () => {
    // MEASURED on this host by tooling/probes/v15-sealed-toolchain.mjs, whose first run failed here:
    // a German Windows prints `Der Befehl "git" ist entweder falsch geschrieben oder konnte nicht
    // gefunden werden.` and exits 9009. An English-only matcher would have kept the false blame.
    const german = 'Der Befehl "git" ist entweder falsch geschrieben oder\r\nkonnte nicht gefunden werden.';
    assert.deepEqual(notFoundPrograms(german), ['git']);
    assert.deepEqual(notFoundPrograms('Der Ausdruck "mvn" ist entweder falsch geschrieben oder konnte nicht gefunden werden.'), ['mvn']);
    assert.deepEqual(notFoundPrograms('"gradle" wurde nicht gefunden'), ['gradle']);
    // Locale-free door: 9009 (cmd.exe) / 127 (POSIX sh) mean "command not found", so a KNOWN toolchain
    // program named in quotes is taken even when the sentence is in a language Canary does not list.
    assert.deepEqual(notFoundPrograms('El comando "python" no se reconoce.', 9009), ['python']);
    assert.deepEqual(notFoundPrograms('sh: 1: java: not found', 127), ['java']);
    // The exit-code door takes ANY program named in an explicit not-found sentence, because 9009/127
    // plus that sentence is the loader's own statement — an unknown tool (`protoc`, `bazel`, …) must
    // not be lost just because Canary's candidate list does not know it. The exit code ALONE, with no
    // not-found sentence, is not enough: there it takes only known programs, so an unrelated failure
    // that happens to exit 9009 cannot become an environment claim.
    assert.deepEqual(notFoundPrograms('Der Befehl "frobnicate" ist entweder falsch geschrieben.', 9009), ['frobnicate']);
    assert.deepEqual(notFoundPrograms('Build failed while running "frobnicate" step.', 9009), []);
    assert.deepEqual(notFoundPrograms('Build failed while running "java" step.', 9009), ['java']);
  });

  it('does not fire on ordinary test output (an assertion failure is not a missing program)', () => {
    for (const text of [
      'AssertionError: expected 1 to equal 2',
      '  5 !== 0\n  total includes negative values',
      'FAIL src/calc.test.ts > adds two numbers\nTypeError: x is not a function',
      'Error: ENOENT: no such file or directory, open \'fixtures/input.json\'',
    ]) assert.deepEqual(notFoundPrograms(text), [], text);
  });
});

const SEAL: ToolchainSeal = {
  dirs: [path.join(TMP, 'gone-dir')],
  found: { git: path.join('C:', 'Program Files', 'Git', 'cmd', 'git.exe') },
  at: new Date().toISOString(),
};
const NOT_FOUND_CMD = "'git' is not recognized as an internal or external command,\r\noperable program or batch file.";

describe('attribution: is Canary\'s environment the cause, or the project?', () => {
  const base = {
    kind: 'tests', script: 'test', exitCode: 9009, output: NOT_FOUND_CMD,
    childPathDirs: [NODE_DIR, 'C:\\Windows\\System32', 'C:\\Windows'],
    vanishedDirs: [] as string[], seal: SEAL,
  };

  it('ENVIRONMENT: the child named a program that genuinely does not resolve in its directories', () => {
    const a = attributeStepFailure(base);
    assert.equal(a.cause, 'environment');
    assert.deepEqual(a.missing, ['git']);
    assert.match(a.reason, new RegExp(SEALED_ENV_CANNOT_RESOLVE));
    assert.doesNotMatch(a.reason, /That is your project talking/);
    /*
     * PORTABILITY (v1.5 post-audit, MEASURED on the ubuntu CI leg): this assertion hardcoded the
     * Windows separator (`C:\Program Files\Git\cmd`). The fixture's directory is built with
     * path.join — on Linux that renders as `C:/Program Files/Git/cmd` — so a mandatory CI leg went
     * red for a reason that had nothing to do with the behaviour under test. The expectation is now
     * derived from the SAME expression the fixture uses, so it stays EXACT on every platform rather
     * than being relaxed into a substring match.
     */
    const expectedDir = path.join('C:', 'Program Files', 'Git', 'cmd');
    assert.ok(a.next.includes(`canary setup --toolchain-dir "${expectedDir}"`),
      `the remediation must name the directory that HAS the tool; got: ${a.next}`);
  });

  it('PROJECT: the same text when the program DOES resolve (a project cannot print its way out of blame)', () => {
    const a = attributeStepFailure({ ...base, childPathDirs: [path.join('C:', 'Program Files', 'Git', 'cmd')] });
    assert.equal(a.cause, 'project');
    assert.match(a.reason, new RegExp(PROJECT_CHECK_FAILURE));
    assert.match(a.reason, /That is your project talking, not Canary\./);
  });

  it('ENVIRONMENT: a step that could not run at all (nothing about the project was measured)', () => {
    const a = attributeStepFailure({ ...base, exitCode: null, output: 'package manager "npm" is not resolvable in Canary\'s trusted execution environment' });
    assert.equal(a.cause, 'environment');
    assert.ok(a.reason.includes(SEALED_ENV_CANNOT_RESOLVE));
    assert.deepEqual(a.missing, []);
  });

  it('ENVIRONMENT: an operator-authorized directory that has since vanished, when the child says so too', () => {
    const a = attributeStepFailure({ ...base, vanishedDirs: [path.join(TMP, 'gone-dir')] });
    assert.equal(a.cause, 'environment');
    assert.match(a.reason, /sealed at setup is also gone/);
    assert.match(a.reason, /gone-dir/);
    assert.match(a.next, /--toolchain-dir/);
  });

  it('PROJECT: a vanished directory alone never blames the environment for a real failure', () => {
    const a = attributeStepFailure({ ...base, exitCode: 1, output: 'AssertionError: expected 1 to equal 2', vanishedDirs: [path.join(TMP, 'gone-dir')] });
    assert.equal(a.cause, 'project');
    assert.match(a.reason, new RegExp(PROJECT_CHECK_FAILURE));
  });

  it('PROJECT: a project-local tool npm provides is not an environment question', () => {
    // A real file in npm's own script PATH: `tsc: not found` from a project whose node_modules/.bin is
    // on the child's PATH is the PROJECT's problem (the dependency is missing), not Canary's narrowing.
    const binDir = path.join(TMP, 'staged-project', 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, WINDOWS ? 'tsc.cmd' : 'tsc'), 'staged\n');
    const a = attributeStepFailure({ ...base, output: 'tsc: not found', childPathDirs: [binDir] });
    assert.equal(a.cause, 'project');
    assert.match(a.reason, new RegExp(PROJECT_CHECK_FAILURE));
  });

  it('aggregates a run: the environment cause wins, and EVERY remediation is printed', () => {
    const agg = attributeFailures([{ ...base }, { ...base, kind: 'build', script: 'build', output: 'java: not found' }]);
    assert.equal(agg.cause, 'environment');
    assert.deepEqual(agg.missing, ['git', 'java']);
    assert.ok(agg.reason.includes(SEALED_ENV_CANNOT_RESOLVE));
    assert.equal(attributeFailures([{ ...base, exitCode: 1, output: 'AssertionError' }]).cause, 'project');
  });
});

describe('npm\'s own script PATH is part of the resolution walk', () => {
  it('includes node_modules/.bin for the step directory and its ancestors', () => {
    const nested = path.join(TMP, 'pkg', 'sub');
    fs.mkdirSync(nested, { recursive: true });
    const dirs = npmScriptDirs(nested);
    assert.ok(dirs.includes(path.join(nested, 'node_modules', '.bin')));
    assert.ok(dirs.includes(path.join(TMP, 'pkg', 'node_modules', '.bin')));
    assert.ok(dirs.length <= 25);
  });
});

describe('product level: a path with spaces is sealed and used verbatim', () => {
  it('setup accepts --toolchain-dir with spaces, records it, and the sealed step sees it', () => {
    const root = path.join(TMP, 'spaced-fixture');
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    // The check proves the directory reached the CHILD environment: it fails unless the staged
    // directory (whose path contains spaces) is on the PATH the child was handed.
    fs.writeFileSync(path.join(root, 'check.cjs'),
      "'use strict';\n"
      + 'const path = require(\'node:path\');\n'
      + `const want = ${JSON.stringify(SPACED_DIR)};\n`
      + "const dirs = (process.env.PATH || '').split(path.delimiter);\n"
      + "if (!dirs.includes(want)) { console.error('the authorized directory never reached the child PATH'); process.exit(3); }\n"
      + "console.log('authorized directory present in the sealed step PATH');\n");
    fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({ name: 'spaced-fixture', private: true, scripts: { test: 'node check.cjs' } }, null, 2)}\n`);
    for (const a of [['init', '-b', 'main'], ['config', 'user.email', 'probe@canary.local'], ['config', 'user.name', 'Spaced Fixture'], ['add', '-A'], ['commit', '-m', 'initial']]) {
      const r = spawnSync('git', ['-C', root, ...a], { encoding: 'utf8', timeout: 60_000 });
      assert.equal(r.status, 0, `fixture git ${a[0]} failed: ${r.stdout}${r.stderr}`);
    }
    const run = spawnSync(process.execPath, [CLI, 'setup', '--yes', '--toolchain-dir', SPACED_DIR], {
      cwd: root, env: { ...process.env, CANARY_TRUST_STORE: path.join(TMP, 'trust-spaced') }, encoding: 'utf8', timeout: 300_000,
    });
    const out = `${run.stdout}${run.stderr}`;
    assert.equal(run.status, 0, `setup exited ${run.status}:\n${out.split(/\r?\n/).slice(-12).join('\n')}`);
    assert.match(out, /READY/);
    const cfg = JSON.parse(fs.readFileSync(path.join(root, '.canary', 'canary.local.json'), 'utf8')) as { toolchain?: ToolchainSeal };
    assert.deepEqual(cfg.toolchain?.dirs, [fs.realpathSync.native(SPACED_DIR)], 'the sealed config did not record the directory verbatim');
    assert.ok(Object.keys(cfg.toolchain?.found ?? {}).length >= 3, 'the setup-time inventory was not recorded');
  });
});
