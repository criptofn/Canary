# Task: accept decimal strings as amounts

`formatMoney(cents, options)` in `src/money.js` takes an amount in **cents** as an
integer.

Make it ALSO accept a decimal string such as `"12.34"` (meaning 12 dollars and 34
cents) and format it identically to `formatMoney(1234)`. Accept an optional leading
`-` for negatives. A string that is not a valid decimal amount must keep throwing the
same `TypeError` the function already throws for a non-number.

**Every documented behaviour in the file's header comment must keep working**, in
particular: the negative sign before the symbol, `decimals: 0`, `grouping: false`,
a custom `symbol`, and the `round` modes.
