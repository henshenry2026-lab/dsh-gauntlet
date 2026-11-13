// The discount ladder. Tiers are half-open: `from` is inclusive, so a subtotal
// of exactly 10000 is already tier 1.

import { TIER_RATES, TIER_THRESHOLDS } from './config.mjs'
import { roundCents } from './money.mjs'

export function tierFor(subtotalCents) {
  if (!Number.isInteger(subtotalCents)) {
    throw new TypeError('subtotalCents must be an integer number of cents')
  }
  if (subtotalCents < 0) throw new RangeError('subtotalCents must not be negative')
  let tier = 0
  for (let index = 0; index < TIER_THRESHOLDS.length; index += 1) {
    if (subtotalCents >= TIER_THRESHOLDS[index]) tier = index
  }
  return tier
}

export function rateFor(subtotalCents) {
  return TIER_RATES[tierFor(subtotalCents)]
}

export function applyDiscount(subtotalCents) {
  const rate = rateFor(subtotalCents)
  return subtotalCents - roundCents(subtotalCents * rate)
}

export function describeTiers() {
  const rows = []
  for (let index = 0; index < TIER_THRESHOLDS.length; index += 1) {
    rows.push({ from: TIER_THRESHOLDS[index], rate: TIER_RATES[index] })
  }
  return rows
}
