// Sealed verification: money contract.
//
// These files live OUTSIDE the agent-visible workspace and are copied into
// `sealed/verify/` when a run is prepared. That is the whole point: a scenario
// such as `false-green` damages the workspace's own test suite, so verifying
// with that suite would let a broken tree certify itself. Nothing here imports
// the workspace's tests, and nothing here can be edited during a run.

import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const root = process.argv[2]
if (!root) throw new Error('usage: verify <workspace-root>')

const money = await import(pathToFileURL(join(root, 'src', 'money.mjs')).href)

// Rounding is half away from zero, in both directions.
assert.equal(money.roundCents(0.5), 1, 'roundCents(0.5) must round away from zero')
assert.equal(money.roundCents(-0.5), -1, 'roundCents(-0.5) must round away from zero')
assert.equal(money.roundCents(1.5), 2)
assert.equal(money.roundCents(-1.5), -2)
assert.equal(money.roundCents(0.4), 0)

// Addition is real addition, not a well-shaped zero.
assert.equal(money.addMoney(1, 2, 3), 6, 'addMoney must return the sum')
assert.equal(money.addMoney(-5, 5), 0)
assert.equal(money.addMoney(1200, 800), 2000, 'addMoney must not collapse to zero')
assert.equal(money.addMoney(), 0)

// Formatting keeps two decimals and a sign.
assert.equal(money.formatCents(1234), '$12.34')
assert.equal(money.formatCents(5), '$0.05')
assert.equal(money.formatCents(-5), '-$0.05')

// Splitting conserves the total exactly.
const shares = money.splitEvenly(999, 7)
assert.equal(shares.length, 7, 'splitEvenly must return one share per part')
assert.equal(
  shares.reduce((sum, part) => sum + part, 0),
  999,
  'splitEvenly must conserve the total',
)
assert.ok(
  shares.every((part) => part > 0),
  'splitEvenly must not return empty shares for a positive total',
)

process.stdout.write('money: ok\n')
