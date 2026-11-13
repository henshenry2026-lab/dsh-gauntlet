import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FAULTS,
  FAULT_LIST,
  applyFault,
  faultById,
} from '../src/engine/faults.mjs'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRng } from '../src/engine/rng.mjs'

function scratchWorkspace(files) {
  const root = mkdtempSync(join(tmpdir(), 'gauntlet-fault-'))
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, body, 'utf8')
  }
  return root
}

function sealedDirFor(root) {
  const dir = join(root, '..', 'sealed-' + Date.now() + '-' + Math.random().toString(16).slice(2))
  mkdirSync(dir, { recursive: true })
  return dir
}

function context(root, target, scenario) {
  return {
    workspaceDir: root,
    sealedDir: sealedDirFor(root),
    rng: createRng(1234),
    target,
    scenario: scenario ?? {},
  }
}

test('the catalog exposes every fault with a unique id', () => {
  const ids = FAULT_LIST.map((fault) => fault.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const id of ids) assert.equal(FAULT_LIST.find((f) => f.id === id)?.id, FAULTS[id]?.id)
  assert.ok(ids.length >= 6, 'a gauntlet needs more than a couple of faults')
})

test('every fault declares a label, summary, evidence kinds and apply()', () => {
  for (const fault of FAULT_LIST) {
    assert.equal(typeof fault.apply, 'function', `${fault.id} has no apply`)
    assert.equal(typeof fault.label?.en, 'string', `${fault.id} has no English label`)
    assert.equal(typeof fault.label?.zh, 'string', `${fault.id} has no Chinese label`)
    assert.equal(typeof fault.summary?.en, 'string')
    assert.ok(Array.isArray(fault.evidenceKinds) && fault.evidenceKinds.length > 0)
  }
})

test('faultById names the real ids when it refuses', () => {
  assert.throws(() => faultById('no-such-fault'), /known faults:/)
})

test('a fault refuses a target outside the workspace', () => {
  const root = scratchWorkspace({ 'src/a.mjs': 'export const a = 1\n' })
  assert.throws(
    () => applyFault({ id: 'silent-truncation', target: '../escape.mjs' }, context(root, '../escape.mjs')),
    /escapes the workspace|must be workspace-relative/,
  )
  rmSync(root, { recursive: true, force: true })
})

test('a fault refuses an absolute target on every platform', () => {
  const root = scratchWorkspace({ 'src/a.mjs': 'export const a = 1\n' })
  // Absolute on Windows, and merely a strange relative path on Linux, where
  // `path.isAbsolute` alone would let it through and then complain that the file
  // is missing. A shared scenario must fail the same way on both.
  const targets = ['C:/Windows/win.ini', 'C:\\Windows\\win.ini', '/etc/passwd', '//server/share/a.mjs']
  for (const target of targets) {
    assert.throws(
      () => applyFault({ id: 'silent-truncation', target }, context(root, target)),
      /workspace-relative/,
      `expected ${target} to be refused as non-relative`,
    )
  }
  rmSync(root, { recursive: true, force: true })
})

test('a fault refuses a target that does not exist', () => {
  const root = scratchWorkspace({ 'src/a.mjs': 'export const a = 1\n' })
  assert.throws(
    () => applyFault({ id: 'silent-truncation', target: 'src/missing.mjs' }, context(root, 'src/missing.mjs')),
    /does not exist/,
  )
  rmSync(root, { recursive: true, force: true })
})

test('silent truncation keeps a plausible prefix and seals the original', () => {
  const body = Array.from({ length: 20 }, (_, index) => `line${index}`).join('\n') + '\n'
  const root = scratchWorkspace({ 'src/a.mjs': body })
  const applied = applyFault(
    { id: 'silent-truncation', target: 'src/a.mjs' },
    context(root, 'src/a.mjs'),
  )
  const damaged = readFileSync(join(root, 'src/a.mjs'), 'utf8')
  assert.ok(damaged.length < body.length, 'the file must be shorter')
  assert.ok(damaged.length > 0, 'the file must not be empty')
  assert.ok(body.startsWith(damaged.trimEnd()), 'the surviving prefix must be the real prefix')
  assert.equal(applied.evidence.length, 1)
  assert.equal(applied.evidence[0].path, 'src/a.mjs')
  assert.equal(applied.restored[0], 'src/a.mjs')
  rmSync(root, { recursive: true, force: true })
})

