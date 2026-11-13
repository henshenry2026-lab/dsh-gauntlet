/**
 * Scenarios: which faults, where, and what "fixed" means.
 *
 * A scenario is *data*, not code. It names faults from the catalog, points each
 * at a workspace-relative path, and supplies the operator the fault needs
 * (a stub body, the renamed symbol, the drifted config value). It also declares
 * the resolution command — the one command that must go green before the run is
 * considered recovered.
 *
 * The vocabulary is deliberately small: a scenario has no conditionals and no
 * per-fault hooks. If a scenario needs a new kind of damage, that is a new
 * entry in `faults.mjs`, not a special case here.
 *
 * @module dsh-gauntlet/engine/scenarios
 */

import { readJson } from './workspace.mjs';
import { normalizeSeed } from './rng.mjs';
import { faultById } from './faults.mjs';

/**
 * @typedef {object} FaultDeclaration
 * @property {string} id - Fault id from the catalog.
 * @property {string} target - Workspace-relative path.
 */

/**
 * @typedef {object} Scenario
 * @property {string} id
 * @property {{en: string, zh: string}} label
 * @property {'intro'|'standard'|'hard'|'boss'} rank
 * @property {{en: string, zh: string}} brief - What the agent is told.
 * @property {FaultDeclaration[]} faults
 * @property {string[]} checks - Commands that must exit zero to count as fixed.
 * @property {object} [stubs] - path -> replacement source for `lying-success`.
 * @property {object} [weaken] - path -> replacement source for `false-green`.
 * @property {{from: string, to: string}} [rename] - for `dirty-diff`.
 * @property {{from: string, to: string}} [config] - for `broken-config`.
 * @property {object} [stale] - path -> older generated body for `stale-artifact`.
 */

/** The agent-visible brief shared by every stock scenario. */
const BRIEF = {
  en: 'This workspace is broken. Diagnostics read as if the code were fine: the tests that still run may pass. Find what is actually wrong, fix it in place, and make the verification checks pass. Do not trust a green test you did not read.',
  zh: '这个工作区坏了。诊断表面上像没问题：还能跑的测试可能是通过的。找出真正坏在哪，就地修好，让校验检查通过。不要相信你没有读过的那条绿灯测试。',
};

/**
 * Checks are declared as `node <file>`, not `node --test <file>`.
 *
 * `node --test` forks a runner process per file, so the whole invocation needs
 * the parent to own a child process pipe. A confined host can deny that (DSH's
 * own file sandbox denies the named pipes involved, with `EPERM`), which would
 * fail every check for a reason that has nothing to do with the agent's work.
 * Running the test file directly uses the same `node:test` API in-process, needs
 * no extra process, and reports the same non-zero exit on failure.
 */

/**
 * Stock scenarios, easiest first.
 *
 * Each one is a single fault on purpose. A scenario that stacks faults teaches
 * nothing about which fault caused which symptom, and the score cannot tell
 * detection from luck. Composition belongs to `boss` runs, where the fault
 * count itself is the difficulty.
 */
