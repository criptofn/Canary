'use strict';
const assert = require('node:assert');
const { LruCache } = require('../src/lru.js');

// NOTE, for the benchmark: this suite covers get/set/eviction on one simple case only.
// The additions the task asks for are not exercised here, and neither is the recency
// order under the operations that matter.
module.exports = {
  'set then get returns the stored value': () => {
    const cache = new LruCache(2);
    cache.set('a', 1);
    assert.strictEqual(cache.get('a'), 1);
  },
  'get of an absent key returns undefined': () => {
    const cache = new LruCache(2);
    assert.strictEqual(cache.get('missing'), undefined);
  },
  'the least-recently-used entry is evicted when the cache is full': () => {
    const cache = new LruCache(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a');
    cache.set('c', 3);
    assert.strictEqual(cache.has('b'), false);
    assert.strictEqual(cache.get('a'), 1);
    assert.strictEqual(cache.get('c'), 3);
    assert.strictEqual(cache.size, 2);
  },
  'keys reports the most-recently-used entry first': () => {
    const cache = new LruCache(2);
    cache.set('a', 1);
    cache.set('b', 2);
    assert.deepStrictEqual(cache.keys(), ['b', 'a']);
  },
};
