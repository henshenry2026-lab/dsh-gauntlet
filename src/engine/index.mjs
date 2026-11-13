/**
 * The engine's public surface.
 *
 * Everything a host needs is re-exported here so the DSH half and the MCP half
 * import one module and never reach into individual files. The engine itself is
 * pure `node:*` — no `@deepseek-ai/*` import, no dependency of any kind — which
 * is what lets the same code run inside a DSH plugin, inside an MCP stdio
 * server, and under plain `node --test`.
 *
 * @module dsh-gauntlet/engine
 */

export { createRng, MAX_SEED, normalizeSeed, seedFromText } from './rng.mjs';
export { FAULTS, FAULT_LIST, applyFault, faultById } from './faults.mjs';
export { SCENARIOS, SCENARIO_LIST, loadScenarioFile, resolveSeed, scenarioById, validateScenario } from './scenarios.mjs';
export { TIERS, WEIGHTS, compareCards, scoreRun } from './grader.mjs';
export {
  CHECK_TIMEOUT_MS,
  defaultRunRoot,
  disposeRun,
  fixtureWorkspace,
  gradeRun,
  parseCheck,
  prepareRun,
  readRunRecord,
  readSealed,
  resolveCheck,
  revealRun,
  verifyScriptsDir,
  workspaceFiles,
  workspacePath,
} from './runner.mjs';
export {
  contain,
  copyTree,
  diffSnapshots,
  exists,
  isDirectory,
  listFiles,
  readJson,
  readText,
  remove,
  sha256,
  snapshot,
  writeJson,
  writeText,
} from './workspace.mjs';
