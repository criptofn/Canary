'use strict';
/**
 * KNOWN-BAD solution for the cache task, and it is the mistake this fixture exists to
 * catch: `stats()` is right, and `peek()` is written by routing it through the same
 * code path as `get()`. One line shorter, it reads as "the same lookup without the
 * eviction", and it is WRONG in the two ways the task spells out — it counts as a hit
 * and it moves the key to the most-recently-used position, so `keys()` order and every
 * counter that follows it drift. The visible suite (get/set/eviction only) stays green.
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
    // WRONG: peek reuses the get() path, so it refreshes recency and counts a hit.
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
