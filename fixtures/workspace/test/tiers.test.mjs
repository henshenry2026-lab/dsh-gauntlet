import assert from 'node:assert/strict'
import test from 'node:test'

import { TIER_RATES as SOURCE_RATES, TIER_THRESHOLDS as SOURCE_THRESHOLDS } from '../src/config.mjs'
import { renderTiers } from '../tools/gen-tiers.mjs'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// The generated module is checked in, so it can fall behind config.mjs. This
// test is the only thing that notices: the runtime imports the generated file,
// not the source, so nothing else would ever fail.
test('tiers.generated.mjs matches config.mjs', () => {
  const committed = readFileSync(join(root, 'src', 'tiers.generated.mjs'), 'utf8')
  const expected = renderTiers(SOURCE_THRESHOLDS, SOURCE_RATES)
  assert.equal(
    committed.trimEnd(),
    expected.trimEnd(),
    'src/tiers.generated.mjs is stale; run `npm run tiers`',
  )
})
