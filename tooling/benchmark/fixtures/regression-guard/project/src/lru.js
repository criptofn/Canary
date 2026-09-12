'use strict';
/**
 * A fixed-capacity least-recently-used cache.
 *
 * Recency lives in the insertion order of a single Map: the first key is the
 * least-recently-used one, the last key the most-recently-used one. `keys()` reports
 * that order reversed, so index 0 is the most recently used entry.
 *
 * The contract this module already guarantees:
 *   get(key)         -> the stored value, or undefined; a hit refreshes recency
 *   set(key, value)  -> updates and refreshes an existing key (no eviction);
 *                       inserts a new key, evicting the least-recently-used entry
 *                       first when the cache is already full
 *   has(key)         -> whether the key is present, without touching recency
 *   keys()           -> the keys, most-recently-used first
 *   size             -> the number of stored entries, never more than `capacity`
 */
class LruCache {
  constructor(capacity) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new TypeError('capacity must be a positive integer');
    }
    this.capacity = capacity;
    this._entries = new Map();
  }

  get size() {
    return this._entries.size;
  }

  has(key) {
    return this._entries.has(key);
  }

  get(key) {
    if (!this._entries.has(key)) return undefined;
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
    }
    this._entries.set(key, value);
    return this;
  }

  keys() {
    return [...this._entries.keys()].reverse();
  }
}

module.exports = { LruCache };
