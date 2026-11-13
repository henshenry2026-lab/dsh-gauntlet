import assert from 'node:assert/strict'
import test from 'node:test'

import { addMoney, formatCents, roundCents, splitEvenly } from '../src/index.mjs'

test('roundCents rounds half away from zero', () => {
  assert.equal(roundCents(0), 0)
  assert.equal(roundCents(0.4), 0)
  assert.equal(roundCents(0.5), 1)
  assert.equal(roundCents(-0.5), -1)
  assert.equal(roundCents(1.5), 2)
  assert.equal(roundCents(-1.5), -2)
})

test('roundCents rejects what it cannot represent', () => {
  assert.throws(() => roundCents(Number.NaN), TypeError)
  assert.throws(() => roundCents(Number.POSITIVE_INFINITY), TypeError)
  assert.throws(() => roundCents('12'), TypeError)
})

test('addMoney sums integers', () => {
  assert.equal(addMoney(), 0)
  assert.equal(addMoney(1, 2, 3), 6)
  assert.equal(addMoney(-5, 5), 0)
})

test('addMoney rejects fractions instead of rounding them', () => {
  assert.throws(() => addMoney(1.5), TypeError)
})

test('formatCents prints two decimals with a sign', () => {
  assert.equal(formatCents(0), '$0.00')
  assert.equal(formatCents(5), '$0.05')
  assert.equal(formatCents(1234), '$12.34')
  assert.equal(formatCents(-5), '-$0.05')
})

test('splitEvenly keeps the sum exact', () => {
  assert.deepEqual(splitEvenly(10, 3), [4, 3, 3])
  assert.deepEqual(splitEvenly(0, 2), [0, 0])
  const total = splitEvenly(999, 7).reduce((sum, part) => sum + part, 0)
  assert.equal(total, 999)
})

test('splitEvenly rejects impossible splits', () => {
  assert.throws(() => splitEvenly(10, 0), RangeError)
  assert.throws(() => splitEvenly(10, 2.5), RangeError)
})
