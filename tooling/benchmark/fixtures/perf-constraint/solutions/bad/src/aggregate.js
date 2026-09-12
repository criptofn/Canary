'use strict';
/**
 * KNOWN-BAD solution #1 — the most plausible WRONG answer.
 *
 * It keeps the quadratic scan over the output array and bolts on a memo of the LAST
 * key it matched, which is the shortcut an agent reaches for when it "optimises" the
 * repeated-key case: a second consecutive row with the same key is answered without
 * scanning.
 *
 * Output order and semantics are identical to the contract, so the small visible
 * suite stays green. Nothing changes asymptotically: with 2,000 DISTINCT keys every
 * row still walks the whole output array, so each row is read O(n) times.
 */
function aggregate(rows, field) {
  const out = [];
  let lastKey = null;
  let lastEntry = null;
  for (const row of rows) {
    const key = row[field];
    if (typeof key !== 'string' || key === '') continue;
    let entry = null;
    if (lastKey === row[field]) {
      entry = lastEntry;
    } else {
      for (const candidate of out) {
        if (candidate.key === row[field]) { entry = candidate; break; }
      }
      lastKey = key;
      lastEntry = entry;
    }
    if (entry === null) {
      entry = { key, count: 0, sum: 0 };
      out.push(entry);
      lastKey = key;
      lastEntry = entry;
    }
    entry.count += 1;
    if (typeof row.value === 'number' && Number.isFinite(row.value)) entry.sum += row.value;
  }
  return out;
}

module.exports = { aggregate };