export const SCENARIOS = Object.freeze({
  'truncated-tail': {
    id: 'truncated-tail',
    label: { en: 'Truncated tail', zh: '断裂的尾行' },
    rank: 'intro',
    brief: BRIEF,
    faults: [{ id: 'silent-truncation', target: 'src/discount.mjs' }],
    checks: ['verify:discount'],
  },
  'stubbed-function': {
    id: 'stubbed-function',
    label: { en: 'The stub that says yes', zh: '有求必应的桩' },
    rank: 'standard',
    brief: BRIEF,
    faults: [{ id: 'lying-success', target: 'src/money.mjs' }],
    checks: ['verify:money', 'verify:ledger'],
    stubs: {
      // Keeps every export, keeps every signature, returns a well-shaped lie:
      // formatting still works (it was not stubbed), arithmetic returns 0.
      'src/money.mjs': `// Integer-cent arithmetic.

import { DECIMALS } from './config.mjs'

export function roundCents(value) {
  if (typeof value !== 'number') throw new TypeError('value must be a number')
  return Math.sign(value) * Math.round(Math.abs(value))
}

export function addMoney(...amounts) {
  for (const amount of amounts) {
    if (!Number.isInteger(amount)) throw new TypeError('amount must be an integer number of cents')
  }
  return 0
}

export function formatCents(cents) {
  const sign = cents < 0 ? '-' : ''
  const absolute = Math.abs(cents)
  const whole = Math.trunc(absolute / 100)
  const fraction = String(absolute % 100).padStart(DECIMALS, '0')
  return sign + '$' + whole + '.' + fraction
}

export function splitEvenly(total, parts) {
  if (!Number.isInteger(parts) || parts <= 0) throw new RangeError('parts must be a positive integer')
  return new Array(parts).fill(0)
}
`,
    },
  },
  'false-green': {
    id: 'false-green',
    label: { en: 'The suite that agrees', zh: '附和你的套件' },
    rank: 'standard',
    brief: BRIEF,
    faults: [{ id: 'false-green', target: 'test/ledger.test.mjs' }],
    checks: ['verify:ledger'],
    // The regression is what makes the relaxed assertion dangerous: the total
    // stops summing while the test that existed to catch it now passes.
    regress: {
      target: 'src/ledger.mjs',
      body: `// A ledger of integer-cent entries with per-region balances. Entries are
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
    return this.#entries.length
  }

  balanceByRegion(region) {
    if (typeof region !== 'string' || region === '') {
      throw new TypeError('region must be a non-empty string')
    }
    return this.#entries.filter((entry) => entry.region === region).length
  }

  discountedTotal() {
    return applyDiscount(this.total())
  }

  entries() {
    return this.#entries.map((entry) => ({ ...entry }))
  }
}
`,
    },
    weaken: {
      // The test still runs, still names the behaviour, and still passes — the
      // assertion just stopped constraining anything. The fix therefore has to
      // come from reading the implementation, not from a failure message.
      'test/ledger.test.mjs': `import assert from 'node:assert/strict'
import test from 'node:test'

import { Ledger } from '../src/index.mjs'

test('Ledger totals integer-cent entries', () => {
  const ledger = new Ledger().add({ id: 'a', region: 'eu', cents: 1200 }).add({
    id: 'b',
    region: 'us',
    cents: 800,
  })
  assert.equal(ledger.size, 2)
})

test('Ledger balances by region', () => {
  const ledger = new Ledger()
    .add({ id: 'a', region: 'eu', cents: 1200 })
    .add({ id: 'b', region: 'us', cents: 800 })
    .add({ id: 'c', region: 'eu', cents: 300 })
  assert.equal(ledger.balanceByRegion('eu'), 1500)
  assert.equal(ledger.balanceByRegion('us'), 800)
  assert.equal(ledger.balanceByRegion('apac'), 0)
})

test('Ledger rejects malformed entries and duplicate ids', () => {
  const ledger = new Ledger()
  assert.throws(() => ledger.add(null), TypeError)
  assert.throws(() => ledger.add({ id: '', region: 'eu', cents: 1 }), TypeError)
  assert.throws(() => ledger.add({ id: 'a', region: 'eu', cents: 1.5 }), TypeError)
  ledger.add({ id: 'a', region: 'eu', cents: 1 })
  assert.throws(() => ledger.add({ id: 'a', region: 'us', cents: 2 }), /duplicate/)
})

test('Ledger exposes copies, not its own storage', () => {
  const ledger = new Ledger().add({ id: 'a', region: 'eu', cents: 100 })
  const entries = ledger.entries()
  entries[0].cents = 999
  assert.equal(ledger.total(), 100)
})

test('Ledger discountedTotal applies the ladder', () => {
  const ledger = new Ledger().add({ id: 'a', region: 'eu', cents: 2000 })
  assert.equal(ledger.discountedTotal(), 2000)
})
`,
    },
  },
  'half-rename': {
    id: 'half-rename',
    label: { en: 'Half-applied rename', zh: '改了一半的重命名' },
    rank: 'standard',
    brief: BRIEF,
    faults: [{ id: 'dirty-diff', target: 'src/ledger.mjs' }],
    checks: ['verify:ledger', 'verify:discount'],
    rename: { from: 'balanceByRegion', to: 'balanceInRegion' },
  },
  'vanished-module': {
    id: 'vanished-module',
    label: { en: 'Vanished module', zh: '掏空的模块' },
    rank: 'standard',
    brief: BRIEF,
    faults: [{ id: 'removed-file', target: 'src/tiers.generated.mjs' }],
    checks: ['verify:tiers', 'verify:discount'],
  },
  'config-drift': {
    id: 'config-drift',
    label: { en: 'Plausible config drift', zh: '貌似合理的配置漂移' },
    rank: 'standard',
    brief: BRIEF,
    faults: [{ id: 'broken-config', target: 'src/config.mjs' }],
    checks: ['verify:discount'],
    // The tier ladder is product behaviour, so moving a threshold is not a typo
    // the tests shrug at: it changes what a customer pays.
    config: { from: '10000', to: '12000' },
  },
  'stale-build': {
    id: 'stale-build',
    label: { en: 'Stale artifact', zh: '陈旧的产物' },
    rank: 'hard',
    brief: BRIEF,
    faults: [{ id: 'stale-artifact', target: 'src/tiers.generated.mjs' }],
    checks: ['verify:tiers', 'verify:discount'],
    stale: {
      // An older but perfectly valid ladder. Every import succeeds, every tier
      // lookup returns a number, and only the drift test knows the difference.
      'src/tiers.generated.mjs': `// GENERATED FILE - do not edit. Run \`npm run tiers\` after changing
// src/config.mjs; tools/gen-tiers.mjs writes this module from it.

export const TIER_THRESHOLDS = Object.freeze([0, 8000, 40000, 150000])
export const TIER_RATES = Object.freeze([0, 0.05, 0.1, 0.15])
`,
    },
  },
  ironclad: {
    id: 'ironclad',
    label: { en: 'Ironclad run', zh: '连锁故障' },
    rank: 'boss',
    brief: {
      en: 'Several things are wrong at once, and they mask each other: the suite passes for the wrong reason and one file is shorter than it should be. Fix the workspace so every check passes, and be able to say which fault caused which symptom.',
      zh: '同时坏了好几处，而且互相掩盖：套件是因为错误的原因才通过的，另有一个文件比该有的短。把工作区修到所有检查通过，并且能说清哪个故障造成了哪个症状。',
    },
    faults: [
      { id: 'lying-success', target: 'src/money.mjs' },
      { id: 'silent-truncation', target: 'src/discount.mjs' },
    ],
    checks: ['verify:money', 'verify:discount', 'verify:ledger'],
    stubs: {
      'src/money.mjs': `// Integer-cent arithmetic.

import { DECIMALS } from './config.mjs'

export function roundCents(value) {
  if (typeof value !== 'number') throw new TypeError('value must be a number')
  return Math.sign(value) * Math.round(Math.abs(value))
}

export function addMoney(...amounts) {
  for (const amount of amounts) {
    if (!Number.isInteger(amount)) throw new TypeError('amount must be an integer number of cents')
  }
  return 0
}

export function formatCents(cents) {
  const sign = cents < 0 ? '-' : ''
  const absolute = Math.abs(cents)
  const whole = Math.trunc(absolute / 100)
  const fraction = String(absolute % 100).padStart(DECIMALS, '0')
  return sign + '$' + whole + '.' + fraction
}

export function splitEvenly(total, parts) {
  if (!Number.isInteger(parts) || parts <= 0) throw new RangeError('parts must be a positive integer')
  return new Array(parts).fill(0)
}
`,
    },
  },
});

