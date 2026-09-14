# Task: `parseDuration` must accept only well-formed durations

`parseDuration(text)` in `src/duration.js` converts a duration string into a number of minutes.

The accepted form is a sequence of one or more `<number><unit>` groups, with no separators, where
`<unit>` is `h` (hours) or `m` (minutes) and `<number>` is one or more digits:

- `"90m"` → `90`
- `"2h"` → `120`
- `"1h30m"` → `90`
- `"1h"` → `60`

Anything else is **invalid** and must throw an error whose message contains `invalid duration`:

- `"1h30"` — a number with no unit is not a group
- `"90"` — a bare number is not a duration
- `"m90"` — a unit with no number is not a group
- `"1x"` — `x` is not a unit
- `""` — an empty string is not a duration

Leading zeros are allowed (`"01h"` → `60`), and a group may be repeated (`"1h1h"` → `120`).
