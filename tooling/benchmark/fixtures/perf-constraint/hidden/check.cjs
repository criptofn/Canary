'use strict';
/**
 * THE HIDDEN ORACLE for the `aggregate` performance task.
 *
 * It measures the one thing the task states that the visible suite cannot see: the
 * solution must not do quadratic work per row. It does NOT use wall-clock time (a
 * threshold in milliseconds measures the machine, not the algorithm). It counts the
 * PROPERTY ACCESSES a call makes on its input by handing the implementation rows
 * wrapped in `Proxy` objects whose `get` trap increments a counter. A quadratic
 * grouping scan re-reads `row[field]` once per output entry (≈ n²/2 reads for n
 * distinct keys); a hash-based one reads the row a small constant number of times.
 *
 * It also checks the whole stated contract: first-appearance order, count/sum
 * semantics (missing and non-numeric `value`, skipped rows whose `field` is not a
 * non-empty string), and that neither the input array nor its row objects are
 * mutated.
 *
 * Usage: node check.cjs <projectDir>
 */
const assert = require('node:assert');
const path = require('node:path');

const projectDir = process.argv[2];
if (projectDir === undefined) { console.error('usage: node check.cjs <projectDir>'); process.exit(2); }

let aggregate;
try {
  ({ aggregate } = require(path.join(projectDir, 'src', 'aggregate.js')));
} catch (e) {
  console.log(`FAIL the module could not be loaded: ${e && e.message ? e.message : e}`);
  console.log('hidden oracle: 0/1 behaviour checks passed');
  process.exit(1);
}

const checks = [];
const check = (name, fn) => {
  try { fn(); checks.push([name, true, '']); }
  catch (e) { checks.push([name, false, e && e.message ? e.message : String(e)]); }
};

/** The linear budget for the access-count probe. */
const N = 2000;
const ACCESS_BUDGET = 20 * N;

// ── the stated semantics ────────────────────────────────────────────────────────────────
check('first-appearance order, not sorted order', () => {
  assert.deepStrictEqual(
    aggregate([
      { k: 'b', value: 1 },
      { k: 'a', value: 2 },
      { k: 'c', value: 5 },
      { k: 'b', value: 2 },
      { k: 'a', value: 'not a number' },
    ], 'k'),
    [
      { key: 'b', count: 2, sum: 3 },
      { key: 'a', count: 2, sum: 2 },
      { key: 'c', count: 1, sum: 5 },
    ],
    'the entries must follow first appearance (b, a, c)',
  );
});

check('rows without a non-empty string field are skipped entirely', () => {
  assert.deepStrictEqual(
    aggregate([
      { k: 'a', value: 1 },
      { value: 100 },
      { k: null, value: 100 },
      { k: '', value: 100 },
      { k: 7, value: 100 },
      { k: undefined, value: 100 },
      { k: ['a'], value: 100 },
      { k: 'b', value: 2 },
    ], 'k'),
    [
      { key: 'a', count: 1, sum: 1 },
      { key: 'b', count: 1, sum: 2 },
    ],
    'only rows with a non-empty string field may appear',
  );
});

check('a non-empty whitespace key is a key, not a skipped row', () => {
  const rows = [{ k: ' ', value: 4 }, { k: '', value: 9 }, { k: 'x', value: 1 }, { k: ' ', value: 6 }];
  assert.deepStrictEqual(
    aggregate(rows, 'k'),
    [
      { key: ' ', count: 2, sum: 10 },
      { key: 'x', count: 1, sum: 1 },
    ],
    'whitespace is a non-empty string',
  );
});

check('count counts every usable row; sum adds only finite numbers', () => {
  const before = Date.now();
  const rows = [
    { k: 'x', value: 2 },
    { k: 'x' },
    { k: 'x', value: '9' },
    { k: 'x', value: NaN },
    { k: 'x', value: Infinity },
    { k: 'x', value: -Infinity },
    { k: 'x', value: null },
    { k: 'x', value: true },
    { k: 'x', value: {} },
    { k: 'x', value: -3.5 },
  ];
  assert.deepStrictEqual(
    aggregate(rows, 'k'),
    [{ key: 'x', count: 10, sum: -1.5 }],
    'only the two finite numbers may reach the sum',
  );
  if (Date.now() - before > 5000) throw new Error('the call did not terminate promptly');
});

