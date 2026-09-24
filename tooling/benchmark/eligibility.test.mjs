/**
 * v1.5 post-audit — the regression for the headline-aggregate eligibility contract.
 *
 * The CONFIRMED audit finding was that a cell whose tokens came from the fallback
 * estimator (`streamed per-message usage (no result event)`, with the harness's own
 * `streamedUsageUsable: false`) was pooled with provider-native cells into one
 * published percentage. These tests pin the contract that made that impossible to
 * repeat, and they are written as ADVERSARIAL cases: each one is a record shaped to
 * slip into a headline if the rule is ever loosened.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { aggregateCells, cellEligibility, PROVIDER_NATIVE_SOURCE } from './eligibility.mjs';

/** A record that is eligible: the shape eleven of the twelve published cells had. */
const good = (totalTokens = 1000, arm = 'guarded') => ({
  arm,
  agent: { exitCode: 0 },
  agentResult: {
    isError: false, parseFailure: false,
    usage: { totalTokens, source: 'result.usage (session, excludes earlier fresh input)' },
  },
  stream: { sawResult: true, streamedUsageUsable: false },
});

describe('cellEligibility: a headline cell must have completed on the declared ledger', () => {
  it('accepts a completed provider-native cell', () => {
    const e = cellEligibility(good());
    assert.equal(e.eligible, true, e.reasons.join('; '));
    assert.equal(e.total, 1000);
  });

  it('REJECTS the exact record the auditor found — fallback accounting, not provider-native', () => {
    // Copied field-for-field from v15-everyday-r2-stateful-replay-guarded-1.json.
    const audited = {
      arm: 'guarded',
      agent: { exitCode: 4294967295 },
      agentResult: {
        isError: true, parseFailure: true, subtype: '',
        usage: { totalTokens: 131099, source: 'streamed per-message usage (no result event)' },
      },
      stream: { sawResult: false, streamedUsageUsable: false },
    };
    const e = cellEligibility(audited);
    assert.equal(e.eligible, false, 'the audited cell must NOT be headline-eligible');
    assert.ok(e.reasons.some((r) => /not the declared provider-native ledger/.test(r)),
      `a reason must name the accounting method; got: ${e.reasons.join(' | ')}`);
    assert.ok(e.reasons.some((r) => /no terminal result event/.test(r)), e.reasons.join(' | '));
    assert.ok(e.reasons.some((r) => /exit code/.test(r)), e.reasons.join(' | '));
  });

  it('rejects every other way a partial run could smuggle a partial total in', () => {
    const cases = [
      ['non-zero exit', { agent: { exitCode: 1 } }],
      ['timed out', { agent: { timedOut: true } }],
      ['isError', { agentResult: { isError: true } }],
      ['parseFailure', { agentResult: { parseFailure: true } }],
      ['no terminal result event', { stream: { sawResult: false } }],
      ['unknown source', { agentResult: { usage: { source: null } } }],
      ['a DIFFERENT estimator', { agentResult: { usage: { source: 'estimated bytes/4' } } }],
      ['zero total', { agentResult: { usage: { totalTokens: 0 } } }],
      ['absent total', { agentResult: { usage: { totalTokens: undefined } } }],
      ['non-numeric total', { agentResult: { usage: { totalTokens: 'lots' } } }],
    ];
    for (const [name, patch] of cases) {
      const rec = good();
      // Shallow-merge the patch one level deep, which is how these records nest.
      for (const [k, v] of Object.entries(patch)) rec[k] = { ...(rec[k] ?? {}), ...v };
      const e = cellEligibility(rec);
      assert.equal(e.eligible, false, `${name} must be INELIGIBLE (reasons: ${e.reasons.join('; ')})`);
    }
  });

  it('the declared source pattern is the provider-native ledger and nothing else', () => {
    assert.ok(PROVIDER_NATIVE_SOURCE.test('result.usage (session, excludes earlier fresh input)'));
    for (const bad of ['streamed per-message usage (no result event)', 'estimate', '', 'modelUsage only']) {
      assert.ok(!PROVIDER_NATIVE_SOURCE.test(bad), `must not accept "${bad}" as provider-native`);
    }
  });
});

describe('aggregateCells: a hole makes the aggregate INCOMPLETE, never a percentage', () => {
  it('excludes an ineligible cell from the totals and reports the aggregate incomplete', () => {
    const cells = [
      { run: 'r', task: 'a', arm: 'plain', record: good(161453, 'plain') },
      { run: 'r', task: 'b', arm: 'plain', record: good(71504, 'plain') },
      { run: 'r', task: 'a', arm: 'guarded', record: good(131099, 'guarded') },
      // The audited shape, wearing the guarded arm.
      {
        run: 'r', task: 'b', arm: 'guarded',
        record: {
          agent: { exitCode: 4294967295 },
          agentResult: { isError: true, parseFailure: true, usage: { totalTokens: 999999999, source: 'streamed per-message usage (no result event)' } },
          stream: { sawResult: false, streamedUsageUsable: false },
        },
      },
    ];
    const agg = aggregateCells(cells);
    assert.equal(agg.complete, false, 'an aggregate containing an ineligible cell is INCOMPLETE');
    assert.equal(agg.incomplete.length, 1);
    // THE POINT: the ineligible cell's tokens (999,999,999 - large enough to move any
    // ratio) must be absent from every total.
    assert.equal(agg.totals.guarded, 131099, 'the ineligible total leaked into the guarded arm');
    assert.equal(agg.totals.plain, 232957);
  });

  it('a cheaper FAILED cell cannot flatter the ratio — it is not counted at all', () => {
    // Adversarial: the failed cell is far cheaper than the good one. If it were pooled,
    // the guarded arm would look dramatically better than it is.
    const withFailedCheap = aggregateCells([
      { arm: 'plain', record: good(100000, 'plain') },
      { arm: 'guarded', record: good(90000, 'guarded') },
      {
        arm: 'guarded',
        record: {
          agent: { exitCode: 1 },
          agentResult: { usage: { totalTokens: 1, source: 'streamed per-message usage (no result event)' } },
          stream: { sawResult: false },
        },
      },
    ]);
    assert.equal(withFailedCheap.complete, false);
    assert.equal(withFailedCheap.totals.guarded, 90000, 'a failed cheap cell must not lower the arm total');
    assert.equal(withFailedCheap.totals.plain, 100000);
  });

  it('reports complete only when every cell is eligible', () => {
    const agg = aggregateCells([
      { arm: 'plain', record: good(10, 'plain') },
      { arm: 'guarded', record: good(9, 'guarded') },
    ]);
    assert.equal(agg.complete, true);
    assert.deepEqual(agg.totals, { plain: 10, guarded: 9 });
  });
});
