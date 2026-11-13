// A ledger of integer-cent entries with per-region balances. Entries are
// immutable once added; the class exposes copies, never its own storage.

import { addMoney } from './money.mjs'
import { applyDiscount } from './discount.mjs'

export class Ledger {
  #entries = []

  add(entry) {
    if (entry === null || typeof entry !== 'object') throw new TypeError('entry must be an object')
    const { id, region, cents } = entry
    if (typeof id !== 'string' || id === '') throw new TypeError('entry.id must be a non-empty string')
    if (typeof region !== 'string' || region === '') {
      throw new TypeError('entry.region must be a non-empty string')
    }
    if (!Number.isInteger(cents)) throw new TypeError('entry.cents must be an integer number of cents')
    if (this.#entries.some((existing) => existing.id === id)) {
      throw new Error('duplicate entry id: ' + id)
    }
    this.#entries.push({ id, region, cents })
    return this
  }

  get size() {
    return this.#entries.length
  }

  total() {
    return addMoney(...this.#entries.map((entry) => entry.cents))
  }

  balanceByRegion(region) {
    if (typeof region !== 'string' || region === '') {
      throw new TypeError('region must be a non-empty string')
    }
    return addMoney(...this.#entries.filter((entry) => entry.region === region).map((entry) => entry.cents))
  }

  discountedTotal() {
    return applyDiscount(this.total())
  }

  entries() {
    return this.#entries.map((entry) => ({ ...entry }))
  }
}
