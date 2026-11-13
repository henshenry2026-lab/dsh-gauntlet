# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-14

First public release.

### Added

- **Engine.** Deterministic fault injection seeded by FNV-1a + mulberry32, so the
  same seed and scenario reproduce byte-identical damage. Seven faults:
  `silent-truncation`, `lying-success`, `false-green`, `dirty-diff`,
  `removed-file`, `broken-config`, `stale-artifact`.
- **Eight scenarios**, from `truncated-tail` (intro) through `stale-build` (hard)
  to `ironclad` (boss, two interacting faults).
- **Three-axis scoring**: detection (45), recovery (40), honesty (15), with four
  tiers from Bystander to Ironclad. Scores are kept separate on purpose: an agent
  can repair everything and still report dishonestly, or diagnose perfectly and
  change nothing.
- **Sealed verification.** Checks are copied into `<run>/sealed/verify/` and
  assert behaviour against the workspace's public modules, so a damaged test
  suite cannot certify its own broken tree.
- **Six tools**, defined once in `src/tools.mjs` and offered by both hosts:
  `gauntlet_list`, `gauntlet_start`, `gauntlet_status`, `gauntlet_submit`,
  `gauntlet_reveal`, `gauntlet_dispose`.
- **DeepSeek Harness plugin** (`src/dsh/index.mjs`, `cordis.patch.yml`): one
  bundle row, no config, `apply()` never throws, injects only `tools`.
- **MCP server** (`src/mcp/server.mjs`): zero-dependency stdio JSON-RPC 2.0, no
  dependencies to install and no build step. Negotiates protocol revisions
  `2025-06-18`, `2025-03-26` and `2024-11-05`.
- **Portable packaging**: Agent Plugins v1 manifest (`plugin.json`, `mcp.json`)
  and Codex native manifest (`.codex-plugin/plugin.json`, `.mcp.json`,
  `.agents/plugins/marketplace.json`), both pointing at one `skills/` tree.
- **`gauntlet` skill** (`skills/gauntlet/SKILL.md`) explaining the drill loop,
  what each score measures, and the habits that score well.
- **Run recovery.** A run id survives a host restart: the record is re-read from
  disk and containment-checked, so a crafted `sealed/run.json` cannot aim
  deletion at a real project.
- **Sandbox tolerance.** Checks run with an explicit argument list (never a
  shell) and capture output through file descriptors, so grading works where
  `stdio: 'pipe'` is denied.
- 99 tests, an 8-scenario end-to-end smoke test, and an MCP child-process smoke
  test.

[Unreleased]: https://github.com/henshenry2026-lab/dsh-gauntlet/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/henshenry2026-lab/dsh-gauntlet/releases/tag/v0.1.0
