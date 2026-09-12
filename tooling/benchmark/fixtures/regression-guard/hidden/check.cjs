'use strict';
/**
 * THE HIDDEN ORACLE for the LRU-cache task.
 *
 * It checks the two ADDITIONS the task asks for (`stats()` and `peek()`), and the
 * INVARIANTS the project already had — a hit refreshes recency, an update refreshes
 * without evicting, an eviction takes the least-recently-used entry, capacity is a hard
 * ceiling, and `keys()` keeps reporting most-recently-used first. Those invariants are
 * exactly what a plausible `peek()` implementation trades away: routing `peek` through
 * the same code path as `get` costs one line and looks correct.
 *
 * Usage: node check.cjs <projectDir>
 */
const path = require('node:path');

const projectDir = process.argv[2];
if (projectDir === undefined) { console.error('usage: node check.cjs <projectDir>'); process.exit(2); }

// A load failure is recorded, not thrown and not an early exit: every check below then
// reports it and the run still ends with its summary line and a non-zero exit.
let LruCache;
let loadError = '';
try {
  ({ LruCache } = require(path.join(projectDir, 'src', 'lru.js')));
} catch (e) {
  loadError = e && e.message ? e.message : String(e);
}

const checks = [];
const check = (name, fn) => {
  try { fn(); checks.push([name, true, '']); }
  catch (e) { checks.push([name, false, e && e.message ? e.message : String(e)]); }
};
const fail = (msg) => { throw new Error(msg); };
const ok = (cond, msg) => { if (!cond) fail(msg); };
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) fail(`${label}: expected ${b}, got ${a}`);
};
const make = (capacity) => {
  if (loadError !== '') fail(`the module could not be loaded: ${loadError}`);
  if (typeof LruCache !== 'function') fail('LruCache is not exported as a constructor');
  return new LruCache(capacity);
};
const statsOf = (cache) => {
  if (typeof cache.stats !== 'function') fail('stats() is missing');
  const s = cache.stats();
  if (s === null || typeof s !== 'object') fail(`stats() did not return an object (got ${JSON.stringify(s)})`);
  for (const k of ['hits', 'misses', 'size', 'capacity', 'evictions']) {
    if (typeof s[k] !== 'number') fail(`stats().${k} should be a number, got ${JSON.stringify(s[k])}`);
  }
  return s;
};
const statsEq = (cache, expected, label) => {
  const s = statsOf(cache);
  for (const [k, v] of Object.entries(expected)) {
    if (s[k] !== v) fail(`${label}: stats().${k} should be ${v}, got ${JSON.stringify(s[k])}`);
  }
};
const peekOf = (cache, key) => {
  if (typeof cache.peek !== 'function') fail('peek() is missing');
  return cache.peek(key);
};

// ── stats(): the counters ────────────────────────────────────────────────────────────
check('stats: a fresh cache reports zero counters and its current size/capacity', () => {
  const c = make(3);
  statsEq(c, { hits: 0, misses: 0, size: 0, capacity: 3, evictions: 0 }, 'a fresh capacity-3 cache');
});

check('stats: get counts exactly one hit and one miss', () => {
  const c = make(2);
  c.set('a', 1);
  eq(c.get('a'), 1, 'get of a present key');
  eq(c.get('absent'), undefined, 'get of an absent key');
  statsEq(c, { hits: 1, misses: 1, size: 1, capacity: 2, evictions: 0 }, 'after one hit and one miss');
});

check('stats: a mixed get/peek/set scenario keeps every counter exact', () => {
  const c = make(3);
  c.set('a', 1);
  c.set('b', 2);
  c.set('c', 3);
  eq(c.get('a'), 1, 'hit on a');          // hits 1; order a, c, b
  eq(peekOf(c, 'b'), 2, 'peek b');        // no counter, no reorder; order a, c, b
  c.set('d', 4);                          // full -> evicts b; evictions 1; order d, a, c
  eq(c.get('b'), undefined, 'b was evicted'); // misses 1
  eq(peekOf(c, 'c'), 3, 'peek c');        // no counter, no reorder; order d, a, c
  eq(c.get('c'), 3, 'hit on c');          // hits 2; order c, d, a
  c.set('c', 33);                         // update: no eviction; order c, d, a
  eq(c.get('c'), 33, 'the updated value'); // hits 3
  eq(c.keys(), ['c', 'd', 'a'], 'keys after the mixed scenario');
  statsEq(c, { hits: 3, misses: 1, size: 3, capacity: 3, evictions: 1 }, 'after the mixed scenario');
});

// ── peek(): a pure read ──────────────────────────────────────────────────────────────
check('peek: returns the value and undefined for an absent key', () => {
  const c = make(2);
  c.set('a', 'A');
  eq(peekOf(c, 'a'), 'A', 'peek of a present key');
  eq(peekOf(c, 'absent'), undefined, 'peek of an absent key');
});

