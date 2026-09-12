# Pricing

Volume discounts for invoices. Every amount in this project is carried as whole
cents; `config/pricing.json` is the source of truth for the rate table.

## Discount rates

| Minimum subtotal (cents) | Discount rate |
| --- | --- |
| 0 | 0% |
| 10000 | 5% |
| 50000 | 25% |

## Notes

- The rate that applies to a subtotal is the one from the highest tier whose `min`
  is less than or equal to that subtotal.
- `discountedTotal(subtotalCents, config)` returns the discounted amount in whole
  cents.
- `formatCents` renders cents for display, for example `1234` becomes `$12.34`.
