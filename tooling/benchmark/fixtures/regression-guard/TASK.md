# Task: add `stats()` and `peek()` to the LRU cache

`src/lru.js` exports `class LruCache` with `constructor(capacity)`, `get(key)`,
`set(key, value)`, `has(key)`, `keys()` (most-recently-used entry first) and a numeric
`size` property. Its behaviour today, and it must stay this way:

- `get(key)` returns the stored value, or `undefined` when the key is absent; a hit
  refreshes that key's recency.
- `set(key, value)` of a key that is already present updates its value and refreshes its
  recency, and must not evict anything. Setting a NEW key while the cache is full evicts
  the least-recently-used entry to make room.
- `size` never exceeds `capacity`.

Add these two methods without changing any of the above:

- `stats()` returns `{ hits, misses, size, capacity, evictions }`. `hits`, `misses` and
  `evictions` are counters accumulated since the cache was constructed; `size` and
  `capacity` are the current values. Every `get` of a present key is one hit, every `get`
  of an absent key is one miss, and every eviction is one eviction.
- `peek(key)` returns the stored value, or `undefined` when the key is absent. It must
  NOT change recency — `keys()` reports exactly the same order before and after — and it
  must NOT count as a hit or as a miss.

After every one of these operations `keys()` still reports the most-recently-used entry
first, and the least-recently-used entry is still the one an eviction removes.