// Regenerate src/tiers.generated.mjs from src/config.mjs.
//
// The generated module is checked in because the tests and the demo both import
// it and neither should need to run a code generator first. It is therefore
// possible to edit config.mjs and forget this step; `npm test` catches that
// because one test compares the two.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { TIER_RATES, TIER_THRESHOLDS } from '../src/config.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

export function renderTiers(thresholds, rates) {
  return [
    '// GENERATED FILE - do not edit. Run `npm run tiers` after changing',
    '// src/config.mjs; tools/gen-tiers.mjs writes this module from it.',
    '',
    'export const TIER_THRESHOLDS = Object.freeze([' + thresholds.join(', ') + '])',
    'export const TIER_RATES = Object.freeze([' + rates.join(', ') + '])',
    '',
  ].join('\n')
}

export function writeTiers() {
  const target = join(root, 'src', 'tiers.generated.mjs')
  const text = renderTiers(TIER_THRESHOLDS, TIER_RATES)
  writeFileSync(target, text, 'utf8')
  return target
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = writeTiers()
  const text = readFileSync(target, 'utf8')
  process.stdout.write('wrote ' + target + ' (' + text.length + ' bytes)\n')
}
