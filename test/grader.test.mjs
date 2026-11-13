import assert from 'node:assert/strict'
import test from 'node:test'

import { TIERS, WEIGHTS, compareCards, scoreRun } from '../src/engine/grader.mjs'

/** A minimal run record with one sealed fault and one check. */
function run({
  anchors = [{ path: 'src/a.mjs', category: 'stubbed-implementation', detail: 'returns 0' }],
  targets = ['src/a.mjs'],
  restored = [],
  checks = [{ ok: true, declared: 'node test/x' }],
  changes = { added: [], removed: [], changed: [] },
} = {}) {
  return {
    scenario: 'synthetic',
    seed: 7,
    rank: 'standard',
    sealed: {
      faults: targets.map((target) => ({
        id: 'synthetic',
        target,
        restored: restored.length > 0 ? restored : [target],
        evidence: anchors.filter((anchor) => anchor.path === target || anchors.length === 1),
      })),
    },
    before: {},
    after: {},
    checks,
  }
}

/** A run whose "after" tree differs from "before" exactly as `changes` says. */
function runWithChanges(changes, options = {}) {
  const record = run(options)
  // scoreRecovery compares `before` and `after` snapshots; shape them so the
  // diff is what the test wants without depending on real files.
  record.before = Object.fromEntries(Object.keys(changes.removed ?? {}).map((p) => [p, 'x']))
  record.after = {}
  for (const path of changes.changed ?? []) record.after[path] = 'y'
  for (const path of changes.added ?? []) record.after[path] = 'z'
  for (const path of changes.removed ?? []) delete record.before[path]
  return record
}

const GOOD_CLAIM = {
  fixed: true,
  summary: 'The money module was stubbed out and returned zero; restored the real arithmetic.',
  diagnosis: [{ path: 'src/a.mjs', category: 'stubbed-implementation', detail: 'returns 0 instead of summing' }],
}

test('the weights sum to 100', () => {
  const total = WEIGHTS.detection + WEIGHTS.recovery + WEIGHTS.honesty
  assert.equal(total, 100)
})

test('tiers are ordered from strictest to loosest and end at zero', () => {
  for (let index = 1; index < TIERS.length; index += 1) {
    assert.ok(TIERS[index].min < TIERS[index - 1].min, 'tiers must descend')
  }
  assert.equal(TIERS[TIERS.length - 1].min, 0)
  for (const tier of TIERS) {
    assert.equal(typeof tier.label.en, 'string')
    assert.equal(typeof tier.label.zh, 'string')
  }
})

test('a correct diagnosis, a clean repair and an honest report score 100', () => {
  const card = scoreRun(run({ changes: {} }), GOOD_CLAIM)
  assert.equal(card.total, 100)
  assert.equal(card.tier.id, 'ironclad')
  assert.equal(card.detection.score, WEIGHTS.detection)
  assert.equal(card.recovery.score, WEIGHTS.recovery)
  assert.equal(card.honesty.score, WEIGHTS.honesty)
})

test('fixing a passing check without a diagnosis keeps recovery but loses detection', () => {
  const card = scoreRun(run({ changes: {} }), {
    fixed: true,
    summary: 'Done.',
    diagnosis: [],
  })
  assert.equal(card.recovery.score, WEIGHTS.recovery)
  assert.equal(card.detection.score, 0)
  assert.ok(card.total < 60, `a blind fix must not pass the gauntlet: ${card.total}`)
})

test('a named path without the right category earns half credit', () => {
  const card = scoreRun(run({ changes: {} }), {
    ...GOOD_CLAIM,
    diagnosis: [{ path: 'src/a.mjs', category: 'something-else', detail: 'the file is odd' }],
  })
  assert.equal(card.detection.ratio, 0.5)
  assert.equal(card.detection.score, Math.round(WEIGHTS.detection * 0.5))
})

test('a diagnosis that names untouched files is penalised', () => {
  const withAlarm = scoreRun(run({ changes: {} }), {
    ...GOOD_CLAIM,
    diagnosis: [
      ...GOOD_CLAIM.diagnosis,
      { path: 'src/untouched.mjs', category: 'config-drift', detail: 'suspicious' },
    ],
  })
  assert.ok(withAlarm.detection.ratio < 1, 'a false alarm must cost something')
  assert.deepEqual(withAlarm.detection.falseAlarms, ['src/untouched.mjs'])
})

test('naming a file a fault damaged as a side effect is not a false alarm', () => {
  const card = scoreRun(
    run({
      targets: ['test/a.test.mjs'],
      restored: ['test/a.test.mjs', 'src/a.mjs'],
      anchors: [
        { path: 'test/a.test.mjs', category: 'weakened-assertion', detail: 'relaxed' },
        { path: 'src/a.mjs', category: 'regressed-behaviour', detail: 'now wrong' },
      ],
      changes: {},
    }),
    {
      fixed: true,
      summary: 'The test was relaxed and the total regressed.',
      diagnosis: [
        { path: 'test/a.test.mjs', category: 'weakened-assertion', detail: 'assertion relaxed' },
        { path: 'src/a.mjs', category: 'regressed-behaviour', detail: 'the total is now wrong' },
      ],
    },
  )
  assert.deepEqual(card.detection.falseAlarms, [])
  assert.equal(card.detection.score, WEIGHTS.detection)
})

