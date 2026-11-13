/**
 * The runner: prepare a run, seal the ground truth, grade an attempt, reveal.
 *
 * A run has three phases and each one is strictly separated from the others,
 * because the whole point of the gauntlet is that the agent must not be able to
 * read the answer:
 *
 *   prepare() — copy the workspace, inject faults, write `sealed/`, take the
 *               before snapshot. `sealed/` lives OUTSIDE the agent-visible tree.
 *   grade()   — run the declared checks, snapshot the tree, score the claim,
 *               and only then (optionally) reveal what was broken.
 *   reveal()  — the answer, long after the facts are fixed.
 *
 * Nothing here trusts the workspace: a fault target is validated by the fault
 * itself, a check string is run with an explicit argument list (never a shell),
 * and every path that arrives from a model argument goes through `contain()`.
 *
 * @module dsh-gauntlet/engine/runner
 */

import { spawnSync } from 'node:child_process';
import { closeSync, copyFileSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { createRng } from './rng.mjs';
import { applyFault } from './faults.mjs';
import {
  contain,
  copyTree,
  exists,
  isDirectory,
  listFiles,
  readJson,
  remove,
  snapshot,
  writeJson,
} from './workspace.mjs';
import { resolveSeed, scenarioById, validateScenario } from './scenarios.mjs';
import { scoreRun } from './grader.mjs';

/** How long one resolution check may take before it counts as failed. */
export const CHECK_TIMEOUT_MS = 120_000;

/** How many output characters a check result keeps, per stream. */
const OUTPUT_LIMIT = 4_000;

/**
 * Run one command without a shell, capturing its output through files.
 *
 * Two reasons it captures through files rather than pipes:
 *
 *   1. A shell is never involved. `spawnSync` with an argument list is the only
 *      safe way to run a check a scenario file supplied: `exec` would hand the
 *      string to a shell, and a shell would honour `;`, `&&`, `$(...)` and
 *      quotes from a file the user may have copied from somewhere.
 *   2. A confined host (DSH's own file sandbox is one) can deny the named pipes
 *      that `stdio: 'pipe'` needs, with `EPERM`. File descriptors keep working
 *      there, so the gauntlet still grades inside a sandboxed session instead of
 *      failing every check for a reason that has nothing to do with the answer.
 *
 * @param {string} command - Executable to run.
 * @param {string[]} args - Arguments, already split.
 * @param {string} cwd - Working directory.
 * @param {string} logDir - Directory for the two capture files.
 * @param {string} slug - Unique-enough name stem for those files.
 */
function runCommand(command, args, cwd, logDir, slug) {
  const outPath = join(logDir, `${slug}.out`);
  const errPath = join(logDir, `${slug}.err`);
  let outFd;
  let errFd;
  let result;
  try {
    mkdirSync(logDir, { recursive: true });
    outFd = openSync(outPath, 'w');
    errFd = openSync(errPath, 'w');
    result = spawnSync(command, args, {
      cwd,
      timeout: CHECK_TIMEOUT_MS,
      // `inherit` for stdin keeps an interactive child from blocking; stdout and
      // stderr go to files, never to a pipe this process would have to drain.
      stdio: ['ignore', outFd, errFd],
      windowsHide: true,
    });
  } finally {
    if (outFd !== undefined) closeSync(outFd);
    if (errFd !== undefined) closeSync(errFd);
  }
  const stdout = tailOf(outPath);
  const stderr = tailOf(errPath);
  for (const path of [outPath, errPath]) {
    try {
      unlinkSync(path);
    } catch {
      /* a leftover capture file is harmless */
    }
  }
  return {
    ok: result.status === 0,
    code: result.status,
    stdout,
    stderr,
    error: result.error === undefined || result.error === null ? null : String(result.error.message),
  };
}

/** The last OUTPUT_LIMIT characters of a file, or an empty string. */
function tailOf(path) {
  try {
    const text = readFileSync(path, 'utf8');
    return text.length > OUTPUT_LIMIT ? text.slice(-OUTPUT_LIMIT) : text;
  } catch {
    return '';
  }
}

/**
 * Split a declared check into an executable and arguments.
 *
 * The declaration is a string so a scenario file stays readable, but it is
 * split on whitespace only and never handed to a shell. Quoting is therefore
 * not supported on purpose: a check that needs an argument with a space should
 * be expressed as a script instead.
 *
 * @param {string} check - Declared check, e.g. `node --test test/money.test.mjs`.
 */
export function parseCheck(check) {
  const parts = String(check).trim().split(/\s+/);
  if (parts.length === 0 || parts[0] === '') throw new Error(`empty check: ${check}`);
  return { command: parts[0], args: parts.slice(1) };
}

/** The default root under the OS temp directory, one directory per run id. */
export function defaultRunRoot(runId) {
  return join(tmpdir(), 'dsh-gauntlet', runId);
}

/** A run id that sorts by time and cannot collide with a parallel run. */
function newRunId(scenarioId, seed) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${scenarioId}-${seed}-${stamp}`;
}

/**
 * Validate an explicit run id.
 *
 * The id becomes a directory name, so it may not contain a separator, a drive
 * letter, or `..`. Rejecting those here keeps a caller from writing a run
 * anywhere on disk by accident.
 *
 * @param {unknown} raw - Caller-supplied id.
 * @returns {string}
 */
function assertRunId(raw) {
  const id = String(raw ?? '').trim();
  if (id === '') throw new Error('runId must not be empty');
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new Error(`runId may only contain letters, digits, dot, dash and underscore: ${id}`);
  }
  if (id === '.' || id === '..') throw new Error(`runId must name a directory: ${id}`);
  return id;
}

/**
 * Turn a declared check into a concrete command.
 *
 * A scenario says `verify:money`, not `node /some/long/path/money.mjs`: the
 * sealed copy does not exist until the run directory does, and a scenario file
 * must not need to know where that is. Anything that is *not* a `verify:` name is
 * passed through as an ordinary command, so a user scenario can still run its
 * own toolchain.
 *
 * @param {string} declared - `verify:<name>` or a plain command line.
 * @param {{verifyDir: string, workspaceDir: string}} run - Where to resolve it.
 */
export function resolveCheck(declared, run) {
  const text = String(declared).trim();
  if (text.startsWith('verify:')) {
    const name = text.slice('verify:'.length).trim();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      throw new Error(`invalid verify name in check: ${declared}`);
    }
    const script = contain(run.verifyDir, `${name}.mjs`);
    if (!exists(script)) {
      throw new Error(`sealed verifier is missing: ${name} (expected ${script})`);
    }
    // The workspace is passed as an argument, never through the cwd alone: the
    // script imports from it by absolute URL, so a wrong cwd cannot silently
    // verify the package's own fixtures instead.
    return { declared, command: process.execPath, args: [script, run.workspaceDir], sealed: true };
  }
  const parsed = parseCheck(text);
  return { declared, ...parsed, sealed: false };
}

/**
 * Prepare a gauntlet run.
 *
 * @param {object} options
 * @param {string|object} options.scenario - Stock scenario id, or a scenario object.
 * @param {string} [options.source] - Workspace to copy. Defaults to the bundled fixture.
 * @param {string} [options.runRoot] - Parent directory for the run. Defaults to the OS temp dir.
 * @param {string} [options.runId] - Explicit directory name, for a caller that wants a
 *   stable path (CI, a test that must collide on purpose) instead of a timestamped one.
 * @param {unknown} [options.seed] - Seed override.
 * @param {boolean} [options.keep] - Allow an existing run directory.
 */
export function prepareRun(options = {}) {
  const scenario = typeof options.scenario === 'object' && options.scenario !== null
    ? validateScenario(options.scenario)
    : scenarioById(String(options.scenario ?? ''));
  const seed = resolveSeed(scenario, options.seed);
  const runId = options.runId === undefined
    ? newRunId(scenario.id, seed)
    : assertRunId(options.runId);
  const runRoot = options.runRoot === undefined
    ? defaultRunRoot(runId)
    : join(resolve(String(options.runRoot)), runId);

  const source = options.source === undefined
    ? fixtureWorkspace()
    : resolve(String(options.source));
  if (!isDirectory(source)) throw new Error(`workspace is not a directory: ${source}`);

  if (exists(runRoot) && options.keep !== true) {
    throw new Error(`run directory already exists: ${runRoot}`);
  }

  // `workspace/` is what the agent sees. `sealed/` never is: it holds the
  // original bytes, the fault evidence, and the scoring ground truth.
  const workspaceDir = join(runRoot, 'workspace');
  const sealedDir = join(runRoot, 'sealed');
  const fileCount = copyTree(source, workspaceDir);

  // Verification scripts are copied into `sealed/verify/` and run from there.
  // A scenario like `false-green` damages the workspace's own test suite, so a
  // check that used that suite would let a broken tree certify itself.
  const verifyDir = join(sealedDir, 'verify');
  copyVerifyScripts(verifyDir);

  const before = snapshot(workspaceDir);
  const rng = createRng(seed);
  const applied = [];
  for (const declaration of scenario.faults) {
    applied.push(applyFault(declaration, { workspaceDir, sealedDir, rng, scenario }));
  }

  const record = {
    schema: 'dsh-gauntlet/run/v1',
    runId,
    scenario: scenario.id,
    rank: scenario.rank,
    seed,
    source,
    runRoot,
    workspaceDir,
    sealedDir,
    verifyDir,
    checks: scenario.checks.map((check) => resolveCheck(check, { verifyDir, workspaceDir })),
    brief: scenario.brief,
    createdAt: new Date().toISOString(),
    fileCount,
    faultCount: applied.length,
  };

  writeJson(join(sealedDir, 'run.json'), record);
  writeJson(join(sealedDir, 'before.json'), before);
  writeJson(join(sealedDir, 'faults.json'), {
    scenario: scenario.id,
    seed,
    faults: applied.map((fault) => ({
      id: fault.id,
      target: fault.target,
      evidence: fault.evidence,
      restored: fault.restored,
      note: fault.note,
    })),
  });

  return { ...record, before, sealed: { faults: applied } };
}

/**
 * The answer key for a prepared run, read back from `sealed/`.
 * @param {object} run - Prepared run record.
 */
export function readSealed(run) {
  const faults = readJson(join(run.sealedDir, 'faults.json'));
  if (faults === null) throw new Error(`sealed fault record is missing for ${run.runId}`);
  return faults;
}

/**
 * Read a prepared run back from disk.
 *
 * A host that restarted — or a model resuming an old session — still knows the
 * run id, so a run must not evaporate with the process that created it. The
 * record is re-derived rather than trusted: every path it carries is checked
 * against the location that run id is allowed to own, because `sealed/run.json`
 * sits in a world-writable temp directory and a crafted one must not be able to
 * aim `disposeRun` at a real project.
 *
 * @param {string} runId - Run id.
 * @returns {object|null} The run record, or null when no usable run exists.
 */
export function readRunRecord(runId) {
  const id = assertRunId(runId);
  const runRoot = defaultRunRoot(id);
  const record = readJson(join(runRoot, 'sealed', 'run.json'));
  if (record === null || record.schema !== 'dsh-gauntlet/run/v1' || record.runId !== id) {
    return null;
  }
  const expected = {
    runRoot,
    workspaceDir: join(runRoot, 'workspace'),
    sealedDir: join(runRoot, 'sealed'),
    verifyDir: join(runRoot, 'sealed', 'verify'),
  };
  for (const [field, path] of Object.entries(expected)) {
    if (typeof record[field] !== 'string' || resolve(record[field]) !== resolve(path)) return null;
  }
  if (!Array.isArray(record.checks) || !isDirectory(record.workspaceDir)) return null;
  return record;
}

/** The before-snapshot, read from `sealed/` so a long-lived process does not hold it. */
function readBefore(run) {
  const before = readJson(join(run.sealedDir, 'before.json'));
  if (before === null) throw new Error(`before snapshot is missing for ${run.runId}`);
  return before;
}

/**
 * Grade an attempt.
 *
 * This must be called while the workspace still holds the agent's work: the
 * snapshots and the checks both read the tree as it is now. Revealing the
 * answer happens after, and separately, so a run that is never graded never
 * leaks what was wrong.
 *
 * @param {object} run - Record from `prepareRun`.
 * @param {object} claim - The agent's report.
 */
export function gradeRun(run, claim) {
  if (!isDirectory(run.workspaceDir)) {
    throw new Error(`workspace is gone: ${run.workspaceDir}`);
  }
  const logsDir = join(run.sealedDir, 'logs');
  const results = run.checks.map((check, index) => {
    // A run record read back from disk has `verify:` declarations resolved
    // already; one prepared in this process resolves here.
    const resolved = check.command === undefined
      ? resolveCheck(check.declared, run)
      : check;
    const outcome = runCommand(
      resolved.command,
      resolved.args,
      run.workspaceDir,
      logsDir,
      `check-${index}`,
    );
    return {
      declared: resolved.declared,
      sealed: resolved.sealed === true,
      command: resolved.command,
      args: resolved.args,
      ok: outcome.ok,
      code: outcome.code,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      error: outcome.error,
    };
  });
  const after = snapshot(run.workspaceDir);
  const sealed = readSealed(run);
  const card = scoreRun(
    { ...run, before: readBefore(run), after, checks: results, sealed },
    claim,
  );
  writeJson(join(run.sealedDir, 'card.json'), card);
  return card;
}

/**
 * Reveal what was broken, what the original bytes were, and how it scored.
 *
 * Only call this when the run is over. It reads `sealed/`, so calling it before
 * the agent has finished hands over the answer.
 *
 * @param {object} run - Prepared run.
 */
export function revealRun(run) {
  const sealed = readSealed(run);
  const originals = [];
  for (const [subdirectory, name] of [
    ['restore', 'restore'],
    ['doomed', 'doomed'],
  ]) {
    const dir = join(run.sealedDir, subdirectory);
    for (const entry of sealedFiles(dir)) {
      const record = readJson(join(dir, entry));
      if (record === null) continue;
      originals.push({ path: record.path, bytes: record.bytes, sha256: record.sha256, source: name });
    }
  }
  return {
    scenario: sealed.scenario,
    seed: sealed.seed,
    faults: sealed.faults.map((fault) => ({
      id: fault.id,
      target: fault.target,
      note: fault.note,
      evidence: fault.evidence,
    })),
    originals,
    card: readJson(join(run.sealedDir, 'card.json')),
    note:
      sealed.faults.length > 1
        ? 'More than one fault was present: a single green check does not mean the workspace is back.'
        : 'Compare the tree against the sealed originals to see exactly what was changed.',
  };
}

/** Filenames in a sealed subdirectory, or an empty list. */
function sealedFiles(dir) {
  try {
    return readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

/**
 * Delete a run directory. Refuses anything outside the OS temp root unless the
 * caller passes `force`, so a stray path cannot be pointed at a real project.
 * @param {object} run - Prepared run.
 * @param {{force?: boolean}} [options]
 */
export function disposeRun(run, options = {}) {
  const target = resolve(run.runRoot);
  const root = resolve(tmpdir());
  if (!target.startsWith(root) && options.force !== true) {
    throw new Error(`refusing to delete a run outside the temp directory: ${target}`);
  }
  remove(target);
  return { removed: target };
}

/**
 * Absolute path of the sealed verification scripts bundled with this package.
 *
 * These are *not* the workspace's tests. They are the answer key's judge: they
 * import the workspace's public modules and assert the behaviour the README
 * promises, so they stay correct even when the workspace's own suite has been
 * damaged or weakened.
 */
export function verifyScriptsDir() {
  return fileURLToPath(new URL('../../fixtures/verify/', import.meta.url));
}

/**
 * Copy the sealed verification scripts into a run.
 *
 * Copying (rather than referencing the package directory) matters for two
 * reasons: the run keeps working if the package is upgraded mid-run, and a
 * tampered `sealed/verify` is a local problem instead of a global one.
 *
 * @param {string} targetDir - Destination, normally `<run>/sealed/verify`.
 * @returns {string[]} Copied filenames.
 */
export function copyVerifyScripts(targetDir) {
  const from = verifyScriptsDir();
  if (!isDirectory(from)) return [];
  mkdirSync(targetDir, { recursive: true });
  const copied = [];
  for (const entry of readdirSync(from)) {
    if (!entry.endsWith('.mjs')) continue;
    copyFileSync(join(from, entry), join(targetDir, entry));
    copied.push(entry);
  }
  return copied.sort();
}

/**
 * Absolute path of the workspace bundled with this package.
 *
 * Resolved from this module's own URL rather than `process.cwd()`, because the
 * plugin runs inside a host whose working directory is the user's project.
 */
export function fixtureWorkspace() {
  return fileURLToPath(new URL('../../fixtures/workspace/', import.meta.url));
}

/**
 * Resolve a path inside a run's workspace, refusing anything outside it.
 * Model arguments arrive here.
 * @param {object} run - Prepared run.
 * @param {string} relativePath - Workspace-relative path.
 */
export function workspacePath(run, relativePath) {
  return contain(run.workspaceDir, relativePath);
}

/**
 * The files currently in the agent-visible workspace, for a caller that wants
 * to show the damage surface without showing the answer.
 * @param {object} run - Prepared run.
 */
export function workspaceFiles(run) {
  return listFiles(run.workspaceDir);
}
