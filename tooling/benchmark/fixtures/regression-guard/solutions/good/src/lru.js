'use strict';
/**
 * KNOWN-GOOD solution for the cache task: `stats()` and `peek()` exactly as the task
 * states them, with every pre-existing invariant untouched. `peek` is a pure read — it
 * neither touches the recency order nor the counters — while `get` keeps counting and
 * refreshing, and the eviction path is the least-recently-used entry, one at a time.
 */
class LruCache {
  constructor(capacity) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new TypeError('capacity must be a positive integer');
    }
    this.capacity = capacity;
    this._entries = new Map();
    this._hits = 0;
    this._misses = 0;
    this._evictions = 0;
  }

  get size() {
    return this._entries.size;
  }

  has(key) {
    return this._entries.has(key);
  }

  get(key) {
    if (!this._entries.has(key)) {
      this._misses += 1;
      return undefined;
    }
    this._hits += 1;
    const value = this._entries.get(key);
    this._entries.delete(key);
    this._entries.set(key, value);
    return value;
  }

  peek(key) {
    return this._entries.has(key) ? this._entries.get(key) : undefined;
  }

  set(key, value) {
    if (this._entries.has(key)) {
      this._entries.delete(key);
      this._entries.set(key, value);
      return this;
    }
    if (this._entries.size >= this.capacity) {
      const leastRecentlyUsed = this._entries.keys().next().value;
      this._entries.delete(leastRecentlyUsed);
      this._evictions += 1;
    }
    this._entries.set(key, value);
    return this;
  }

  keys() {
    return [...this._entries.keys()].reverse();
  }

  stats() {
    return {
      hits: this._hits,
      misses: this._misses,
      size: this._entries.size,
      capacity: this.capacity,
      evictions: this._evictions,
    };
  }
}

module.exports = { LruCache };
