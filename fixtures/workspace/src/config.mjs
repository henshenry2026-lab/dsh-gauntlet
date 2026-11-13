// Currency settings and the discount ladder. This module is the source of
// truth: src/tiers.generated.mjs is derived from it by tools/gen-tiers.mjs.

export const CURRENCY = 'USD'
export const DECIMALS = 2
export const MAX_AMOUNT_CENTS = 100000000
export const TIER_THRESHOLDS = Object.freeze([0, 10000, 50000, 200000])
export const TIER_RATES = Object.freeze([0, 0.05, 0.1, 0.15])

export function tierCount() {
  return TIER_RATES.length
}
