#!/usr/bin/env node
/**
 * Launch the MCP server as a real child process and talk to it over real pipes.
 *
 * The in-process transport test proves the protocol logic; this proves the thing
 * a client actually does: resolve the executable, spawn it, write frames to its
 * stdin, and read frames back from its stdout. Those are different failures.
 *
 * Output is captured through files instead of `stdio: 'pipe'` because a sandboxed
 * host can deny the named pipes a pipe needs, and a smoke test that fails inside
 * a sandbox for a reason unrelated to the server is a smoke test nobody runs.
 *
 * Run with: node scripts/mcp-smoke.mjs
 */

import { spawnSync } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const serverPath = fileURLToPath(new URL('../src/mcp/server.mjs', import.meta.url))

/** One request frame, newline-delimited as the transport requires. */
function frame(id, method, params) {
  return `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`
}

const session = [
  frame(1, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'mcp-smoke', version: '0.0.0' },
  }),
  `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
  frame(2, 'tools/list'),
  frame(3, 'ping'),
]

const workdir = mkdtempSync(join(tmpdir(), 'dsh-gauntlet-mcp-smoke-'))
const stdinPath = join(workdir, 'stdin.txt')
const stdoutPath = join(workdir, 'stdout.txt')
const stderrPath = join(workdir, 'stderr.txt')
writeFileSync(stdinPath, session.join(''), 'utf8')

let result
let stdout = ''
let stderr = ''
try {
  const inFd = openSync(stdinPath, 'r')
  const outFd = openSync(stdoutPath, 'w')
  const errFd = openSync(stderrPath, 'w')
  try {
    result = spawnSync(process.execPath, [serverPath, '--stdio'], {
      stdio: [inFd, outFd, errFd],
      timeout: 60_000,
      windowsHide: true,
    })
  } finally {
    closeSync(inFd)
    closeSync(outFd)
    closeSync(errFd)
  }
  stdout = readFileSync(stdoutPath, 'utf8')
  stderr = readFileSync(stderrPath, 'utf8')
} finally {
  rmSync(workdir, { recursive: true, force: true })
}

const failures = []
const check = (condition, message) => {
  if (!condition) failures.push(message)
}

check(result?.status === 0, `the server exited with ${result?.status}: ${result?.error?.message ?? stderr}`)

const frames = stdout
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => {
    try {
      return JSON.parse(line)
    } catch {
      failures.push(`stdout carried a line that is not JSON: ${line.slice(0, 120)}`)
      return null
    }
  })
  .filter((value) => value !== null)

check(frames.length === 3, `expected 3 response frames, got ${frames.length}`)
check(
  frames.every((value) => value.jsonrpc === '2.0'),
  'every frame must declare jsonrpc 2.0',
)
check(
  frames.every((value) => 'id' in value),
  'every answer must carry the id it answers',
)

const init = frames.find((value) => value.id === 1)
check(init?.result?.protocolVersion === '2025-06-18', 'initialize must negotiate the requested revision')
check(init?.result?.capabilities?.tools?.listChanged === false, 'initialize must advertise the tools capability')

const list = frames.find((value) => value.id === 2)
const names = (list?.result?.tools ?? []).map((tool) => tool.name)
check(names.length === 6, `expected 6 tools, got ${names.length}: ${names.join(', ')}`)
check(names.includes('gauntlet_start'), 'the start tool must be listed')
check(names.includes('gauntlet_submit'), 'the submit tool must be listed')

const ping = frames.find((value) => value.id === 3)
check(ping?.result !== undefined, 'ping must be answered')

if (failures.length > 0) {
  process.stderr.write(`mcp smoke failed:\n${failures.map((line) => `  - ${line}`).join('\n')}\n`)
  if (stderr.trim() !== '') process.stderr.write(`\nserver stderr:\n${stderr}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`mcp smoke: ${frames.length} frames, ${names.length} tools, revision ${init.result.protocolVersion}\n`)
}
