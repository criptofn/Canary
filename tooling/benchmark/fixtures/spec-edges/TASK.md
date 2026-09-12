# Task: implement `parseDuration` to its specification

`parseDuration(text)` in `src/duration.js` converts a human duration string into a whole
number of **seconds**. It currently handles only the simplest form; implement the whole
specification below.

## Accepted forms

- one or more `<number><unit>` parts, concatenated in **descending** unit order:
  `d`, `h`, `m`, `s` (e.g. `1d2h3m4s`)
- optional whitespace **between** parts and around the whole string: `" 1h 30m "`
- units are case-insensitive: `"1H30M"` is the same as `"1h30m"`
- a single part is valid: `"90s"`, `"2m"`, `"1d"`
- `"0s"` is valid and equals 0
- numbers are non-negative integers, with no leading `+`, no fractions, no `1.5h`

## Rejected forms (each must throw a `TypeError`)

- a non-string argument (including `null`, `undefined`, numbers, objects)
- an empty or whitespace-only string
- an unknown or missing unit: `"90"`, `"1x"`
- units out of descending order, or a repeated unit: `"1m1h"`, `"1h1h"`
- a negative or signed number: `"-5s"`, `"+5s"`
- a fractional number: `"1.5h"`
- trailing garbage: `"1h30"`, `"1h!"`
- whitespace **inside** a part: `"1 h"` (space between number and unit)

Return an integer number of seconds. Do not change the module's export name or shape.
