#!/usr/bin/env node
/**
 * v1.4 — deterministic, model-free coverage for the one fact the standalone
 * distribution build depends on.
 *
 * WHY THIS TEST EXISTS: `tooling/standalone.mjs` pinned nothing and the CI job
 * pinned `node-version: 22`, so for two releases all three standalone legs died
 * with `FAIL: node --build-sea failed (status 9)` — an exit code that means
 * "invalid command line argument", printed with no explanation and easy to
 * misread as a broken artifact. The rule is a boundary comparison, so it is
 * tested as one: no build, no spawn, no host assumption.
 *
 * The boundary itself is MEASURED, not guessed: Node's documentation records
 * `--build-sea` as "Added in: v25.5.0"
 * (https://nodejs.org/api/single-executable-applications.html, History table,
 * read 2026-09-20). The versions either side of the boundary below are the
 * documented ones, and the "just below" case is the exact version CI used.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MIN_SEA_NODE, seaCapable, seaRequirement } from './sea-capability.mjs';

describe('the single-executable build knows which Node can perform it', () => {
  it('states the documented boundary', () => {
    assert.equal(MIN_SEA_NODE, '25.5.0', 'the boundary is the version Node documents for --build-sea');
  });

  it('refuses every Node below the boundary — including the one CI pinned', () => {
    // The version CI actually used. Exit 9, no message, artifact never produced.
    assert.equal(seaCapable('22.22.0'), false, 'Node 22 is what CI pinned: it cannot build this');
    assert.equal(seaCapable('20.11.1'), false);
    assert.equal(seaCapable('23.9.0'), false);
    assert.equal(seaCapable('24.11.0'), false, 'the previous LTS still has no --build-sea');
    assert.equal(seaCapable('25.4.0'), false, 'one minor below the boundary');
  });

  it('accepts the boundary itself and everything above it', () => {
    assert.equal(seaCapable('25.5.0'), true, 'the version that ADDED the flag must pass');
    assert.equal(seaCapable('25.5.1'), true);
    assert.equal(seaCapable('25.6.0'), true);
    assert.equal(seaCapable('26.3.0'), true, 'the version this workflow pins for the build');
    assert.equal(seaCapable('26.7.0'), true);
    assert.equal(seaCapable('30.0.0'), true, 'a future major must not need a code change');
  });

  it('compares numerically, not as strings (25.10 is newer than 25.9)', () => {
    assert.equal(seaCapable('25.10.0'), true, 'a string compare would wrongly reject this');
    assert.equal(seaCapable('26.0.0'), true);
    assert.equal(seaCapable('100.0.0'), true);
  });

  it('fails CLOSED on a version string it cannot read', () => {
    for (const junk of ['', 'garbage', 'v25.5.0', '25', 'x.y.z', '25.x']) {
      assert.equal(seaCapable(junk), false, `${JSON.stringify(junk)} must not be read as capable`);
    }
  });

  it('the refusal answers WHAT HAPPENED, WHY, and WHAT TO DO', () => {
    const text = seaRequirement('22.22.0');
    assert.match(text, /does not provide `--build-sea`/, 'names what happened');
    assert.match(text, /added in Node v25\.5\.0/, 'says why this host cannot do it');
    assert.match(text, /exits 9/, 'names the unhelpful symptom a reader would otherwise see');
    assert.match(text, /npm run standalone` on Node >= 25\.5\.0/, 'says what to do');
    assert.match(text, /node tooling\/pack\.mjs/, 'names the platform-neutral alternative');
    assert.match(text, /CLI itself still runs on Node >= 22/, 'does not overstate the runtime requirement');
  });
});
