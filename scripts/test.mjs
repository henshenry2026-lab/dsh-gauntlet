#!/usr/bin/env node
/**
 * Run every test file in this process.
 *
 * `node --test test/` is the idiomatic command, and it is what CI uses. It also
 * forks a child process per file, which a confined host may deny with `EPERM` —
 * a failure that says nothing about the code under test. Importing each file
 * instead runs the same `node:test` cases on the same runner without a child, so
 * the suite is green in a sandbox and in CI for the same reasons.
 *
 * The tradeoff is shared module state between files. Nothing here depends on
 * isolation: each test file builds its own runs and its own fixtures.
 *
 * Run with: node scripts/test.mjs
 */

import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const testDir = fileURLToPath(new URL('../test/', import.meta.url))
const files = readdirSync(testDir)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()

if (files.length === 0) {
  process.stderr.write('no test files found\n')
  process.exitCode = 1
} else {
  for (const name of files) {
    // Sequential and awaited in order, so a failure names the file it came from
    // instead of interleaving with the next file's output.
    await import(pathToFileURL(join(testDir, name)).href)
  }
}
