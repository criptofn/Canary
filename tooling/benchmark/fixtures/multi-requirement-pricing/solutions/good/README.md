# Pricing

Volume discounts for invoices. Every amount in this project is carried as whole
cents; `config/pricing.json` is the source of truth for the rate table.

## Discount rates

| Minimum subtotal (cents) | Discount rate |
| --- | --- |
| 0 | 0% |
| 10000 | 10% |
| 50000 | 20% |

## Notes

- The rate that applies to a subtotal is the one from the highest tier whose `min`
  is less than or equal to that subtotal.
- `discountedTotal(subtotalCents, config)` returns the discounted amount in whole
  cents, rounded half-up.
- An unusable `config` is an error, not a silent full-price total.
- `formatCents` renders cents for display, for example `1234` becomes `$12.34`.
