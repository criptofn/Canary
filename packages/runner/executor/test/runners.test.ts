/**
 * Provider-neutral runner observation — the registry cannot lie about itself.
 *
 * What these tests pin (v1.1 item A, extended in Phase 2):
 *  1. The STRONG set is EXACTLY `{mocha, node-test, pytest, unittest}` — every one
 *     of them backed by a channel whose bytes are Canary's and an authority that
 *     binds it. Adding a runner is a claim about IMPLEMENTATION, so it must fail
 *     here until the evidence exists — that is the point.
 *  2. Every STRONG row on a non-package authority names a `channelModule` that
 *     EXISTS on disk: a capability nobody can open is not a capability.
 *  3. The remaining runners resolve to INCONCLUSIVE_ONLY with a stated reason, and
 *     unknown runners do too. A strong label can never be reached through an
 *     unobserved runner.
 *  4. `runnerRegistryProblems()` is empty: no STRONG without an authority, no
 *     INCONCLUSIVE_ONLY without a reason, no duplicate claims.
 *  5. Resolution is deterministic and totality holds (no input throws).
 *  6. Every declared protocol AGREES with the implemented OBSERVER_VERSION — the
 *     declaration cannot drift from the implementation it describes.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { OBSERVER_VERSION } from '../src/observation.js';
import {
  RUNNER_ADAPTERS, UNVERIFIED_RUNNER, normalizeProgram, observationCapabilityFor,
  resolveRunnerAdapter, runnerCapabilityTable, runnerRegistryProblems,
} from '../src/runners.js';

/** The repository root, found by walking up from this test file. */
function repoRoot(): string {
  let dir = import.meta.dirname;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'tooling', 'probes'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('repository root not found from ' + import.meta.dirname);
}

describe('runner registry — internal consistency', () => {
  it('has no problems: every STRONG has an authority, every INCONCLUSIVE_ONLY a stated reason', () => {
    assert.deepEqual(runnerRegistryProblems(), []);
  });

  it('the STRONG set is exactly {mocha, node-test, pytest, unittest} — a claim that must be earned, not typed', () => {
    const strong = RUNNER_ADAPTERS.filter((a) => a.capability === 'STRONG').map((a) => a.id).sort();
    assert.deepEqual(strong, ['mocha', 'node-test', 'pytest', 'unittest'],
      'adding or removing a STRONG runner requires a Canary-owned channel, an authority for it, and an executed probe; '
      + 'update this assertion in the same change that brings them');
  });

  it('every STRONG row names the authority that binds it, and package-pin names a real npm release', () => {
    const byId = new Map(RUNNER_ADAPTERS.map((a) => [a.id, a]));
    assert.equal(byId.get('mocha')?.observation?.authority, 'package-pin');
    assert.equal(byId.get('mocha')?.observation?.pinKey, 'mocha');
    // The Node runtime's own runner needs no grant: the runner IS the verifying
    // runtime, which is why this authority kind exists at all.
    assert.equal(byId.get('node-test')?.observation?.authority, 'runtime-identity');
    assert.equal(byId.get('pytest')?.observation?.authority, 'operator-identity');
    assert.equal(byId.get('unittest')?.observation?.authority, 'operator-identity');
  });

  it('every non-package STRONG row names a channel module that EXISTS, and says what was executed', () => {
    const root = repoRoot();
    for (const a of RUNNER_ADAPTERS) {
      if (a.capability !== 'STRONG' || a.observation?.authority === 'package-pin') continue;
      const rel = a.observation?.channelModule;
      assert.ok(rel, `${a.id}: a non-package STRONG claim must name its channel module`);
      assert.ok(fs.existsSync(path.join(root, rel!)),
        `${a.id}: channel module ${rel} does not exist — a capability nobody can open is not a capability`);
      assert.ok((a.measuredOn ?? '').length > 20, `${a.id}: must record what was actually executed`);
    }
  });

  it('every declared observer protocol equals the implemented OBSERVER_VERSION', () => {
    for (const a of RUNNER_ADAPTERS) {
      if (a.capability !== 'STRONG') continue;
      assert.equal(a.observation?.protocol, OBSERVER_VERSION,
        `${a.id}: the registry describes an observer that must be the one observation.ts actually implements`);
    }
  });

  it('every registered adapter is reachable, so no entry is decorative', () => {
    for (const a of RUNNER_ADAPTERS) {
      const viaProgram = a.programs.length > 0 && a.id !== 'node-test'
        ? resolveRunnerAdapter({ program: a.programs[0] })
        : null;
      const viaScript = a.scriptMarkers.length > 0
        ? resolveRunnerAdapter({ script: markerSourceFor(a) })
        : null;
      assert.ok(viaProgram?.id === a.id || viaScript?.id === a.id,
        `${a.id} cannot be resolved by its own declarations`);
    }
  });
});

/** A script body that satisfies at least one of an adapter's markers. */
function markerSourceFor(a: { id: string; scriptMarkers: readonly RegExp[] }): string {
  switch (a.id) {
    case 'node-test': return 'node --test';
    case 'pytest': return 'pytest -q';
    case 'unittest': return 'python -m unittest discover';
    case 'cargo-test': return 'cargo test';
    case 'go-test': return 'go test ./...';
    default: return a.id;
  }
}

