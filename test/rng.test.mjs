import assert from 'node:assert/strict'
import test from 'node:test'

import { createRng, normalizeSeed, seedFromText, MAX_SEED } from '../src/engine/rng.mjs'

test('the same seed produces the same sequence', () => {
  const a = createRng(12345)
  const b = createRng(12345)
  const left = [a.next(), a.next(), a.next(), a.next()]
  const right = [b.next(), b.next(), b.next(), b.next()]
  assert.deepEqual(left, right)
})

test('a different seed produces a different sequence', () => {
  const a = createRng(1)
  const b = createRng(2)
  const left = [a.next(), a.next(), a.next()]
  const right = [b.next(), b.next(), b.next()]
  assert.notDeepEqual(left, right)
})

test('floats stay inside [0, 1)', () => {
  const rng = createRng(0xdeadbeef)
  for (let index = 0; index < 10_000; index += 1) {
    const value = rng.next()
    assert.ok(value >= 0 && value < 1, `out of range: ${value}`)
  }
})

test('int covers both ends of its range', () => {
  const rng = createRng(99)
  const seen = new Set()
  for (let index = 0; index < 2_000; index += 1) seen.add(rng.int(1, 6))
  assert.deepEqual([...seen].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6])
})

test('int refuses an empty range', () => {
  const rng = createRng(1)
  assert.throws(() => rng.int(5, 4), RangeError)
})

test('pick refuses an empty list instead of returning undefined', () => {
  const rng = createRng(1)
  assert.throws(() => rng.pick([]), RangeError)
  assert.equal(rng.pick(['only']), 'only')
})

test('shuffle is a permutation and leaves its input alone', () => {
  const source = [1, 2, 3, 4, 5, 6, 7, 8]
  const rng = createRng(7)
  const shuffled = rng.shuffle(source)
  assert.deepEqual(source, [1, 2, 3, 4, 5, 6, 7, 8], 'the input must not be mutated')
  assert.deepEqual([...shuffled].sort((a, b) => a - b), source)
})

test('chance respects its bounds', () => {
  const rng = createRng(3)
  assert.equal(rng.chance(0), false)
  assert.equal(rng.chance(1), true)
})

test('seedFromText is stable and never zero', () => {
  assert.equal(seedFromText('gauntlet'), seedFromText('gauntlet'))
  assert.notEqual(seedFromText('a'), seedFromText('b'))
  for (const text of ['', '0', 'x', 'dsh-gauntlet:truncated-tail']) {
    const seed = seedFromText(text)
    assert.ok(seed > 0 && seed <= MAX_SEED, `seed out of range for ${text}: ${seed}`)
  }
})

test('normalizeSeed treats an absent seed as the fallback, not as random', () => {
  const first = normalizeSeed(undefined, 'scenario:one')
  const second = normalizeSeed(undefined, 'scenario:one')
  assert.equal(first, second)
  assert.equal(normalizeSeed(null, 'scenario:one'), first)
  assert.equal(normalizeSeed('', 'scenario:one'), first)
})

test('normalizeSeed accepts numbers and numeric strings', () => {
  assert.equal(normalizeSeed(42, 'x'), 42)
  assert.equal(normalizeSeed('42', 'x'), 42)
  assert.equal(normalizeSeed(' 42 ', 'x'), 42)
  assert.equal(normalizeSeed(0, 'x'), 1, 'zero is remapped so it cannot stall the generator')
})

test('normalizeSeed hashes a word', () => {
  assert.equal(normalizeSeed('word', 'x'), seedFromText('word'))
})
