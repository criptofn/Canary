'use strict';
/**
 * Row aggregation.
 *
 * `aggregate(rows, field)` groups rows by the value of their `field` property and
 * returns one entry per key, in the order the keys FIRST APPEAR in `rows`:
 *
 *   [{ key, count, sum }, ...]
 *
 *   - `count` is the number of rows whose `field` value is a non-empty string;
 *   - `sum` adds `row.value` only when it is a finite number; a row whose `value` is
 *     missing or non-numeric still counts, it just contributes 0;
 *   - a row whose `field` value is not a non-empty string is skipped entirely.
 *
 * The implementation below is correct but QUADRATIC: for every row it scans the
 * output array built so far to find the key. It is fine for the small inputs in
 * `tests/` and unusable for a large one.
 */
function aggregate(rows, field) {
  const out = [];
  for (const row of rows) {
    const key = row[field];
    if (typeof key !== 'string' || key === '') continue;
    let entry = null;
    for (const candidate of out) {
      if (candidate.key === row[field]) { entry = candidate; break; }
    }
    if (entry === null) {
      entry = { key, count: 0, sum: 0 };
      out.push(entry);
    }
    entry.count += 1;
    if (typeof row.value === 'number' && Number.isFinite(row.value)) entry.sum += row.value;
  }
  return out;
}

module.exports = { aggregate };
