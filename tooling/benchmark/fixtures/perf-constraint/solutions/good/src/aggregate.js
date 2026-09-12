'use strict';
/**
 * KNOWN-GOOD solution: one Map lookup per row, first-appearance order preserved by
 * pushing an entry the first time a key is seen, all counters exactly as specified,
 * and the caller's array and rows left untouched.
 */
function aggregate(rows, field) {
  const byKey = new Map();
  const out = [];
  for (const row of rows) {
    const key = row[field];
    if (typeof key !== 'string' || key === '') continue;
    let entry = byKey.get(key);
    if (entry === undefined) {
      entry = { key, count: 0, sum: 0 };
      byKey.set(key, entry);
      out.push(entry);
    }
    entry.count += 1;
    if (typeof row.value === 'number' && Number.isFinite(row.value)) entry.sum += row.value;
  }
  return out;
}

module.exports = { aggregate };
