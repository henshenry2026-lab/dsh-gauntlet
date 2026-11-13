# AGENTS.md

Working notes for an agent editing this repository. `README.md` is for humans;
this file is the part that keeps a change from breaking the package.

## What this repository is

A gauntlet for coding agents. It copies a small real project, damages it in
ways that look plausible, and scores an agent on detection, recovery, and
honesty. It ships as a DeepSeek Harness plugin **and** a Codex MCP server, from
one engine.

## Commands

```bash
npm test          # whole suite in one process (works in a sandbox)
npm run check     # syntax-check every entry point
npm run smoke     # all 8 scenarios, end to end
npm run smoke:mcp # spawn the real MCP server over pipes
npm run verify    # everything above, in order
```

Use `npm test`, not `node --test` directly, while working in a confined host:
`node --test` forks a child per file and the sandbox may deny it with `EPERM`.
CI uses `npm run test:ci`, where the fork is fine.

## The invariants

Break one of these and the plugin is wrong even if every test passes.

1. **The engine is pure `node:*`.** No dependency, no `@deepseek-ai/*` import,
   nothing outside this package. Third-party DSH plugins run from outside
   `app.asar`, so a host import would not resolve at boot — and the same engine
   has to run under plain `node` and inside the MCP server.
2. **One tool surface.** `src/tools.mjs` owns every description, schema, and
   handler. `src/dsh/index.mjs` and `src/mcp/server.mjs` translate that shape and
   nothing else. Two wordings for one tool would make scores incomparable.
3. **`apply()` never throws.** A synchronous throw fails the loader fiber, and
   the boot audit reports a broken plugin. Errors inside a tool are returned as
   values, not thrown.
4. **`inject` names only what must exist.** Cordis treats every declared inject
   as required; an optional service would leave the fiber pending forever.
5. **Checks live in `sealed/`, never in the workspace.** A scenario may damage
   the workspace's own test suite, so a check that ran those tests would let a
   broken tree certify itself.
6. **The answer stays sealed until grading.** Nothing on the tool surface returns
   the fault list before `gauntlet_submit`; `gauntlet_reveal` reads `sealed/` and
   says so when no card exists yet.
7. **stdout belongs to the protocol.** In `src/mcp/server.mjs`, nothing writes to
   stdout except `send()`. Log with `log()`, which writes to stderr.

## Adding a scenario

1. Add it to `SCENARIOS` in `src/engine/scenarios.mjs`. Keep the shape: `id`,
   `rank`, `label`, `brief`, `seed`, `faults`, `checks`.
2. Reference existing faults from `src/engine/faults.mjs` rather than new code
   where possible; a fault validates its own target and records the original
   bytes.
3. Point each check at a sealed verifier (`verify:<name>`) in `fixtures/verify/`.
   The verifier must import the workspace's public modules and assert behaviour,
   not implementation detail.
4. Run `npm run smoke`. Every scenario must satisfy: a correct repair scores 100,
   and doing nothing scores at most 21. A scenario that quietly punishes a correct
   fix is a bug in the scenario, not in the agent.

`scripts/smoke.mjs` is the contract test for a new scenario: read it before
adding one.

## Adding a fault

A fault exports an `apply(declaration, context)` that damages the workspace and
records what it changed, including the original bytes and a `restored` flag. It
must be idempotent enough to be replayable from a seed, and it must record
`evidence` entries (`path`, `category`, `detail`) because those entries are what
detection is scored against.

## Editing the MCP server

The transport is newline-delimited JSON-RPC 2.0. Keep these behaviours, each of
which has a test:

- A malformed frame is answered with a parse error and the session continues.
- A tool failure is a result with `isError: true`, not a JSON-RPC error.
- An unknown method is `-32601`; unknown tool or bad arguments are `-32602`.
- A notification is never answered, and an unrecognised one is not logged.
- Frames are answered in the order they arrived, even when pipelined.

## Manifests

Four manifests must stay consistent, and `test/packaging.test.mjs` enforces it:

| File | Read by |
| --- | --- |
| `package.json` | npm, DSH bundle discovery |
| `plugin.json` | Agent Plugins v1 clients |
| `.codex-plugin/plugin.json` | Codex |
| `mcp.json` / `.mcp.json` | Agent Plugins clients / Codex |

Component paths start with `./` and must not escape the plugin root. Bumping the
version means bumping it in `package.json`, `plugin.json`, and
`.codex-plugin/plugin.json` together; the test fails if they drift.

## Style

- ESM, `.mjs`, no build step, no transpiler.
- Comments explain *why* a decision is made, never *what* a line does. A comment
  that restates the code is noise; a comment that records a constraint is the
  most valuable line in the file.
- Test names read as sentences about behaviour, with the reason for the assertion
  in the message so a failure explains itself.
- Chinese and English docs are both first-class: change one, change the other.
