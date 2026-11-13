import assert from 'node:assert/strict'
import test from 'node:test'

import plugin, { apply, inject, name } from '../src/dsh/index.mjs'

/**
 * A minimal stand-in for the Cordis host.
 *
 * The real loader owns fibers, scopes and disposal. What matters here is the
 * contract this module actually uses: `ctx.inject(names, callback)` hands back a
 * scoped context whose `tools.register(definition)` returns a disposer. If the
 * module uses anything else, this fixture would not satisfy it — which is the
 * point of writing it down.
 */
function fakeHost() {
  const registrations = []
  const disposed = []
  const warnings = []
  const ctx = {
    logger: () => ({ warn: (message) => warnings.push(message) }),
    inject(services, callback) {
      const scoped = {
        tools: {
          register(definition) {
            registrations.push(definition)
            return () => disposed.push(definition.name)
          },
        },
        on(event, handler) {
          if (event === 'dispose') scoped._onDispose = handler
        },
      }
      for (const service of services) {
        if (service !== 'tools') throw new Error(`fixture does not provide ${service}`)
      }
      callback(scoped)
      return scoped
    },
  }
  return { ctx, registrations, disposed, warnings }
}

test('the module exports the shape Cordis expects', () => {
  assert.equal(name, 'dsh-gauntlet')
  assert.deepEqual(inject, ['tools'])
  assert.equal(typeof apply, 'function')
  assert.equal(plugin.name, name)
  assert.equal(plugin.apply, apply)
  assert.deepEqual(plugin.inject, inject)
  // No Config: a settings schema would be a second place to configure something
  // that is already a tool argument.
  assert.equal(plugin.Config, undefined)
})

test('apply() registers every tool exactly once', () => {
  const host = fakeHost()
  apply(host.ctx)

  const names = host.registrations.map((definition) => definition.name)
  assert.deepEqual(names, [
    'gauntlet_list',
    'gauntlet_start',
    'gauntlet_status',
    'gauntlet_submit',
    'gauntlet_reveal',
    'gauntlet_dispose',
  ])
  assert.equal(new Set(names).size, names.length)
  assert.deepEqual(host.warnings, [])
})

test('each registration carries a description, an object schema and an output', () => {
  const host = fakeHost()
  apply(host.ctx)

  for (const definition of host.registrations) {
    assert.equal(typeof definition.description, 'string')
    assert.ok(definition.description.length >= 20, `${definition.name} needs a usable description`)
    assert.equal(definition.parameters.type, 'object')
    assert.ok(!('required' in definition.parameters) || Array.isArray(definition.parameters.required))
    assert.equal(typeof definition.output.schema, 'object')
    assert.equal(typeof definition.output.render, 'function')
    assert.equal(typeof definition.execute, 'function')
  }
})

test('render turns a result into text content blocks', async () => {
  const host = fakeHost()
  apply(host.ctx)
  const list = host.registrations.find((definition) => definition.name === 'gauntlet_list')

  const value = await list.execute({})
  const blocks = list.output.render({}, value)

  assert.ok(Array.isArray(blocks))
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'text')
  assert.match(blocks[0].text, /truncated-tail/)
})

test('a render failure still returns the result as JSON', async () => {
  const host = fakeHost()
  apply(host.ctx)
  const list = host.registrations.find((definition) => definition.name === 'gauntlet_list')

  // A result the renderer cannot read: this is the shape a future schema change
  // produces, and losing the whole answer to it would be a bad trade.
  const blocks = list.output.render({}, null)
  assert.equal(blocks[0].type, 'text')
  assert.equal(typeof blocks[0].text, 'string')
  assert.ok(blocks[0].text.length > 0)
})

test('a tool failure is returned as a value, not thrown', async () => {
  const host = fakeHost()
  apply(host.ctx)
  const status = host.registrations.find((definition) => definition.name === 'gauntlet_status')

  const value = await status.execute({ run: 'does-not-exist' })
  assert.equal(typeof value.error, 'string')
  assert.match(value.error, /unknown run/)
  assert.equal(value.tool, 'gauntlet_status')
})

test('apply() survives a host with no inject()', () => {
  const warnings = []
  assert.doesNotThrow(() =>
    apply({
      logger: () => ({ warn: (message) => warnings.push(message) }),
    }),
  )
  assert.ok(warnings.some((message) => message.includes('inject')))
})

test('apply() survives a throwing logger', () => {
  const ctx = {
    logger: () => {
      throw new Error('logging is broken')
    },
    inject() {
      throw new Error('service is unavailable')
    },
  }
  assert.doesNotThrow(() => apply(ctx))
})

test('apply() survives a tools service that cannot register', () => {
  const warnings = []
  const ctx = {
    logger: () => ({ warn: (message) => warnings.push(message) }),
    inject(services, callback) {
      callback({ tools: {} })
    },
  }
  assert.doesNotThrow(() => apply(ctx))
  assert.ok(warnings.some((message) => message.includes('register')))
})

test('apply() survives register() throwing on the first tool', () => {
  const warnings = []
  const ctx = {
    logger: () => ({ warn: (message) => warnings.push(message) }),
    inject(services, callback) {
      callback({
        tools: {
          register() {
            throw new Error('registry is full')
          },
        },
      })
    },
  }
  assert.doesNotThrow(() => apply(ctx))
  assert.ok(warnings.some((message) => message.includes('could not register')))
})

test('apply() with no context does not throw', () => {
  assert.doesNotThrow(() => apply(undefined))
  assert.doesNotThrow(() => apply(null))
  assert.doesNotThrow(() => apply({}))
})

test('the registration disposer is wired to the scope when the host offers one', () => {
  const host = fakeHost()
  let scoped
  const ctx = {
    logger: () => ({ warn() {} }),
    inject(services, callback) {
      scoped = {
        tools: {
          register(definition) {
            return () => host.disposed.push(definition.name)
          },
        },
        on(event, handler) {
          if (event === 'dispose') scoped.handler = handler
        },
      }
      callback(scoped)
      return scoped
    },
  }
  apply(ctx)
  assert.equal(typeof scoped.handler, 'function', 'the disposer must be registered on the scope')
  assert.doesNotThrow(() => scoped.handler())
})
