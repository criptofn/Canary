In `src/workflows/fileOrganizer.js`, `previewOrganization` skips the age filter whenever `options.maxAgeDays` is falsy:

```js
if (options.maxAgeDays && ageDays > options.maxAgeDays) continue;
```

so an explicit `maxAgeDays: 0` is treated as "no age filter at all" — the exact opposite of what the caller asked for.

Make an explicit numeric `maxAgeDays` always take effect, including `0`:
- `maxAgeDays: 0` must keep only files whose age in days is not greater than 0;
- `maxAgeDays: <n>` for n > 0 must keep only files whose age is not greater than n days;
- `undefined` and `null` must still mean "no age filter";
- any other type (a string, a boolean, NaN) must still be treated as "no age filter" rather than crashing.

Keep every other behaviour of the function unchanged.
