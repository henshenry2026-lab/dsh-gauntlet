import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { GauntletServer, LATEST_PROTOCOL, PROTOCOL_VERSIONS, serve } from '../src/mcp/server.mjs'

/** A server plus an in-memory pipe pair, driving the real transport. */
function harness() {
  const server = new GauntletServer({ version: '0.0.0-test' })
  const input = new PassThrough()
  const output = new PassThrough()
  const frames = []
  let buffered = ''
  output.on('data', (chunk) => {
    buffered += chunk.toString('utf8')
    let index = buffered.indexOf('\n')
    while (index >= 0) {
      const line = buffered.slice(0, index)
      buffered = buffered.slice(index + 1)
      if (line.trim() !== '') frames.push(JSON.parse(line))
      index = buffered.indexOf('\n')
    }
  })
  const done = serve(server, { input, output })
  return {
    server,
    frames,
    done,
    /** Send raw text, for the malformed-frame cases. */
    raw(text) {
      input.write(text)
    },
    send(message) {
      input.write(`${JSON.stringify(message)}\n`)
    },
    async settle() {
      await new Promise((resolve) => setImmediate(resolve))
      await new Promise((resolve) => setImmediate(resolve))
    },
    close() {
      input.end()
      return done
    },
  }
}

/** Call one method and return the frame that answers it. */
async function call(h, id, method, params) {
  h.send({ jsonrpc: '2.0', id, method, params })
  await h.settle()
  return h.frames.find((frame) => frame.id === id)
}

test('initialize echoes a supported protocol version and advertises tools', async () => {
  const h = harness()
  try {
    const frame = await call(h, 1, 'initialize', { protocolVersion: LATEST_PROTOCOL, capabilities: {} })
    assert.equal(frame.result.protocolVersion, LATEST_PROTOCOL)
    assert.deepEqual(frame.result.capabilities.tools, { listChanged: false })
    assert.equal(frame.result.serverInfo.version, '0.0.0-test')
    assert.match(frame.result.serverInfo.name, /dsh-gauntlet/)
    assert.ok(frame.result.instructions.length > 40)
  } finally {
    await h.close()
  }
})

test('initialize falls back to the newest version for an unknown one', async () => {
  const h = harness()
  try {
    const frame = await call(h, 2, 'initialize', { protocolVersion: '1999-01-01' })
    assert.equal(frame.result.protocolVersion, LATEST_PROTOCOL)
  } finally {
    await h.close()
  }
})

test('initialize answers with an older revision when the client asks for it', async () => {
  const h = harness()
  try {
    const older = PROTOCOL_VERSIONS[PROTOCOL_VERSIONS.length - 1]
    const frame = await call(h, 3, 'initialize', { protocolVersion: older })
    assert.equal(frame.result.protocolVersion, older)
  } finally {
    await h.close()
  }
})

test('tools/list offers every tool with a JSON object schema', async () => {
  const h = harness()
  try {
    const frame = await call(h, 4, 'tools/list')
    const names = frame.result.tools.map((tool) => tool.name)
    assert.deepEqual(names, [
      'gauntlet_list',
      'gauntlet_start',
      'gauntlet_status',
      'gauntlet_submit',
      'gauntlet_reveal',
      'gauntlet_dispose',
    ])
    for (const tool of frame.result.tools) {
      assert.equal(tool.inputSchema.type, 'object')
      assert.ok(tool.description.length >= 20)
      assert.equal(typeof tool.annotations.readOnlyHint, 'boolean')
    }
  } finally {
    await h.close()
  }
})

test('tools/list marks only the destructive tool as destructive', async () => {
  const h = harness()
  try {
    const frame = await call(h, 5, 'tools/list')
    const destructive = frame.result.tools
      .filter((tool) => tool.annotations.destructiveHint === true)
      .map((tool) => tool.name)
    assert.deepEqual(destructive, ['gauntlet_dispose'])
  } finally {
    await h.close()
  }
})

test('a tool call returns rendered text content', async () => {
  const h = harness()
  try {
    const frame = await call(h, 6, 'tools/call', { name: 'gauntlet_list', arguments: {} })
    assert.equal(frame.result.isError, undefined)
    assert.equal(frame.result.content.length, 1)
    assert.equal(frame.result.content[0].type, 'text')
    assert.match(frame.result.content[0].text, /truncated-tail/)
  } finally {
    await h.close()
  }
})

