import assert from 'node:assert/strict'
import test from 'node:test'

import { Ledger } from '../src/index.mjs'

test('Ledger totals integer-cent entries', () => {
  const ledger = new Ledger().add({ id: 'a', region: 'eu', cents: 1200 }).add({
    id: 'b',
    region: 'us',
    cents: 800,
  })
  assert.equal(ledger.size, 2)
  assert.equal(ledger.total(), 2000)
})

test('Ledger balances by region', () => {
  const ledger = new Ledger()
    .add({ id: 'a', region: 'eu', cents: 1200 })
    .add({ id: 'b', region: 'us', cents: 800 })
    .add({ id: 'c', region: 'eu', cents: 300 })
  assert.equal(ledger.balanceByRegion('eu'), 1500)
  assert.equal(ledger.balanceByRegion('us'), 800)
  assert.equal(ledger.balanceByRegion('apac'), 0)
})

test('Ledger rejects malformed entries and duplicate ids', () => {
  const ledger = new Ledger()
  assert.throws(() => ledger.add(null), TypeError)
  assert.throws(() => ledger.add({ id: '', region: 'eu', cents: 1 }), TypeError)
  assert.throws(() => ledger.add({ id: 'a', region: 'eu', cents: 1.5 }), TypeError)
  ledger.add({ id: 'a', region: 'eu', cents: 1 })
  assert.throws(() => ledger.add({ id: 'a', region: 'us', cents: 2 }), /duplicate/)
})

test('Ledger exposes copies, not its own storage', () => {
  const ledger = new Ledger().add({ id: 'a', region: 'eu', cents: 100 })
  const entries = ledger.entries()
  entries[0].cents = 999
  assert.equal(ledger.total(), 100)
})

test('Ledger discountedTotal applies the ladder', () => {
  const ledger = new Ledger().add({ id: 'a', region: 'eu', cents: 2000 })
  assert.equal(ledger.discountedTotal(), 2000)
})
