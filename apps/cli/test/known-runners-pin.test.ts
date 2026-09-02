/**
 * Post-GLM panel K — the pin table must never drift from the bytes it names.
 *
 * KNOWN_RUNNER_RELEASES is the ONLY authority that says "these runner bytes
 * may receive Canary's observer". The canary-double entry names files that
 * LIVE IN THIS REPO, so the equality table==disk is checkable here on every
 * platform: editing the double without re-pinning (or re-pinning a hash no
 * checkout produces) fails this test, not a confusing mid-e2e ABSENT.
 * (The real-mocha entries have no repo bytes to hash, but they are NOT
 * self-certifying: support/known-runners-manifest.test.ts recomputes each
 * npm pin from a committed review manifest of the registry tarball, and the
 * golden proof end-to-end-checks it against a live install.)
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { KNOWN_RUNNER_RELEASES, treeSha256 } from '@canary-rn/support';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..'); // dist/test -> dist -> cli -> apps -> repo root

describe('KNOWN_RUNNER_RELEASES — table == disk (canary-double)', () => {
  it('the pinned double hash equals the treeSha256 of the repo fixture bytes', () => {
    const double = (KNOWN_RUNNER_RELEASES.mocha ?? []).find((p) => p.origin === 'canary-double');
    assert.ok(double, 'the canary-double pin must exist (offline e2e has no other injectable runner)');
    const onDisk = treeSha256(path.join(REPO, 'apps', 'cli', 'test', 'fixtures', 'mocha-double'));
    assert.equal(onDisk, double.treeSha256,
      'double bytes changed without re-pinning (or eol normalization struck — see .gitattributes): the pin MUST be the bytes that exist');
  });

  it('no placeholder digests survive, every entry is well-formed, versions unique per package', () => {
    for (const [pkg, pins] of Object.entries(KNOWN_RUNNER_RELEASES)) {
      assert.ok(pins.length >= 1, `${pkg} has no pins at all — locate/pin code paths would be dead`);
      const seen = new Set<string>();
      for (const p of pins) {
        assert.match(p.treeSha256, /^[0-9a-f]{64}$/, `${pkg}@${p.version}: not a sha256 hex`);
        assert.notEqual(p.treeSha256, '0'.repeat(64), `${pkg}@${p.version}: ZERO-placeholder must never ship (fail-closed placeholder)`);
        assert.notEqual(p.treeSha256, 'f'.repeat(64), `${pkg}@${p.version}: all-f placeholder`);
        assert.ok(!seen.has(p.version), `${pkg}@${p.version}: duplicate version entries (findRunnerPin first-match ambiguity)`);
        seen.add(p.version);
        assert.ok(p.note.length > 0, `${pkg}@${p.version}: an unexplained pin is an unaudited pin`);
      }
    }
    // The golden runner release is load-bearing for the committed proof;
    // pinning the string here means ANY edit to it is a deliberate act.
    // The hash's REAL anchor is the offline review manifest (support
    // known-runners-manifest.test.ts recomputes table == reviewed registry
    // bytes); this literal makes swapping even that act deliberate, and the
    // live golden prove still end-to-end-checks it against npm. (2f4a706
    // once pinned 68a0a02c… from an unverifiable one-off probe — the
    // manifest test is why that class of mistake can't recur silently.)
    assert.ok((KNOWN_RUNNER_RELEASES.mocha ?? []).some((p) => p.version === '10.8.2'
      && p.treeSha256 === '4b811f5a8bc5848bbef919adb49d8bfc10d6774e98215acd2e78713ae34cdb58' && p.origin === 'npm'),
      'golden mocha@10.8.2 npm pin must stand exactly as reviewed');
  });
});