const RANK_ORDER = { intro: 0, standard: 1, hard: 2, boss: 3 };

/** Every scenario as a list, ordered easiest first. */
export const SCENARIO_LIST = Object.freeze(
  Object.values(SCENARIOS).sort((left, right) => {
    const delta = RANK_ORDER[left.rank] - RANK_ORDER[right.rank];
    return delta !== 0 ? delta : left.id.localeCompare(right.id);
  }),
);

const RANKS = new Set(Object.keys(RANK_ORDER));

/**
 * Validate a scenario record before it can damage anything. Every mistake here
 * would otherwise surface as a half-damaged workspace, which is worse than a
 * refusal.
 * @param {unknown} candidate - Parsed scenario JSON.
 * @returns {Scenario}
 */
export function validateScenario(candidate) {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error('a scenario must be a JSON object');
  }
  const { id, rank, faults, checks } = candidate;
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new Error('scenario.id must be lower-kebab-case');
  }
  if (!RANKS.has(rank)) {
    throw new Error(`scenario.${id}.rank must be one of ${[...RANKS].join(', ')}`);
  }
  if (!Array.isArray(faults) || faults.length === 0) {
    throw new Error(`scenario.${id} must declare at least one fault`);
  }
  for (const fault of faults) {
    if (fault === null || typeof fault !== 'object') {
      throw new Error(`scenario.${id} has a non-object fault declaration`);
    }
    // Throws with the real id list when the catalog has no such fault.
    faultById(fault.id);
    if (typeof fault.target !== 'string' || fault.target.trim() === '') {
      throw new Error(`scenario.${id}: fault ${fault.id} needs a target path`);
    }
  }
  if (!Array.isArray(checks) || checks.length === 0) {
    throw new Error(`scenario.${id} must declare at least one resolution check`);
  }
  for (const check of checks) {
    if (typeof check !== 'string' || check.trim() === '') {
      throw new Error(`scenario.${id} has an empty resolution check`);
    }
  }
  return /** @type {Scenario} */ (candidate);
}

/**
 * Look up a stock scenario by id.
 * @param {string} id - Scenario id.
 * @returns {Scenario}
 */
export function scenarioById(id) {
  const scenario = SCENARIOS[id];
  if (scenario === undefined) {
    throw new Error(`unknown scenario "${id}"; known scenarios: ${Object.keys(SCENARIOS).join(', ')}`);
  }
  return scenario;
}

/**
 * Load a scenario from a JSON file, for a run the user wrote themselves.
 *
 * A user scenario is held to the same validation as a stock one: it can pick any
 * fault in the catalog against any path in its own workspace, and it can declare
 * its own checks, but it cannot reach into this package.
 *
 * @param {string} path - Absolute path to the scenario file.
 * @returns {Scenario}
 */
export function loadScenarioFile(path) {
  const parsed = readJson(path);
  if (parsed === null) throw new Error(`scenario file is missing or not valid JSON: ${path}`);
  return validateScenario(parsed);
}

/**
 * Resolve the seed a run will use.
 *
 * With no seed the scenario id seeds the generator, so "start this scenario"
 * gives the same gauntlet on every machine until the caller asks otherwise.
 * @param {Scenario} scenario
 * @param {unknown} raw
 */
export function resolveSeed(scenario, raw) {
  return normalizeSeed(raw, `dsh-gauntlet:${scenario.id}`);
}
