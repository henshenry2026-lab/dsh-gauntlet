import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  copyVerifyScripts,
  disposeRun,
  fixtureWorkspace,
  gradeRun,
  parseCheck,
  prepareRun,
  readSealed,
  resolveCheck,
  revealRun,
  verifyScriptsDir,
  workspaceFiles,
} from '../src/engine/runner.mjs'

const ROOT = join(tmpdir(), 'gauntlet-runner-test')

test('parseCheck splits a command without involving a shell', () => {
  assert.deepEqual(parseCheck('node test/a.test.mjs'), {
    command: 'node',
    args: ['test/a.test.mjs'],
  })
  assert.deepEqual(parseCheck('  npm   run  test  '), { command: 'npm', args: ['run', 'test'] })
  assert.throws(() => parseCheck('   '), /empty check/)
})

test('the bundled fixture workspace exists where the engine says it does', () => {
  const fixture = fixtureWorkspace()
  assert.ok(existsSync(fixture), `fixture workspace missing: ${fixture}`)
  assert.ok(existsSync(join(fixture, 'package.json')))
  assert.ok(existsSync(join(fixture, 'src', 'money.mjs')))
  assert.ok(existsSync(join(fixture, 'src', 'tiers.generated.mjs')))
})

test('the sealed verifiers are shipped beside the fixture', () => {
  const dir = verifyScriptsDir()
  assert.ok(existsSync(dir), `verify scripts missing: ${dir}`)
  const names = readdirSync(dir).filter((name) => name.endsWith('.mjs'))
  // One verifier per behaviour the stock scenarios damage.
  for (const name of ['money.mjs', 'discount.mjs', 'ledger.mjs', 'tiers.mjs']) {
    assert.ok(names.includes(name), `missing sealed verifier: ${name}`)
  }
})

test('prepareRun copies the workspace, seals the truth, and applies the faults', () => {
  const run = prepareRun({ scenario: 'truncated-tail', runRoot: ROOT })
  try {
    assert.ok(existsSync(run.workspaceDir), 'the agent-visible workspace must exist')
    assert.ok(existsSync(run.sealedDir), 'the sealed directory must exist')
    assert.ok(
      !run.workspaceDir.startsWith(run.sealedDir),
      'the sealed directory must not sit inside the visible workspace',
    )
    const sealed = readSealed(run)
    assert.equal(sealed.faults.length, 1)
    assert.equal(sealed.faults[0].target, 'src/discount.mjs')
    assert.ok(sealed.faults[0].evidence.length > 0)
    // The damage must be visible in the copied tree.
    const damaged = readFileSync(join(run.workspaceDir, 'src', 'discount.mjs'), 'utf8')
    const intact = readFileSync(join(fixtureWorkspace(), 'src', 'discount.mjs'), 'utf8')
    assert.notEqual(damaged, intact, 'the workspace copy must actually be damaged')
    // The source fixture must be untouched.
    assert.equal(readFileSync(join(fixtureWorkspace(), 'src', 'discount.mjs'), 'utf8'), intact)
  } finally {
    disposeRun(run)
  }
})

test('a run refuses to reuse an existing directory', () => {
  const parent = mkdtempSync(join(tmpdir(), 'gauntlet-collide-'))
  const run = prepareRun({ scenario: 'truncated-tail', runRoot: parent, runId: 'fixed-name' })
  try {
    assert.throws(
      () => prepareRun({ scenario: 'truncated-tail', runRoot: parent, runId: 'fixed-name' }),
      /already exists/,
    )
    assert.ok(existsSync(run.runRoot), 'the refused run must leave the first one intact')
    // `keep: true` is the documented way to accept an existing directory.
    const kept = prepareRun({ scenario: 'truncated-tail', runRoot: parent, runId: 'fixed-name', keep: true })
    assert.equal(kept.runRoot, run.runRoot)
  } finally {
    disposeRun(run)
  }
})

test('a run id may not escape its parent directory', () => {
  const parent = mkdtempSync(join(tmpdir(), 'gauntlet-id-'))
  for (const runId of ['../escape', 'a/b', '..', '', 'C:\\evil']) {
    assert.throws(
      () => prepareRun({ scenario: 'truncated-tail', runRoot: parent, runId }),
      /runId/,
    )
  }
})

test('a run refuses a workspace that is not a directory', () => {
  assert.throws(
    () => prepareRun({
      scenario: 'truncated-tail',
      source: join(tmpdir(), 'this-path-does-not-exist-at-all'),
      runRoot: ROOT,
    }),
    /not a directory/,
  )
})

test('verify: checks resolve to the sealed copy, not the workspace', () => {
  const run = prepareRun({ scenario: 'truncated-tail', runRoot: ROOT })
  try {
    const check = run.checks[0]
    assert.equal(check.sealed, true)
    assert.equal(check.declared, 'verify:discount')
    assert.ok(
      check.args[0].startsWith(run.sealedDir),
      'the verifier must run from the sealed directory',
    )
    assert.equal(check.args[1], run.workspaceDir, 'the workspace is passed explicitly')
  } finally {
    disposeRun(run)
  }
})

