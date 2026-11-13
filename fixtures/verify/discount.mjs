// Sealed verification: the discount ladder and its tier boundaries.
//
// Tiers are half-open, so every threshold is checked on both sides. A drifted
// threshold moves a customer from one price to another, which is why this runs
// even when the workspace's own suite is green.

import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const root = process.argv[2]
if (!root) throw new Error('usage: verify <workspace-root>')

const discount = await import(pathToFileURL(join(root, 'src', 'discount.mjs')).href)

// Half-open boundaries: the `from` value belongs to the tier it starts.
assert.equal(discount.tierFor(0), 0)
assert.equal(discount.tierFor(9999), 0)
assert.equal(discount.tierFor(10000), 1, 'a 10000-cent subtotal is already tier 1')
assert.equal(discount.tierFor(49999), 1)
assert.equal(discount.tierFor(50000), 2)
assert.equal(discount.tierFor(199999), 2)
assert.equal(discount.tierFor(200000), 3)

// The advertised ladder is the ladder in force.
assert.deepEqual(discount.describeTiers(), [
  { from: 0, rate: 0 },
  { from: 10000, rate: 0.05 },
  { from: 50000, rate: 0.1 },
  { from: 200000, rate: 0.15 },
])

// Rates follow the tier, and a zero-rate tier is a no-op.
assert.equal(discount.rateFor(0), 0)
assert.equal(discount.rateFor(10000), 0.05)
assert.equal(discount.rateFor(200000), 0.15)
assert.equal(discount.applyDiscount(9999), 9999, 'below the first tier the price must not change')
assert.equal(discount.applyDiscount(10000), 9500, 'tier 1 must take 5% off')

// Invalid input is refused rather than rounded.
assert.throws(() => discount.tierFor(-1), RangeError)
assert.throws(() => discount.tierFor(1.5), TypeError)

process.stdout.write('discount: ok\n')
