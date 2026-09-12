# Task: make `aggregate` scale without changing what it returns

`aggregate(rows, field)` in `src/aggregate.js` groups rows by the value of their
`field` property. It must keep returning one entry per distinct key, in the order the
keys FIRST APPEAR in `rows`:

```
[{ key, count, sum }, ...]
```

- `count` counts every row whose `field` value is a non-empty string.
- `sum` adds `row.value` only when it is a finite number. A row with a missing or
  non-numeric `value` still counts; it just contributes `0`.
- A row whose `field` value is not a non-empty string is skipped entirely.

The current implementation is correct but quadratic: for every row it scans the output
array built so far. Grouping **50,000 rows with 50,000 distinct keys** must not take
quadratic time — assume the row count can grow, and make the work per row independent
of how many keys have been seen.

Keep every behaviour above exactly as it is, including the result order and the
`{ key, count, sum }` entry shape. Do not mutate the caller's `rows` array and do not
mutate the row objects it contains. Keep the export `aggregate(rows, field)` in
`src/aggregate.js` and do not add any dependency.