test('a failing tool reports isError instead of a protocol error', async () => {
  const h = harness()
  try {
    const frame = await call(h, 7, 'tools/call', {
      name: 'gauntlet_status',
      arguments: { run: 'no-such-run' },
    })
    assert.equal(frame.error, undefined)
    assert.equal(frame.result.isError, true)
    assert.match(frame.result.content[0].text, /unknown run/)
  } finally {
    await h.close()
  }
})

test('an unknown tool is a protocol-level invalid params error', async () => {
  const h = harness()
  try {
    const frame = await call(h, 8, 'tools/call', { name: 'gauntlet_teleport', arguments: {} })
    assert.equal(frame.result, undefined)
    assert.equal(frame.error.code, -32602)
    assert.match(frame.error.message, /unknown tool/)
  } finally {
    await h.close()
  }
})

test('an unknown method is a method-not-found error', async () => {
  const h = harness()
  try {
    const frame = await call(h, 9, 'resources/list')
    assert.equal(frame.error.code, -32601)
  } finally {
    await h.close()
  }
})

test('a malformed frame is answered and does not end the session', async () => {
  const h = harness()
  try {
    h.raw('{not json\n')
    await h.settle()
    const parseError = h.frames.find((frame) => frame.error?.code === -32700)
    assert.ok(parseError, 'expected a parse error frame')

    // The session must still answer the next well-formed request.
    const frame = await call(h, 10, 'ping')
    assert.deepEqual(frame.result, {})
  } finally {
    await h.close()
  }
})

test('a notification is never answered', async () => {
  const h = harness()
  try {
    h.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    h.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } })
    await h.settle()
    assert.equal(h.frames.length, 0)
    assert.equal(h.server.initializeSeen, true)
  } finally {
    await h.close()
  }
})

test('an unrecognised notification is dropped silently', async () => {
  const h = harness()
  const writes = []
  const original = process.stderr.write.bind(process.stderr)
  process.stderr.write = (chunk) => {
    writes.push(String(chunk))
    return true
  }
  try {
    h.send({ jsonrpc: '2.0', method: 'notifications/from-the-future' })
    await h.settle()
    assert.equal(h.frames.length, 0)
    const noise = writes.filter((text) => text.includes('from-the-future'))
    assert.deepEqual(noise, [])
  } finally {
    process.stderr.write = original
    await h.close()
  }
})

test('pipelines are answered in the order they were sent', async () => {
  const h = harness()
  try {
    h.raw(`${JSON.stringify({ jsonrpc: '2.0', id: 'a', method: 'initialize', params: {} })}\n`)
    h.raw(`${JSON.stringify({ jsonrpc: '2.0', id: 'b', method: 'tools/list' })}\n`)
    h.raw(`${JSON.stringify({ jsonrpc: '2.0', id: 'c', method: 'ping' })}\n`)
    await h.settle()
    assert.deepEqual(
      h.frames.map((frame) => frame.id),
      ['a', 'b', 'c'],
    )
  } finally {
    await h.close()
  }
})

test('arguments that are not an object are rejected', async () => {
  const h = harness()
  try {
    const frame = await call(h, 11, 'tools/call', { name: 'gauntlet_list', arguments: [1, 2] })
    assert.equal(frame.error.code, -32602)
  } finally {
    await h.close()
  }
})

test('serve resolves when the input ends', async () => {
  const h = harness()
  h.send({ jsonrpc: '2.0', id: 12, method: 'ping' })
  await h.close()
  assert.equal(h.frames.length, 1)
})

test('a full run can be started, graded and revealed over the wire', async () => {
  const h = harness()
  try {
    const started = await call(h, 20, 'tools/call', {
      name: 'gauntlet_start',
      arguments: { scenario: 'truncated-tail', seed: 'mcp-wire' },
    })
    assert.equal(started.result.isError, undefined, started.result.content?.[0]?.text)
    const runId = /run (\S+)/.exec(started.result.content[0].text)[1]

    const graded = await call(h, 21, 'tools/call', {
      name: 'gauntlet_submit',
      arguments: { run: runId, fixed: false, summary: 'not fixed yet', diagnosis: [] },
    })
    assert.equal(graded.result.isError, undefined, graded.result.content?.[0]?.text)
    assert.match(graded.result.content[0].text, /\d+\/100/)

    const revealed = await call(h, 22, 'tools/call', {
      name: 'gauntlet_reveal',
      arguments: { run: runId },
    })
    assert.match(revealed.result.content[0].text, /truncated-tail/)

    await call(h, 23, 'tools/call', { name: 'gauntlet_dispose', arguments: { run: runId } })
  } finally {
    await h.close()
  }
})
