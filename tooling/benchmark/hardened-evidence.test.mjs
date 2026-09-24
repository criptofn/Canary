/**
 * v1.5 post-audit — the regression for BLOCKER 3 (stale saved HARDENED evidence).
 *
 * `classifySavedEvidence` must never promote a saved transcript into a current
 * measurement, and the probe must never print a current PASS from one. Both halves are
 * pinned here: the classification as a pure function, and the probe's structure as a
 * source-level assertion (the same technique `v13-standing-context.mjs` uses, because the
 * live path can only be exercised by running a real battery).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifySavedEvidence, FRESHNESS_CEILING_MS } from './hardened-evidence.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const MIN = 60 * 1000;
const NOW = 1_800_000_000_000;

/** A transcript that is as perfect as a SAVED transcript can be. */
const perfect = (over = {}) => ({
  host: 'HOST-A',
  store: 'C:\\store',
  finishedAt: NOW - MIN,          // one minute old
  controlsHeld: 6,
  ...over,
});
const env = (over = {}) => ({ now: NOW, hostname: 'HOST-A', storeExists: () => true, ...over });

describe('classifySavedEvidence: a saved transcript is never current', () => {
  it('refuses to call even a perfect transcript current, and says why', () => {
    const c = classifySavedEvidence(perfect(), env());
    assert.equal(c.current, false);
    assert.equal(c.verdict, 'HISTORICAL');
    // The load-bearing reason: currency needs a heartbeat from NOW, which no file has.
    assert.ok(c.reasons.some((r) => /live broker heartbeat/.test(r)), c.reasons.join(' | '));
    // ...and no OTHER reason fires, so the refusal rests on the real invariant.
    assert.equal(c.reasons.length, 1, `only the heartbeat reason should apply here; got: ${c.reasons.join(' | ')}`);
    assert.equal(c.facts.fresh, true);
    assert.equal(c.facts.hostMatches, true);
    assert.equal(c.facts.storePresent, true);
  });

  it('CASE: expired freshness — names the age and the product ceiling', () => {
    const c = classifySavedEvidence(perfect({ finishedAt: NOW - 854 * MIN }), env());
    assert.equal(c.current, false);
    assert.ok(c.reasons.some((r) => /854\.0 min old/.test(r) && /15 min ceiling/.test(r)), c.reasons.join(' | '));
    assert.equal(c.facts.fresh, false);
  });

  it('CASE: host mismatch — names both hosts', () => {
    const c = classifySavedEvidence(perfect({ host: 'HOST-B' }), env());
    assert.equal(c.current, false);
    assert.ok(c.reasons.some((r) => /HOST-B/.test(r) && /HOST-A/.test(r)), c.reasons.join(' | '));
    assert.equal(c.facts.hostMatches, false);
  });

  it('CASE: deployment mismatch — the described store is gone', () => {
    const c = classifySavedEvidence(perfect({ store: 'C:\\gone' }), env({ storeExists: () => false }));
    assert.equal(c.current, false);
    assert.ok(c.reasons.some((r) => /store the transcript describes is not present/.test(r)), c.reasons.join(' | '));
    assert.equal(c.facts.storePresent, false);
  });

  it('is total on malformed input and still refuses', () => {
    for (const bad of [undefined, null, {}, { finishedAt: 'yesterday' }, { host: '' }, { store: '' }]) {
      const c = classifySavedEvidence(bad, env());
      assert.equal(c.current, false, `input ${JSON.stringify(bad)} must not be current`);
      assert.ok(c.reasons.length > 0, 'a refusal must always carry a reason');
    }
  });

  it('cannot be tricked into current by ANY combination of favourable facts', () => {
    // Exhaustive over the three facts a file could get right.
    for (const fresh of [true, false]) {
      for (const host of ['HOST-A', 'HOST-B']) {
        for (const store of [true, false]) {
          const c = classifySavedEvidence(
            perfect({ finishedAt: fresh ? NOW - MIN : NOW - 1000 * MIN, host }),
            env({ storeExists: () => store }),
          );
          assert.equal(c.current, false, `current must be false for fresh=${fresh} host=${host} store=${store}`);
        }
      }
    }
  });

  it('the ceiling matches the product\'s own 15-minute window', () => {
    assert.equal(FRESHNESS_CEILING_MS, 15 * 60 * 1000);
  });
});

describe('the probe cannot present saved evidence as a current verdict', () => {
  const src = fs.readFileSync(path.join(repo, 'tooling/probes/v15-hardened-boundary.mjs'), 'utf8');

  it('--from-saved exits 2 and never 0', () => {
    assert.match(src, /RESULT: HISTORICAL EVIDENCE ONLY[\s\S]{0,120}?process\.exit\(2\)/,
      'the historical path must exit 2 — an exit 0 from saved evidence reads as a pass');
  });

  it('--from-saved labels its banner unmistakably', () => {
    assert.match(src, /HISTORICAL EVIDENCE — NON-AUTHORITATIVE FOR CURRENT STATE/);
    assert.match(src, /NOT ESTABLISHED FOR CURRENT STATE/, 'the summary must not read MEASURED in historical mode');
  });

  it('a FAILED live battery stops the run instead of falling through to an older file', () => {
    // The audited defect: the probe printed "the battery did not pass" and then kept
    // going, reporting the stale transcript's controls as PASS.
    assert.match(src, /FAILED LIVE RUN/);
    assert.match(src, /a saved file cannot rescue a[\s\S]{0,80}?failed live measurement/);
    const failedBlock = src.slice(src.indexOf('FAILED LIVE RUN'));
    assert.match(failedBlock.slice(0, 900), /process\.exit\(4\)/,
      'the failed-live path must exit before section 3 reads the saved transcript');
    assert.ok(!/did not pass, so no control may be reported as PASS below/.test(src),
      'the old fall-through wording must be gone, not merely reworded');
  });

  it('the current PASS wording survives for the LIVE path only', () => {
    assert.match(src, /RESULT: PASS — all six controls measured on this host\./);
    assert.match(src, /HOST UNSUPPORTED/);
  });
});
