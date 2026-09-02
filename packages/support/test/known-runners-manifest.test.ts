/**
 * Post-GLM pin-integrity (the "stale probe hash" incident, 2026-09-02) —
 * every npm-origin pin in KNOWN_RUNNER_RELEASES must equal the hash that a
 * committed REVIEW MANIFEST recomputes to, checked entirely offline.
 *
 * WHY: 2f4a706 shipped mocha@10.8.2 pinned to 68a0a02c… — a value copied
 * from a one-off probe, tied to no committed artifact, and no offline test
 * noticed (the full suite stayed green; only the live golden prove exposed
 * it, as ABSENT/INCONCLUSIVE — fail-closed worked, but late). The fix is a
 * trust anchor the table cannot drift from: each npm pin names a manifest
 * under test/fixtures/runner-manifests/ whose header records the exact
 * registry tarball (integrity + sha256) a human reviewed, and whose lines
 * are the per-file digests of that tarball's package tree. Editing the
 * table without re-reviewing the registry bytes now fails `npm test`.
 *
 * The manifest format IS treeSha256's input encoding (rel + "\0" + digest +
 * "\n", sorted), so recomputation here mirrors the hash contract exactly —
 * if the contract ever changes, this test and the table fail together,
 * which is the loud, deliberate coupling.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';

import { KNOWN_RUNNER_RELEASES } from '../src/index.js';

// dist/test -> dist -> package root -> test/fixtures (rootDir is the package root)
const FIXTURES = path.resolve(import.meta.dirname, '..', '..', 'test', 'fixtures', 'runner-manifests');

/** Recompute a treeSha256 from manifest lines (the same fold the walker's
 *  results feed). Skips '#' comment/provenance headers and blank lines. */
function recomputeFromManifest(file: string): string {
  // .gitattributes forces eol=lf for these fixtures, but tolerate a hostile
  // checkout config rather than misparse: a stray \r would anchor-break the
  // digest regex and the failure would read as "malformed manifest", not
  // "wrong pin" — strip it and keep the test's claim about CONTENT.
  const lines = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n').filter((l) => l.length > 0 && !l.startsWith('#'));
  const entries = lines.map((l) => {
    const m = /^(\S+) ([0-9a-f]{64})$/.exec(l);
    const rel = m?.[1]; const digest = m?.[2];
    assert.ok(rel && digest, `malformed manifest line in ${path.basename(file)}: ${JSON.stringify(l)}`);
    return [rel, digest] as const;
  });
  const sorted = [...entries].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  assert.deepEqual(sorted.map((e) => e[0]), entries.map((e) => e[0]), `${path.basename(file)}: manifest must be path-sorted (treeSha256's order) — no silent reordering`);
  const h = crypto.createHash('sha256');
  for (const [rel, digest] of sorted) h.update(rel + '\0' + digest + '\n');
  return h.digest('hex');
}

function manifestFor(pkg: string, version: string): string {
  return path.join(FIXTURES, `${pkg}-${version}.npm.txt`);
}

describe('KNOWN_RUNNER_RELEASES — npm pins equal their reviewed manifests (offline)', () => {
  it('every npm-origin entry has a manifest and the hashes agree', () => {
    for (const [pkg, pins] of Object.entries(KNOWN_RUNNER_RELEASES)) {
      for (const p of pins) {
        if (p.origin !== 'npm') continue;
        const file = manifestFor(pkg, p.version);
        assert.ok(fs.existsSync(file),
          `${pkg}@${p.version}: npm pin without a committed review manifest is an unaudited pin — generate one from the registry tarball (see knownRunners.ts header)`);
        assert.ok(/# dist\.integrity sha512-\S+/.test(fs.readFileSync(file, 'utf8').split('\n').slice(0, 8).join('\n')),
          `${file}: manifest header must record the registry dist.integrity that was verified at review time`);
        assert.equal(recomputeFromManifest(file), p.treeSha256,
          `${pkg}@${p.version}: table hash != reviewed bytes — the pin must change only together with a re-reviewed manifest (or this fails CI offline; the live golden prove would degrade to INCONCLUSIVE, never lie)`);
      }
    }
  });

  it('canary-double entries are the ONLY non-manifested pins (offline e2e bytes live in-repo)', () => {
    for (const [pkg, pins] of Object.entries(KNOWN_RUNNER_RELEASES)) {
      for (const p of pins) {
        if (p.origin === 'npm') continue;
        assert.ok(fs.existsSync(manifestFor(pkg, p.version)) === false,
          `${pkg}@${p.version}: origin '${p.origin}' must not also carry an npm manifest (two sources of truth)`);
      }
    }
  });
});