test('a missing sealed verifier is refused with its name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gauntlet-verify-'))
  assert.throws(
    () => resolveCheck('verify:nope', { verifyDir: dir, workspaceDir: dir }),
    /sealed verifier is missing: nope/,
  )
})

test('a verify name that could escape the sealed directory is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gauntlet-verify-'))
  for (const name of ['verify:../evil', 'verify:a/b', 'verify:']) {
    assert.throws(() => resolveCheck(name, { verifyDir: dir, workspaceDir: dir }), /invalid verify name|missing/)
  }
})

test('copyVerifyScripts copies every verifier and nothing else', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gauntlet-copy-'))
  const copied = copyVerifyScripts(dir)
  assert.ok(copied.length >= 4)
  assert.deepEqual(copied, copied.slice().sort(), 'the copy list must be sorted')
  for (const name of copied) {
    assert.ok(existsSync(join(dir, name)), `declared ${name} but did not copy it`)
  }
})

test('grading runs the checks and writes a scorecard into the sealed directory', () => {
  const run = prepareRun({ scenario: 'truncated-tail', runRoot: ROOT })
  try {
    const card = gradeRun(run, { fixed: false, summary: 'did nothing', diagnosis: [] })
    assert.ok(existsSync(join(run.sealedDir, 'card.json')), 'the scorecard must be persisted')
    assert.equal(card.recovery.checks, 1)
    assert.ok(card.total < 60, 'doing nothing must not pass')
  } finally {
    disposeRun(run)
  }
})

test('a restored workspace passes every sealed check', () => {
  const run = prepareRun({ scenario: 'truncated-tail', runRoot: ROOT })
  try {
    const restoreDir = join(run.sealedDir, 'restore')
    for (const entry of readdirSync(restoreDir)) {
      const record = JSON.parse(readFileSync(join(restoreDir, entry), 'utf8'))
      writeFileSync(join(run.workspaceDir, record.path), record.content, 'utf8')
    }
    const card = gradeRun(run, {
      fixed: true,
      summary: 'restored src/discount.mjs',
      diagnosis: [{ path: 'src/discount.mjs', category: 'truncated-file', detail: 'file ends early' }],
    })
    assert.equal(card.recovery.checksPassed, card.recovery.checks)
    assert.equal(card.recovery.restored, true)
    assert.equal(card.total, 100)
  } finally {
    disposeRun(run)
  }
})

test('reveal lists what was broken and where the originals are', () => {
  const run = prepareRun({ scenario: 'ironclad', runRoot: ROOT })
  try {
    gradeRun(run, { fixed: false, summary: 'gave up', diagnosis: [] })
    const revealed = revealRun(run)
    assert.equal(revealed.scenario, 'ironclad')
    assert.equal(revealed.faults.length, 2)
    assert.ok(revealed.originals.length >= 2, 'every damaged file needs a sealed original')
    for (const original of revealed.originals) {
      assert.equal(typeof original.sha256, 'string')
      assert.ok(original.bytes > 0)
    }
    assert.ok(revealed.card !== null, 'reveal includes the scorecard when one exists')
    assert.match(revealed.note, /More than one fault/)
  } finally {
    disposeRun(run)
  }
})

test('disposeRun refuses a path outside the temp directory unless forced', () => {
  assert.throws(
    () => disposeRun({ runRoot: join(fixtureWorkspace(), '..') }),
    /refusing to delete a run outside the temp directory/,
  )
})

test('workspaceFiles lists the visible tree and nothing from sealed', () => {
  const run = prepareRun({ scenario: 'truncated-tail', runRoot: ROOT })
  try {
    const files = workspaceFiles(run)
    assert.ok(files.includes('src/money.mjs'))
    assert.ok(files.includes('package.json'))
    assert.ok(
      !files.some((file) => file.includes('sealed')),
      'the sealed directory must never appear in the visible listing',
    )
  } finally {
    disposeRun(run)
  }
})

test('a user-supplied scenario object is validated like a stock one', () => {
  const source = fixtureWorkspace()
  assert.throws(
    () => prepareRun({
      scenario: { id: 'Bad Id', rank: 'standard', faults: [], checks: [] },
      source,
      runRoot: ROOT,
    }),
    /lower-kebab-case/,
  )
  assert.throws(
    () => prepareRun({
      scenario: {
        id: 'fine',
        rank: 'nope',
        faults: [{ id: 'silent-truncation', target: 'src/discount.mjs' }],
        checks: ['verify:discount'],
      },
      source,
      runRoot: ROOT,
    }),
    /rank must be one of/,
  )
})

test('a user scenario can point a fault at its own workspace', () => {
  const run = prepareRun({
    scenario: {
      id: 'custom-run',
      rank: 'intro',
      brief: { en: 'custom', zh: '自定义' },
      faults: [{ id: 'removed-file', target: 'src/config.mjs' }],
      checks: ['verify:discount'],
    },
    runRoot: ROOT,
  })
  try {
    assert.equal(readFileSync(join(run.workspaceDir, 'src', 'config.mjs'), 'utf8'), '')
    const sealed = readSealed(run)
    assert.equal(sealed.faults[0].id, 'removed-file')
  } finally {
    disposeRun(run)
  }
})
