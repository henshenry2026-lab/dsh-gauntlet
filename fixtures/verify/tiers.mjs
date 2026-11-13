// Sealed verification: the generated tier table matches its source.
//
// This is the only check that can see a stale or emptied `tiers.generated.mjs`,
// because the runtime imports the generated file rather than the source: every
// other consumer would keep working with an outdated ladder.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const root = process.argv[2]
if (!root) throw new Error('usage: verify <workspace-root>')

const config = await import(pathToFileURL(join(root, 'src', 'config.mjs')).href)
const generated = await import(pathToFileURL(join(root, 'src', 'tiers.generated.mjs')).href)

// The generated module must export the same ladder the source declares.
assert.deepEqual(
  [...generated.TIER_THRESHOLDS],
  [...config.TIER_THRESHOLDS],
  'TIER_THRESHOLDS in tiers.generated.mjs must match config.mjs',
)
assert.deepEqual(
  [...generated.TIER_RATES],
  [...config.TIER_RATES],
  'TIER_RATES in tiers.generated.mjs must match config.mjs',
)

// A generated file is never empty, and says so at the top.
const text = readFileSync(join(root, 'src', 'tiers.generated.mjs'), 'utf8')
assert.ok(text.trim().length > 0, 'tiers.generated.mjs must not be empty')
assert.match(text, /GENERATED FILE/, 'the generated file must keep its provenance banner')

process.stdout.write('tiers: ok\n')