test('a stub cannot be applied without a stub body', () => {
  const root = scratchWorkspace({ 'src/a.mjs': 'export const a = 1\n' })
  assert.throws(
    () => applyFault({ id: 'lying-success', target: 'src/a.mjs' }, context(root, 'src/a.mjs')),
    /no stub body/,
  )
  rmSync(root, { recursive: true, force: true })
})

test('a weakened suite cannot be applied without a regression to hide', () => {
  const root = scratchWorkspace({ 'test/a.test.mjs': 'test()\n' })
  assert.throws(
    () => applyFault(
      { id: 'false-green', target: 'test/a.test.mjs' },
      context(root, 'test/a.test.mjs', { weaken: { 'test/a.test.mjs': 'test()\n' } }),
    ),
    /regress/,
  )
  rmSync(root, { recursive: true, force: true })
})

test('a partial rename needs both halves of the rename', () => {
  const root = scratchWorkspace({ 'src/a.mjs': 'export function alpha() {}\nalpha()\n' })
  assert.throws(
    () => applyFault({ id: 'dirty-diff', target: 'src/a.mjs' }, context(root, 'src/a.mjs')),
    /rename/,
  )
  rmSync(root, { recursive: true, force: true })
})

test('a partial rename changes one call site and not the definition', () => {
  const source = [
    'export function alpha() { return 1 }',
    'export const one = alpha()',
    'export const two = alpha()',
    '',
  ].join('\n')
  const root = scratchWorkspace({ 'src/a.mjs': source })
  applyFault(
    { id: 'dirty-diff', target: 'src/a.mjs' },
    context(root, 'src/a.mjs', { rename: { from: 'alpha', to: 'beta' } }),
  )
  const damaged = readFileSync(join(root, 'src/a.mjs'), 'utf8')
  assert.match(damaged, /function alpha\(/, 'the definition must survive')
  assert.equal(damaged.match(/= beta\(\)/g)?.length, 1, 'exactly one call site must be renamed')
  // Two `alpha()` remain: the definition itself and the untouched second call.
  assert.equal(damaged.match(/alpha\(\)/g)?.length, 2, 'the definition and one call must stay')
  rmSync(root, { recursive: true, force: true })
})

test('a config drift replaces a whole token, not a prefix', () => {
  const source = [
    'export const MAX = 100000000',
    'export const THRESHOLDS = [0, 10000, 50000]',
    '',
  ].join('\n')
  const root = scratchWorkspace({ 'src/config.mjs': source })
  applyFault(
    { id: 'broken-config', target: 'src/config.mjs' },
    context(root, 'src/config.mjs', { config: { from: '10000', to: '12000' } }),
  )
  const damaged = readFileSync(join(root, 'src/config.mjs'), 'utf8')
  assert.match(damaged, /MAX = 100000000/, 'a longer number sharing the prefix must not change')
  assert.match(damaged, /12000/, 'the intended threshold must change')
  assert.doesNotMatch(damaged, /\[0, 10000,/, 'the old threshold must be gone')
  rmSync(root, { recursive: true, force: true })
})

test('a vanished module is emptied rather than deleted', () => {
  const root = scratchWorkspace({ 'src/tiers.mjs': 'export const TIERS = [1, 2, 3]\n' })
  applyFault({ id: 'removed-file', target: 'src/tiers.mjs' }, context(root, 'src/tiers.mjs'))
  const damaged = readFileSync(join(root, 'src/tiers.mjs'), 'utf8')
  assert.equal(damaged, '', 'the file must still exist')
  rmSync(root, { recursive: true, force: true })
})

test('the same seed reproduces the same damage', () => {
  const body = Array.from({ length: 40 }, (_, index) => `line${index}`).join('\n') + '\n'
  const left = scratchWorkspace({ 'src/a.mjs': body })
  const right = scratchWorkspace({ 'src/a.mjs': body })
  const apply = (root) => {
    applyFault(
      { id: 'silent-truncation', target: 'src/a.mjs' },
      { ...context(root, 'src/a.mjs') },
    )
    return readFileSync(join(root, 'src/a.mjs'), 'utf8')
  }
  assert.equal(apply(left), apply(right), 'a seeded fault must be reproducible')
  rmSync(left, { recursive: true, force: true })
  rmSync(right, { recursive: true, force: true })
})
