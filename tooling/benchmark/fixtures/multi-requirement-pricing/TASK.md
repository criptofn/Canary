# Task: implement tiered discounts in the pricing module

`discountedTotal(subtotalCents, config)` in `src/pricing.js` currently returns the
subtotal untouched. Implement the tiered discount, satisfying every rule below.

1. The applicable rate is the `rate` of the tier with the HIGHEST `min` that is less
   than or equal to the subtotal in cents. `config.tiers` holds them, and
   `config/pricing.json` must keep exactly the tiers it has now: `min` 0 → rate 0,
   `min` 10000 → rate 0.1, `min` 50000 → rate 0.2 (`min` in cents, `rate` a fraction).
2. The discounted result is rounded HALF-UP to whole cents and returned as a whole
   number of cents: 10% off 10005 cents is 9004.5, which rounds to 9005 — a value
   ending in .5 always rounds up, never to even. 10% off 10050 cents is 9045.
3. A `config` that is missing (absent, `null` or `undefined`), malformed, or whose
   tiers do not strictly increase must fail closed: throw an `Error` whose message is
   a non-empty, human-readable description of the problem (a bare "error"/"invalid"
   does not count). That covers a missing or empty `tiers` array, a `tiers` value that
   is not an array, a tier without a numeric `min` or `rate`, and a tier list that is
   out of order or repeats a boundary. Returning the undiscounted subtotal is never an
   acceptable answer for such a config.
4. The `Discount rates` table in `README.md` must match `config/pricing.json` exactly:
   the same tier boundaries in cents and the same rates, no stale row and no missing
   row. Fix the README wherever it currently disagrees.
5. `formatCents(cents)` in `src/format.js` keeps its current behaviour (`1234` →
   `$12.34`), and subtotals below the first paid tier — including 0 — are still
   returned unchanged.
