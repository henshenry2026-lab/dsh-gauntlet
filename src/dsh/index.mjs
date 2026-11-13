/**
 * dsh-gauntlet — host half.
 *
 * The plugin registers its tools on the `tools` service and nothing else. It
 * injects no optional service, imports no `@deepseek-ai/*` package, and holds no
 * runtime dependency: every third-party DSH plugin lives outside `app.asar`, so
 * the only modules it can rely on are `node:*` and its own files.
 *
 * Three disciplines, learned from how a broken plugin fails:
 *
 *   1. `apply()` never throws. A synchronous throw fails this loader entry's
 *      fiber and the boot audit reports "Failed to load plugins" — for a plugin
 *      whose entire job is to be optional.
 *   2. It injects only `tools`. Cordis treats every declared inject as required,
 *      so asking for a service a minimal profile does not mount would leave this
 *      fiber pending forever.
 *   3. A parameterised tool description is written for the model, not the log.
 *      The descriptions live in `src/tools.mjs` so both hosts offer the same
 *      wording; this file only translates them.
 *
 * @module dsh-gauntlet/dsh
 */

import { createTools, assertToolSet } from '../tools.mjs';

/** The id the loader row uses, matching `cordis.patch.yml`. */
export const name = 'dsh-gauntlet';

/** Only the tool registry: every profile has it. */
export const inject = ['tools'];

/**
 * A logger that cannot throw.
 *
 * A plugin whose logging breaks the boot is worse than a silent one. The host's
 * logger shape is probed rather than assumed.
 */
function makeLogger(ctx) {
  let sink = null;
  try {
    const candidate = ctx?.logger;
    sink = typeof candidate === 'function' ? candidate(name) : candidate ?? null;
  } catch {
    sink = null;
  }
  return (message) => {
    try {
      if (sink !== null && typeof sink.warn === 'function') sink.warn(`[${name}] ${message}`);
      else if (sink !== null && typeof sink.info === 'function') sink.info(`[${name}] ${message}`);
      else console.warn(`[${name}] ${message}`);
    } catch {
      /* logging must never break the boot */
    }
  };
}

/**
 * Register every gauntlet tool on the tools service.
 *
 * The registration shape follows the host's public contract: `register()` takes
 * `{ name, description, parameters, output, execute }` and returns a disposer.
 * `execute` receives the parsed arguments and an execution context; the result
 * is the object the model sees, rendered through `output.render`.
 *
 * @param {object} ctx - Host context.
 * @param {(message: string) => void} warn - Non-throwing logger.
 */
function registerTools(ctx, warn) {
  if (typeof ctx?.inject !== 'function') {
    warn('host context has no inject(); no tool was registered');
    return;
  }
  try {
    ctx.inject(['tools'], (scoped) => {
      try {
        if (typeof scoped?.tools?.register !== 'function') {
          warn('tools service has no register(); no tool was registered');
          return;
        }
        const tools = assertToolSet(createTools());
        for (const tool of tools) {
          const dispose = scoped.tools.register({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            output: {
              // The model reads the rendered text, so the schema only has to be
              // permissive enough to describe what run() returns.
              schema: { type: 'object' },
              render(_args, value) {
                try {
                  return [{ type: 'text', text: tool.render(value ?? {}) }];
                } catch (error) {
                  // A render failure must not lose the result entirely.
                  return [{ type: 'text', text: JSON.stringify(value ?? {}, null, 2) }];
                }
              },
            },
            async execute(args) {
              // Errors are returned as values, not thrown: a thrown error from a
              // tool is a host-level failure, while a failed gauntlet call is an
              // ordinary answer the model should read and act on.
              try {
                return await tool.run(args ?? {});
              } catch (error) {
                return {
                  error: String(error instanceof Error ? error.message : error),
                  tool: tool.name,
                };
              }
            },
          });
          try {
            if (typeof dispose === 'function' && typeof scoped.on === 'function') {
              scoped.on('dispose', dispose);
            }
          } catch {
            /* disposal is best-effort; the host unloads the fiber anyway */
          }
        }
      } catch (error) {
        warn(`could not register the gauntlet tools: ${String(error)}`);
      }
    });
  } catch (error) {
    warn(`could not inject the tools service: ${String(error)}`);
  }
}

/**
 * Plugin entry point. Never throws.
 * @param {object} ctx - Host context.
 */
export function apply(ctx) {
  try {
    const warn = makeLogger(ctx);
    registerTools(ctx, warn);
  } catch {
    /* apply() must not throw, whatever happens */
  }
}

/** The object Cordis receives. `Config` is intentionally absent: no settings. */
const plugin = { name, inject, apply };

export default plugin;
