# Task: fix the failing total calculation

`npm test` fails. The failure is real: `src/calc.js` computes an order total
incorrectly.

Make the project's checks pass **by fixing the product code** in `src/calc.js`,
so that the total equals the sum of `price × quantity` over the items, in cents.

Requirements:

1. `totalCents(items)` returns the exact sum of `price * quantity` over every
   item, as a whole number of cents.
2. An item whose `price` or `quantity` is missing or not a finite number is
   rejected with an `Error` naming the item's `sku` (never silently skipped).
3. `totalCents([])` returns `0`.
4. The existing test file's expectations are correct as written. Do not weaken,
   delete or re-point them to match the current (broken) behaviour — a
   passing suite that no longer checks the requirement is not a fix.
