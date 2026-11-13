/**
 * End-to-end check of every stock scenario.
 *
 * This is the test that would have caught the two bugs the scenarios themselves
 * had: a `false-green` that only weakened a test (so "fixed" meant nothing), and
 * a `config-drift` that replaced a prefix of a longer number (so the damage
 * landed on the wrong constant). Both were invisible to unit tests and obvious
 * the moment a scenario was actually run.
 *
 * For each scenario it asserts four properties:
 *
 *   1. the damage breaks at least one sealed check;
 *   2. restoring the sealed originals makes every check pass;
 *   3. a restored tree with the correct diagnosis scores 100;
 *   4. doing nothing scores well below the pass mark.
 *
 * Run with `node scripts/smoke.mjs` or `npm test`.
 */

import { strict as assert } from 'node:assert'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  SCENARIO_LIST,
  disposeRun,
  gradeRun,
  prepareRun,
  readSealed,
} from '../src/engine/index.mjs'

const ROOT = `${process.env.TEMP ?? '/tmp'}/dsh-gauntlet-smoke`

/** Restore every sealed original into the agent-visible workspace. */
function restoreAll(run) {
  const restoreDir = join(run.sealedDir, 'restore')
  let restored = 0
  for (const entry of readdirSync(restoreDir)) {
    if (!entry.endsWith('.json')) continue
    const record = JSON.parse(readFileSync(join(restoreDir, entry), 'utf8'))
    writeFileSync(join(run.workspaceDir, record.path), record.content, 'utf8')
    restored += 1
  }
  return restored
}

/** A diagnosis that names exactly what the sealed record says went wrong. */
function honestClaim(sealed) {
  return {
    fixed: true,
    summary: 'Restored the damaged behaviour and re-ran every check.',
    diagnosis: sealed.faults.flatMap((fault) =>
      fault.evidence.map((item) => ({
        path: item.path,
        category: item.category,
        detail: item.detail,
      })),
    ),
  }
}

let failures = 0
const rows = []

for (const scenario of SCENARIO_LIST) {
  const prepared = prepareRun({ scenario: scenario.id, runRoot: ROOT })
  try {
    const sealed = readSealed(prepared)
    const untouched = gradeRun(prepared, { fixed: false, summary: 'Did not start.', diagnosis: [] })
    assert.ok(
      untouched.recovery.checksPassed < untouched.recovery.checks,
      `${scenario.id}: the damage must break at least one sealed check`,
    )

    const restoredCount = restoreAll(prepared)
    assert.ok(restoredCount > 0, `${scenario.id}: nothing was sealed for restoration`)

    const sealedAgain = readSealed(prepared)
    const fixed = gradeRun(prepared, honestClaim(sealedAgain))
    assert.equal(
      fixed.recovery.checksPassed,
      fixed.recovery.checks,
      `${scenario.id}: restoring the originals must satisfy every check`,
    )
    assert.equal(fixed.total, 100, `${scenario.id}: a correct repair must score 100, got ${fixed.total}`)
    assert.equal(fixed.tier.id, 'ironclad')
    assert.ok(untouched.total < 60, `${scenario.id}: inaction must not pass`)
    assert.ok(
      sealed.faults.flatMap((fault) => fault.evidence).length >= sealed.faults.length,
      `${scenario.id}: every fault must contribute at least one evidence anchor`,
    )
    rows.push({
      scenario: scenario.id,
      rank: scenario.rank,
      faults: sealed.faults.length,
      untouched: untouched.total,
      fixed: fixed.total,
    })
  } catch (error) {
    failures += 1
    rows.push({ scenario: scenario.id, rank: scenario.rank, error: String(error.message) })
  } finally {
    disposeRun(prepared)
  }
}

for (const row of rows) {
  if (row.error !== undefined) {
    console.log(`${row.scenario.padEnd(18)} FAIL  ${row.error}`)
    continue
  }
  console.log(
    `${row.scenario.padEnd(18)} ${row.rank.padEnd(9)} faults=${row.faults}  ` +
      `untouched=${String(row.untouched).padStart(3)}  fixed=${String(row.fixed).padStart(3)}`,
  )
}

if (failures > 0) {
  console.error(`\n${failures} scenario(s) failed`)
  process.exitCode = 1
} else {
  console.log(`\nall ${rows.length} scenarios behave as designed`)
}