check('peek: does not count as a hit or as a miss', () => {
  const c = make(2);
  c.set('a', 1);
  c.set('b', 2);
  peekOf(c, 'a');
  peekOf(c, 'b');
  peekOf(c, 'absent');
  statsEq(c, { hits: 0, misses: 0, size: 2, capacity: 2, evictions: 0 }, 'after three peeks');
  c.get('a');
  c.get('absent');
  statsEq(c, { hits: 1, misses: 1 }, 'peek must not have moved the counters');
});

check('peek: does not change the order reported by keys()', () => {
  const c = make(3);
  c.set('a', 1);
  c.set('b', 2);
  c.set('c', 3);
  eq(c.keys(), ['c', 'b', 'a'], 'keys before the peeks');
  eq(peekOf(c, 'a'), 1, 'peek the least-recently-used key');
  eq(c.keys(), ['c', 'b', 'a'], 'keys after peeking at the least-recently-used key');
  eq(peekOf(c, 'c'), 3, 'peek the most-recently-used key');
  eq(c.keys(), ['c', 'b', 'a'], 'keys after peeking at the most-recently-used key');
  eq(c.get('a'), 1, 'a get still refreshes recency');
  eq(c.keys(), ['a', 'c', 'b'], 'peek must not have disabled the refresh a get performs');
});

check('peek: does not evict and does not change size', () => {
  const c = make(1);
  c.set('a', 1);
  eq(peekOf(c, 'a'), 1, 'peek the only entry');
  eq(peekOf(c, 'absent'), undefined, 'peek an absent key');
  eq(c.size, 1, 'size after peeking');
  eq(c.has('a'), true, 'the peeked entry must still be present');
  eq(c.keys(), ['a'], 'keys after peeking');
  statsEq(c, { evictions: 0, size: 1 }, 'peeking must not evict');
});

// ── the pre-existing invariants ──────────────────────────────────────────────────────
check('invariant: a get hit refreshes recency and a get miss does not reorder', () => {
  const c = make(3);
  c.set('a', 1);
  c.set('b', 2);
  c.set('c', 3);
  eq(c.get('a'), 1, 'get of a present key');
  eq(c.keys(), ['a', 'c', 'b'], 'a moved to the front');
  eq(c.get('absent'), undefined, 'get of an absent key');
  eq(c.keys(), ['a', 'c', 'b'], 'a miss must not reorder anything');
});

check('invariant: setting an existing key updates it, refreshes recency and evicts nothing', () => {
  const c = make(2);
  c.set('a', 1);
  c.set('b', 2);
  eq(c.keys(), ['b', 'a'], 'keys before the update');
  c.set('a', 99);
  eq(c.get('a'), 99, 'the updated value');
  eq(c.has('b'), true, 'b must survive the update');
  eq(c.keys(), ['a', 'b'], 'the updated key is now the most recently used');
  statsEq(c, { size: 2, capacity: 2, evictions: 0 }, 'an update must not evict');
});

check('invariant: the least-recently-used entry is the one evicted', () => {
  const c = make(3);
  c.set('a', 1);
  c.set('b', 2);
  c.set('c', 3);
  c.get('a');
  c.set('d', 4);
  eq(c.has('b'), false, 'b was the least recently used and should be gone');
  eq(c.has('a'), true, 'a was refreshed by get and must survive');
  eq(c.has('c'), true, 'c must survive');
  eq(c.keys(), ['d', 'a', 'c'], 'keys after the eviction');
  statsEq(c, { size: 3, evictions: 1, hits: 1, misses: 0 }, 'after the eviction');
});

check('invariant: size never exceeds capacity under repeated inserts', () => {
  const c = make(2);
  for (let i = 0; i < 10; i += 1) {
    c.set(`k${i}`, i);
    ok(c.size <= 2, `size ${c.size} exceeded the capacity of 2 after inserting k${i}`);
  }
  eq(c.size, 2, 'size after ten inserts into a capacity-2 cache');
  eq(c.keys(), ['k9', 'k8'], 'only the two most recent keys remain');
  statsEq(c, { size: 2, capacity: 2, evictions: 8 }, 'after ten inserts');
});

check('invariant: keys() lists the most-recently-used entry first', () => {
  const c = make(3);
  c.set('x', 1);
  c.set('y', 2);
  c.set('z', 3);
  eq(c.keys(), ['z', 'y', 'x'], 'keys in most-recently-used order');
  c.get('x');
  eq(c.keys(), ['x', 'z', 'y'], 'keys after refreshing x');
  eq(c.keys(), ['x', 'z', 'y'], 'keys is a snapshot, not a live view');
});

let failed = 0;
for (const [name, wasOk, why] of checks) {
  if (!wasOk) failed += 1;
  console.log(`${wasOk ? 'PASS' : 'FAIL'} ${name}${wasOk ? '' : ` — ${why}`}`);
}
console.log(`hidden oracle: ${checks.length - failed}/${checks.length} behaviour checks passed`);
process.exit(failed > 0 ? 1 : 0);
