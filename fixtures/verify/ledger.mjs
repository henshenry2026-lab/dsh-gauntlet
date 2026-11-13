// Sealed verification: ledger behaviour through the public surface.
//
// Only `src/index.mjs` is imported, so this keeps working if the internals move
// — the same contract the package README promises to consumers.

import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const root = process.argv[2]
if (!root) throw new Error('usage: verify <workspace-root>')

const surface = await import(pathToFileURL(join(root, 'src', 'index.mjs')).href)
const { Ledger } = surface

const ledger = new Ledger()
  .add({ id: 'a', region: 'eu', cents: 1200 })
  .add({ id: 'b', region: 'us', cents: 800 })
  .add({ id: 'c', region: 'eu', cents: 300 })

assert.equal(ledger.size, 3)
assert.equal(ledger.total(), 2300, 'the ledger total must sum its entries')
assert.equal(ledger.balanceByRegion('eu'), 1500, 'the regional balance must sum only that region')
assert.equal(ledger.balanceByRegion('us'), 800)
assert.equal(ledger.balanceByRegion('apac'), 0)

// Copies, not storage: mutating what came out must not change the ledger.
const entries = ledger.entries()
entries[0].cents = 999999
assert.equal(ledger.total(), 2300, 'entries() must not hand out internal storage')

// Malformed entries are refused.
assert.throws(() => ledger.add(null), TypeError)
assert.throws(() => ledger.add({ id: '', region: 'eu', cents: 1 }), TypeError)
assert.throws(() => ledger.add({ id: 'x', region: 'eu', cents: 1.5 }), TypeError)
assert.throws(() => ledger.add({ id: 'a', region: 'us', cents: 2 }), /duplicate/)

// The discount path is wired end to end: 2300 cents is below the first tier.
assert.equal(ledger.discountedTotal(), 2300)

process.stdout.write('ledger: ok\n')
