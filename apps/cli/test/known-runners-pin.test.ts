/**
 * Post-GLM panel K — the pin table must never drift from the bytes it names.
 *
 * KNOWN_RUNNER_RELEASES is the ONLY authority that says "these runner bytes
 * may receive Canary's observer". The canary-double entry names files that
 * LIVE IN THIS REPO, so the equality table==disk is checkable here on every
 * platform: editing the double without re-pinning (or re-pinning a hash no
 * checkout produces) fails this test, not a confusing mid-e2e ABSENT.
 * (The real-mocha entries are pinned from npm installs and verified
 * end-to-end by the golden proof — there is nothing local to hash-compare.)
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
    // pinning the string here means ANY edit to it is a deliberate act that
    // also requires touching proof expectations (the golden run itself fails
    // loudly if the hash no longer matches what npm resolves).
    assert.ok((KNOWN_RUNNER_RELEASES.mocha ?? []).some((p) => p.version === '10.8.2'
      && p.treeSha256 === '68a0a02c18285db7d7aaa323b7e325c7402ca01c5020331bb370b687fbdea8c3' && p.origin === 'npm'),
      'golden mocha@10.8.2 npm pin must stand exactly as reviewed');
  });
});