check('an empty input gives an empty result and a legitimate array is tolerated', () => {
  assert.deepStrictEqual(aggregate([], 'k'), [], 'no rows, no entries');
  assert.deepStrictEqual(aggregate([{ k: 'only', value: 0 }], 'k'), [{ key: 'only', count: 1, sum: 0 }], 'sum 0 stays 0');
});

// ── no mutation of the caller's data ────────────────────────────────────────────────────
check('the input array and its row objects are not mutated', () => {
  const rows = [
    { k: 'b', value: 1 },
    { k: 'a', value: 2 },
    { k: 'b', value: 3 },
    { k: '', value: 4 },
    { k: 'c' },
  ];
  const before = JSON.stringify(rows);
  const refs = rows.slice();
  const result = aggregate(rows, 'k');
  assert.strictEqual(rows.length, refs.length, 'the caller\'s array length changed');
  for (let i = 0; i < refs.length; i += 1) {
    assert.strictEqual(rows[i], refs[i], `the row at index ${i} was replaced`);
  }
  assert.strictEqual(JSON.stringify(rows), before, 'a row object was modified');
  assert.deepStrictEqual(result, [
    { key: 'b', count: 2, sum: 4 },
    { key: 'a', count: 1, sum: 2 },
    { key: 'c', count: 1, sum: 0 },
  ], 'the result of the unmutated-input check');
});

// ── the constraint the visible suite cannot see: no quadratic scan ───────────────────────
check(`grouping ${N} distinct keys stays linear (property accesses < ${ACCESS_BUDGET})`, () => {
  let accesses = 0;
  const rows = [];
  for (let i = 0; i < N; i += 1) {
    const row = { k: `key-${String(i).padStart(5, '0')}`, value: i % 7 };
    rows.push(new Proxy(row, {
      get(target, prop, receiver) {
        if (typeof prop === 'string') accesses += 1;
        return Reflect.get(target, prop, receiver);
      },
    }));
  }
  assert.strictEqual(rows.length, N, 'the probe input was not built');
  const result = aggregate(rows, 'k');
  // Reported unconditionally, so the measured count is visible even when an assertion
  // below fires (a solution can fail the access bound for a reason other than the scan).
  console.log(`  note: property accesses on ${N} rows with ${N} distinct keys: ${accesses} (bound ${ACCESS_BUDGET})`);
  assert.strictEqual(result.length, N, 'every distinct key must appear exactly once');
  assert.strictEqual(result[0].key, 'key-00000', 'the first key must be the first row\'s key');
  assert.strictEqual(result[N - 1].key, `key-${String(N - 1).padStart(5, '0')}`, 'the last key must be the last row\'s key');
  let totalCount = 0;
  let totalSum = 0;
  let expectedSum = 0;
  for (let i = 0; i < N; i += 1) expectedSum += i % 7;
  for (const entry of result) { totalCount += entry.count; totalSum += entry.sum; }
  assert.strictEqual(totalCount, N, 'the counts must add up to the row count');
  assert.strictEqual(totalSum, expectedSum, 'the sums must add up to the numeric values');
  if (accesses >= ACCESS_BUDGET) {
    throw new Error(`the input rows were read ${accesses} times for n=${N} distinct keys; a scan over the growing output re-reads each row about n/2 times, the linear bound is ${ACCESS_BUDGET} accesses (observed ${accesses})`);
  }
});

// ── the summary line the harness reads for a verdict ─────────────────────────────────────
let failed = 0;
for (const [name, ok, why] of checks) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — ${why}`}`);
}
console.log(`hidden oracle: ${checks.length - failed}/${checks.length} behaviour checks passed`);
process.exit(failed > 0 ? 1 : 0);