describe('runner registry — the INCONCLUSIVE floor is structural', () => {
  const nonStrong = [
    ['jest', { program: 'jest' }],
    ['vitest', { program: 'vitest' }],
    ['ava', { program: 'ava' }],
    ['cargo-test', { script: 'cargo test --all' }],
    ['go-test', { script: 'go test ./...' }],
  ] as const;

  for (const [id, ref] of nonStrong) {
    it(`${id} is recognised, and can never earn a strong label`, () => {
      const d = observationCapabilityFor(ref);
      assert.equal(d.runner, id, 'the runner must be recognised by name');
      assert.equal(d.capability, 'INCONCLUSIVE_ONLY');
      assert.ok((d.reason ?? '').length > 40, 'the reason must actually explain the gap, not gesture at it');
      assert.equal(d.observation, undefined, 'an unobserved runner must not carry an observation contract');
    });
  }

  it('an unknown runner is unknown, and says so — never silently treated as observed', () => {
    for (const ref of [{ program: 'totally-made-up-runner' }, { script: 'frobnicate --all' }, {}]) {
      const d = observationCapabilityFor(ref);
      assert.equal(d.runner, 'unknown');
      assert.equal(d.capability, 'INCONCLUSIVE_ONLY');
      assert.match(d.reason ?? '', /not registered|unknown/i);
    }
  });

  it('a bare `node` invocation is NOT classified as a test runner', () => {
    // Every Node script runs under `node`; the name alone carries no information
    // about whether a test runner is involved, so it must not resolve.
    assert.equal(resolveRunnerAdapter({ program: 'node' }), null);
    assert.equal(observationCapabilityFor({ program: 'node' }).runner, 'unknown');
  });

  it('only mocha reports a package pin, and it names it', () => {
    const d = observationCapabilityFor({ program: 'mocha' });
    assert.equal(d.capability, 'STRONG');
    assert.equal(d.observation?.pinKey, 'mocha');
    assert.equal(d.reason, undefined);
  });

  it('the newly strong runners report STRONG with their authority, and never a package pin', () => {
    for (const [ref, authority] of [
      [{ script: 'node --test' }, 'runtime-identity'],
      [{ program: 'pytest' }, 'operator-identity'],
      [{ script: 'python -m unittest discover' }, 'operator-identity'],
    ] as const) {
      const d = observationCapabilityFor(ref);
      assert.equal(d.capability, 'STRONG');
      assert.equal(d.observation?.authority, authority);
      assert.equal(d.observation?.pinKey, undefined,
        'a runner that is not an npm package must not borrow the package-pin story');
      assert.equal(d.reason, undefined);
    }
  });
});

describe('runner registry — resolution is normalised, deterministic and total', () => {
  it('normalises paths and Windows executable extensions', () => {
    assert.equal(normalizeProgram('C:\\a\\b\\MOCHA.CMD'), 'mocha');
    assert.equal(normalizeProgram('/usr/local/bin/pytest'), 'pytest');
    assert.equal(normalizeProgram('jest.exe'), 'jest');
    assert.equal(normalizeProgram(''), '');
  });

  it('resolves the same program written every reasonable way', () => {
    for (const p of ['mocha', 'MOCHA', 'mocha.cmd', 'C:\\repo\\node_modules\\.bin\\mocha.cmd', '/x/mocha']) {
      assert.equal(observationCapabilityFor({ program: p }).runner, 'mocha', `failed for ${p}`);
    }
  });

  it('a program match outranks a script match', () => {
    // `mocha` in the script text must not shadow the fact that the program
    // actually being run is pytest.
    assert.equal(observationCapabilityFor({ program: 'pytest', script: 'mocha' }).runner, 'pytest');
  });

  it('never throws for hostile or empty input', () => {
    for (const ref of [{}, { program: '' }, { script: '' }, { program: '...' }, { program: 'a/b/c' }]) {
      assert.doesNotThrow(() => observationCapabilityFor(ref));
    }
  });

  it('the reporting table names every adapter and never overstates one', () => {
    const table = runnerCapabilityTable();
    assert.equal(table.length, RUNNER_ADAPTERS.length);
    for (const row of table) {
      assert.ok(row.why.length > 20, `${row.id}: the table must explain itself`);
      if (row.capability !== 'STRONG') assert.doesNotMatch(row.why, /^injected observer/);
    }
  });

  it('a runner that was MEASURED on a host says so, and one that was not says nothing', () => {
    // v1.1 Phase 2: "blocked" and "not tried" must be distinguishable. A row
    // that was actually executed carries measuredOn; a row that was not must not
    // pretend it was.
    const table = runnerCapabilityTable();
    const byId = new Map(table.map((r) => [r.id, r]));
    for (const id of ['cargo-test', 'go-test', 'unittest', 'node-test', 'pytest']) {
      assert.ok((byId.get(id)?.measuredOn ?? '').length > 20, `${id} was executed on this host and must record it`);
    }
    // jest/vitest/ava were NOT executed here; they must not claim evidence.
    for (const id of ['jest', 'vitest', 'ava']) {
      assert.equal(byId.get(id)?.measuredOn, undefined, `${id} was never executed and must not claim measured evidence`);
    }
  });

  it('the synthesized unknown adapter is never strong and carries no pin', () => {
    assert.equal(UNVERIFIED_RUNNER.capability, 'INCONCLUSIVE_ONLY');
    assert.equal(UNVERIFIED_RUNNER.observation, undefined);
    assert.ok((UNVERIFIED_RUNNER.blockedBy ?? '').length > 0);
  });
});
