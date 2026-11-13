import assert from 'node:assert/strict'
import test from 'node:test'

import { applyDiscount, describeTiers, rateFor, tierFor } from '../src/index.mjs'

test('tierFor uses half-open ranges', () => {
  assert.equal(tierFor(0), 0)
  assert.equal(tierFor(9999), 0)
  assert.equal(tierFor(10000), 1)
  assert.equal(tierFor(49999), 1)
  assert.equal(tierFor(50000), 2)
  assert.equal(tierFor(199999), 2)
  assert.equal(tierFor(200000), 3)
  assert.equal(tierFor(9999999), 3)
})

test('tierFor rejects negative and fractional subtotals', () => {
  assert.throws(() => tierFor(-1), RangeError)
  assert.throws(() => tierFor(1.5), TypeError)
})

test('describeTiers reports the configured ladder', () => {
  assert.deepEqual(describeTiers(), [
    { from: 0, rate: 0 },
    { from: 10000, rate: 0.05 },
    { from: 50000, rate: 0.1 },
    { from: 200000, rate: 0.15 },
  ])
})

test('rateFor returns the rate of the matching tier', () => {
  assert.equal(rateFor(0), 0)
  assert.equal(rateFor(10000), 0.05)
  assert.equal(rateFor(200000), 0.15)
})

// Only the zero-rate tier is exercised here: below 10000 cents the discount is
// a no-op, which keeps this test independent of the rate table.
test('applyDiscount is a no-op below the first tier', () => {
  assert.equal(applyDiscount(0), 0)
  assert.equal(applyDiscount(1), 1)
  assert.equal(applyDiscount(9999), 9999)
})
