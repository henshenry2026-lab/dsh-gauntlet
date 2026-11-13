# cents

A tiny money library: integer cents in, integer cents out. No floating point
money, no locale formatting, no dependencies.

```sh
npm test        # node --test test/
npm run tiers   # regenerate src/tiers.generated.mjs from src/config.mjs
```

## Layout

| Path | Role |
|---|---|
| `src/config.mjs` | Currency, decimal count, tier thresholds and rates. The source of truth. |
| `src/money.mjs` | Rounding, addition, formatting and even splitting. |
| `src/discount.mjs` | Tier lookup and discount application. |
| `src/ledger.mjs` | A `Ledger` of entries with per-region balances. |
| `src/tiers.generated.mjs` | **Generated** by `tools/gen-tiers.mjs`. Never edit by hand. |
| `src/index.mjs` | Public surface. Consumers import from here and nowhere else. |

## Conventions

- Every amount is an integer number of cents. Fractions are rejected, not rounded.
- Rounding is half away from zero, matching the invoice system this replaced.
- Tiers are half-open: a subtotal of exactly `10000` cents is already tier 1.
