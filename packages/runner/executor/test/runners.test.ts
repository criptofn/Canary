/**
 * Provider-neutral runner observation — the registry cannot lie about itself.
 *
 * What these tests pin (v1.1 item A):
 *  1. The STRONG set is EXACTLY `{mocha}`. Adding a runner to it is a claim that
 *     an injected observer and a pinned release exist, so it must fail here
 *     until someone brings the evidence — that is the point.
 *  2. Every non-mocha runner the product recognises resolves to
 *     INCONCLUSIVE_ONLY with a stated reason, and unknown runners do too. A
 *     strong label can never be reached through an unobserved runner.
 *  3. `runnerRegistryProblems()` is empty: no STRONG without a pin, no
 *     INCONCLUSIVE_ONLY without a reason, no duplicate claims.
 *  4. Resolution is deterministic and totality holds (no input throws).
 *  5. The capability the registry reports for mocha AGREES with the real
 *     observer protocol in observation.ts — the declaration cannot drift from
 *     the implementation it describes.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { OBSERVER_VERSION } from '../src/observation.js';
import {
  RUNNER_ADAPTERS, UNVERIFIED_RUNNER, normalizeProgram, observationCapabilityFor,
  resolveRunnerAdapter, runnerCapabilityTable, runnerRegistryProblems,
} from '../src/runners.js';

describe('runner registry — internal consistency', () => {
  it('has no problems: every STRONG has a pin, every INCONCLUSIVE_ONLY a stated reason', () => {
    assert.deepEqual(runnerRegistryProblems(), []);
  });

  it('the STRONG set is exactly {mocha} — a claim that must be earned, not typed', () => {
    const strong = RUNNER_ADAPTERS.filter((a) => a.capability === 'STRONG').map((a) => a.id);
    assert.deepEqual(strong, ['mocha'],
      'adding a STRONG runner requires an injected observer + a pinned release + its reviewed manifest; '
      + 'update this assertion in the same change that brings them');
  });

  it('mocha\'s declared observer protocol equals the implemented OBSERVER_VERSION', () => {
    const mocha = RUNNER_ADAPTERS.find((a) => a.id === 'mocha');
    assert.ok(mocha?.observation, 'mocha must declare an observation contract');
    assert.equal(mocha.observation.protocol, OBSERVER_VERSION,
      'the registry describes an observer that must be the one observation.ts actually implements');
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
    ['node-test', { script: 'node --test' }],
    ['pytest', { program: 'pytest' }],
    ['unittest', { script: 'python -m unittest' }],
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

  it('only mocha reports STRONG, and it names its pin', () => {
    const d = observationCapabilityFor({ program: 'mocha' });
    assert.equal(d.capability, 'STRONG');
    assert.equal(d.observation?.pinKey, 'mocha');
    assert.equal(d.reason, undefined);
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

  it('the synthesized unknown adapter is never strong and carries no pin', () => {
    assert.equal(UNVERIFIED_RUNNER.capability, 'INCONCLUSIVE_ONLY');
    assert.equal(UNVERIFIED_RUNNER.observation, undefined);
    assert.ok((UNVERIFIED_RUNNER.blockedBy ?? '').length > 0);
  });
});
