# Task: make money formatting currency-aware

The package formats money in US dollars only, across three files. Add currency
support without breaking what callers already depend on.

Create `src/currency.js` exporting `format(amountCents, currency)`:

1. an explicit table of currencies — USD (`$`), EUR (`€`), GBP (`£`) — holding each
   code's symbol;
2. the amount is rendered in that currency's minor units as a decimal string with
   two decimals and the symbol prefixed: `format(12.35, 'EUR')` → `€12.35`,
   `format(13, 'USD')` → `$13.00`; the plain number form must not gain a thousands
   separator;
3. `amount` may arrive either as a number or as a numeric string (`'12.35'`);
4. an unknown currency code must throw an `Error` whose message contains the
   offending code.

Keep `formatMoney(amount)` in `src/money.js` working EXACTLY as it does today
(`$12.35` for both `12.35` and `'12.35'`); it is now a deprecated alias for
`format(amount, 'USD')`.

Make the cart currency-aware: `Cart.total(currency = 'USD')` returns the summed
line items formatted in the requested currency, and `'USD'` stays the default.
Keep `src/index.js` exporting the public surface: `formatMoney`, `format` and
`Cart`.