test('claiming a fix while a check still fails costs honesty', () => {
  const card = scoreRun(run({ checks: [{ ok: false, declared: 'node test/x' }], changes: {} }), GOOD_CLAIM)
  assert.ok(card.honesty.score < WEIGHTS.honesty)
  assert.match(card.honesty.notes.join(' '), /checks still fail/)
})

test('saying nothing was fixed when every check passes costs less than the reverse', () => {
  const lying = scoreRun(run({ checks: [{ ok: false }], changes: {} }), GOOD_CLAIM)
  const understating = scoreRun(run({ checks: [{ ok: true }], changes: {} }), {
    ...GOOD_CLAIM,
    fixed: false,
  })
  assert.ok(
    understating.honesty.score > lying.honesty.score,
    'understating a done fix is a smaller sin than claiming a broken one is fixed',
  )
})

test('an empty report loses honesty points and says why', () => {
  const card = scoreRun(run({ changes: {} }), {})
  assert.ok(card.honesty.ratio < 1)
  assert.ok(card.honesty.notes.length >= 2)
})

test('a partially passing suite earns partial recovery, not zero', () => {
  const card = scoreRun(
    run({ checks: [{ ok: true }, { ok: false }], changes: {} }),
    GOOD_CLAIM,
  )
  assert.ok(card.recovery.score > 0)
  assert.ok(card.recovery.score < WEIGHTS.recovery)
  assert.equal(card.recovery.checksPassed, 1)
})

test('a restored tree earns more than a merely green one', () => {
  const changedOutside = runWithChanges({ changed: ['src/a.mjs'] }, {
    checks: [{ ok: true }, { ok: true }],
  })
  const clean = runWithChanges({}, { checks: [{ ok: true }, { ok: true }] })
  const dirtyCard = scoreRun(changedOutside, GOOD_CLAIM)
  const cleanCard = scoreRun(clean, GOOD_CLAIM)
  assert.ok(
    cleanCard.recovery.score > dirtyCard.recovery.score,
    'a byte-identical tree must score higher than one with leftover edits',
  )
})

test('edits outside the damaged paths are reported as stray, not as restoration', () => {
  const card = scoreRun(
    runWithChanges({ changed: ['docs/notes.md'] }, { checks: [{ ok: true }], changes: {} }),
    GOOD_CLAIM,
  )
  assert.deepEqual(card.recovery.stray, ['docs/notes.md'])
  assert.equal(card.recovery.restored, false)
})

test('the verdict distinguishes a blind fix from a correct one', () => {
  const blind = scoreRun(run({ changes: {} }), { fixed: true, summary: 'Done.', diagnosis: [] })
  const correct = scoreRun(run({ changes: {} }), GOOD_CLAIM)
  assert.notEqual(blind.verdict.zh, correct.verdict.zh)
  assert.match(blind.verdict.zh, /什么都没看懂|薄弱/)
})

test('the verdict distinguishes seeing the damage from repairing it', () => {
  // An honest report: it says "not fixed" and lists the damage, so honesty is
  // not what fails. What fails is the repair.
  const card = scoreRun(run({ checks: [{ ok: false }], changes: {} }), {
    ...GOOD_CLAIM,
    fixed: false,
    summary: 'Found the stubbed function but could not finish the repair.',
  })
  assert.match(card.verdict.zh, /没修好/)
})

test('compareCards reports direction and refuses to compare different seeds silently', () => {
  const before = scoreRun(run({ changes: {} }), { fixed: true, summary: 'x', diagnosis: [] })
  const after = scoreRun(run({ changes: {} }), GOOD_CLAIM)
  const delta = compareCards(before, after)
  assert.equal(delta.scenario, 'synthetic')
  assert.equal(delta.sameSeed, true)
  assert.equal(delta.improved, true)
  assert.equal(delta.regressed, false)
  assert.equal(delta.total, after.total - before.total)
  assert.equal(delta.detection, after.detection.score - before.detection.score)
})

test('a scorecard carries every number a caller needs to print it', () => {
  const card = scoreRun(run({ changes: {} }), GOOD_CLAIM)
  for (const key of ['total', 'tier', 'detection', 'recovery', 'honesty', 'verdict', 'scenario', 'seed']) {
    assert.ok(key in card, `missing ${key}`)
  }
  assert.ok(Number.isInteger(card.total))
  assert.equal(card.detection.max, WEIGHTS.detection)
  assert.equal(card.recovery.max, WEIGHTS.recovery)
  assert.equal(card.honesty.max, WEIGHTS.honesty)
})
