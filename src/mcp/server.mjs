#!/usr/bin/env node
/**
 * dsh-gauntlet — the MCP half.
 *
 * A zero-dependency stdio MCP server. It exists so the same gauntlet runs under
 * Codex (or any other MCP client) with the same tools, the same wording, and the
 * same scoring as the DSH half: both adapters translate `src/tools.mjs`, and
 * neither owns a second copy of the engine.
 *
 * Why hand-rolled instead of `@modelcontextprotocol/sdk`:
 *
 *   1. A stdio MCP server is launched by the client on every session, so its
 *      dependency tree is startup latency the user pays for. This one imports
 *      `node:*` and its own files and nothing else.
 *   2. The transport is small and stable: newline-delimited JSON-RPC 2.0 over
 *      stdin/stdout. Framing it correctly is thirty lines; pulling a package to
 *      do it would add an install step to a plugin that is otherwise `git clone`
 *      and go.
 *   3. A plugin that a user cannot audit end to end is a plugin they have to
 *      trust. Every byte this process writes is visible here.
 *
 * Wire discipline, learned from what breaks a client:
 *
 *   - stdout carries JSON-RPC frames and nothing else. One stray `console.log`
 *     corrupts the stream, so this module never writes to stdout except through
 *     `send()`.
 *   - A malformed line is answered with a parse error and does not end the
 *     session. A server that exits on a client's bad frame looks like a crash.
 *   - An ordinary tool failure is a *result* with `isError: true`, not a JSON-RPC
 *     error: the model must be able to read "unknown run X" and correct itself.
 *     JSON-RPC errors are reserved for protocol faults.
 *
 * @module dsh-gauntlet/mcp
 */

import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { assertToolSet, createTools } from '../tools.mjs';

/** The newest protocol revision this server implements. */
const LATEST_PROTOCOL = '2025-06-18';

/**
 * Revisions this server is willing to speak.
 *
 * The tool surface it exposes uses nothing that changed across these: no
 * sampling, no elicitation, no resources, no prompts, no roots. Listing the
 * older revisions lets an older client keep its own version instead of being
 * forced forward on a server that cannot use the difference.
 */
const PROTOCOL_VERSIONS = Object.freeze([
  LATEST_PROTOCOL,
  '2025-03-26',
  '2024-11-05',
]);

/** JSON-RPC error codes, by the spec's own numbering. */
const RPC_PARSE_ERROR = -32700;
const RPC_INVALID_REQUEST = -32600;
const RPC_METHOD_NOT_FOUND = -32601;
const RPC_INVALID_PARAMS = -32602;
const RPC_INTERNAL_ERROR = -32603;

/** A client that sends a longer line than this is not a client we support. */
const MAX_LINE_BYTES = 8 * 1024 * 1024;

/** Read this package's own manifest, so `serverInfo.version` cannot drift. */
function packageInfo() {
  try {
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
    );
    return {
      name: typeof manifest.name === 'string' ? manifest.name : 'dsh-gauntlet',
      version: typeof manifest.version === 'string' ? manifest.version : '0.0.0',
    };
  } catch {
    return { name: 'dsh-gauntlet', version: '0.0.0' };
  }
}

/** Log to stderr only: stdout belongs to the protocol. */
function log(message) {
  try {
    process.stderr.write(`[dsh-gauntlet] ${message}\n`);
  } catch {
    /* a broken stderr must not take the session down */
  }
}

/**
 * The MCP server, bound to one tool set.
 *
 * Split from the transport on purpose: `handle()` is a pure function of a parsed
 * message and returns the response to send (or `undefined` for a notification),
 * which is what makes it testable without spawning a process.
 */
export class GauntletServer {
  /**
   * @param {{tools?: import('../tools.mjs').ToolSpec[], version?: string}} [options]
   */
  constructor(options = {}) {
    this.tools = assertToolSet(options.tools ?? createTools());
    this.byName = new Map(this.tools.map((tool) => [tool.name, tool]));
    const info = packageInfo();
    this.version = options.version ?? info.version;
    this.name = info.name;
    this.initializeSeen = false;
  }

  /** `initialize` — negotiate a revision and advertise the tool capability. */
  initialize(params) {
    const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion : '';
    // Echoing the client's revision is how a client learns it was understood.
    // An unknown one is answered with this server's newest, which the client is
    // required to interpret as "not supported, here is what is".
    const protocolVersion = PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL;
    this.initializeSeen = true;
    return {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: this.name, version: this.version },
      instructions:
        'Fault-injection gauntlet. Call gauntlet_list, then gauntlet_start with a scenario id to get a run id and a copied workspace containing real damage. Fix the workspace, then call gauntlet_submit with a diagnosis. The sealed checks decide whether the repair is real; the tool never returns the answer before the run is graded.',
    };
  }

  /** `tools/list` — the tool surface, translated from the shared specs. */
  listTools() {
    return {
      tools: this.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.parameters,
        annotations: {
          title: tool.name,
          ...tool.annotations,
        },
      })),
    };
  }

  /**
   * `tools/call` — one tool invocation.
   *
   * A failure inside a tool becomes an `isError` result carrying the message,
   * because the model can act on that text. A protocol-level throw here would
   * only tell the client that the server is unhappy.
   */
  async callTool(params) {
    const name = typeof params?.name === 'string' ? params.name : '';
    const tool = this.byName.get(name);
    if (tool === undefined) {
      throw new RpcError(RPC_INVALID_PARAMS, `unknown tool: ${name || '(none)'}`);
    }
    const args = params?.arguments;
    if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
      throw new RpcError(RPC_INVALID_PARAMS, `arguments for ${name} must be an object`);
    }
    try {
      const result = await tool.run(args ?? {});
      return { content: [{ type: 'text', text: renderSafely(tool, result) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text', text: `gauntlet: ${name} failed: ${message}` }], isError: true };
    }
  }

  /**
   * Dispatch one decoded JSON-RPC message.
   *
   * @param {unknown} message - Parsed frame.
   * @returns {Promise<object|undefined>} Response, or undefined for a notification.
   */
  async handle(message) {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) {
      return rpcError(null, RPC_INVALID_REQUEST, 'expected a single JSON-RPC request object');
    }
    const isNotification = message.id === undefined || message.id === null;
    const method = typeof message.method === 'string' ? message.method : '';
    if (method === '') {
      return isNotification ? undefined : rpcError(message.id, RPC_INVALID_REQUEST, 'missing method');
    }

    try {
      const result = await this.dispatch(method, message.params);
      return isNotification ? undefined : { jsonrpc: '2.0', id: message.id, result };
    } catch (error) {
      if (isNotification) {
        // A notification has no reply channel; the spec says never to answer one.
        // An unrecognised notification is also not worth a warning: clients ship
        // new ones with every revision, and a noisy stderr is an ignored stderr.
        if (!(error instanceof RpcError && error.code === RPC_METHOD_NOT_FOUND)) {
          log(`notification ${method} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        return undefined;
      }
      const code = error instanceof RpcError ? error.code : RPC_INTERNAL_ERROR;
      const text = error instanceof Error ? error.message : String(error);
      return rpcError(message.id, code, text);
    }
  }

  /** Route a method name to its handler. */
  async dispatch(method, params) {
    // Notifications a client sends as a matter of course. Answering one is a
    // protocol error, and logging one as a failure trains the operator to
    // ignore this server's stderr, so they are accepted and dropped.
    if (method.startsWith('notifications/')) {
      if (method === 'notifications/initialized') this.initializeSeen = true;
      return {};
    }
    switch (method) {
      case 'initialize':
        return this.initialize(params);
      case 'ping':
        return {};
      case 'tools/list':
        return this.listTools();
      case 'tools/call':
        return await this.callTool(params);
      case 'shutdown':
        // Defined by an older lifecycle draft; a client that still sends it gets
        // an empty result and then closes the pipe itself.
        return {};
      default:
        throw new RpcError(RPC_METHOD_NOT_FOUND, `method not found: ${method}`);
    }
  }
}

/** A JSON-RPC-level failure, as opposed to a tool that reported a problem. */
class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
  }
}

/** Build an error frame. */
function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/**
 * Render a result for the model, falling back to JSON.
 *
 * The renderer is a convenience for the model's eyes, so a renderer that throws
 * must not cost the call its answer. `JSON.stringify` is itself guarded because
 * a result is only *expected* to be JSON, and a host crashes on an uncaught
 * exception in a frame handler.
 */
function renderSafely(tool, result) {
  try {
    const text = tool.render(result);
    if (typeof text === 'string') return text;
  } catch {
    /* fall through to the JSON rendering */
  }
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

/**
 * Serve one request/response session over a pair of streams.
 *
 * Kept separate from the process wiring so a test can drive it with in-memory
 * streams and no child process.
 *
 * @param {GauntletServer} server
 * @param {{input: NodeJS.ReadableStream, output: NodeJS.WritableStream}} streams
 * @returns {Promise<void>} Resolves when the input ends.
 */
export function serve(server, streams) {
  const { input, output } = streams;

  /**
   * Write one frame.
   *
   * Chained rather than fire-and-forget: two frames written concurrently would
   * interleave on a pipe, and a client that reads half a frame and half of the
   * next has no way to recover. The write callback, not the boolean return
   * value, is what says the bytes were accepted.
   */
  let chain = Promise.resolve();
  const send = (frame) => {
    const line = `${JSON.stringify(frame)}\n`;
    chain = chain.then(() => new Promise((resolve) => output.write(line, () => resolve())));
    return chain;
  };

  const lines = createInterface({ input, crlfDelay: Infinity, terminal: false });

  // Frames are handled in order: a client is allowed to pipeline
  // `initialize` + `tools/call`, and answering out of order would be legal but
  // would make a slow `gauntlet_submit` reorder a following `tools/list`.
  let queue = Promise.resolve();
  const enqueue = (line) => {
    queue = queue.then(() => handleLine(line));
    return queue;
  };

  async function handleLine(line) {
    const text = line.trim();
    if (text === '') return;
    if (Buffer.byteLength(text, 'utf8') > MAX_LINE_BYTES) {
      log(`dropped a ${Buffer.byteLength(text, 'utf8')}-byte frame`);
      await send(rpcError(null, RPC_INVALID_REQUEST, 'frame too large'));
      return;
    }
    let message;
    try {
      message = JSON.parse(text);
    } catch (error) {
      await send(
        rpcError(null, RPC_PARSE_ERROR, `invalid JSON: ${error instanceof Error ? error.message : String(error)}`),
      );
      return;
    }
    const response = await server.handle(message);
    if (response !== undefined) await send(response);
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      // Let the last frame reach the pipe before the process exits.
      queue.then(chain).then(() => resolve(), () => resolve());
    };
    lines.on('line', (line) => {
      enqueue(line);
    });
    lines.on('close', finish);
    input.on('end', finish);
    input.on('error', (error) => {
      log(`stdin failed: ${error.message}`);
      finish();
    });
  });
}

/** Start the server on the process's own stdin/stdout. */
export async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(
      [
        'dsh-gauntlet-mcp — fault-injection gauntlet over stdio MCP',
        '',
        'Usage: dsh-gauntlet-mcp',
        '',
        'Speaks newline-delimited JSON-RPC 2.0 on stdin/stdout.',
        'Nothing is printed to stdout except protocol frames.',
        '',
      ].join('\n'),
    );
    return 0;
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`${packageInfo().version}\n`);
    return 0;
  }

  const server = new GauntletServer();
  log(`serving ${server.tools.length} tools (v${server.version})`);

  // A client disconnecting is a normal end of session, not an error.
  process.stdout.on('error', (error) => {
    if (error && error.code === 'EPIPE') process.exit(0);
    log(`stdout failed: ${error instanceof Error ? error.message : String(error)}`);
  });

  await serve(server, { input: process.stdin, output: process.stdout });
  return 0;
}

// Act only when run as a program, so a test can import this module freely.
//
// Comparing `process.argv[1]` as a path string is the usual trick and it is
// wrong on Windows twice over: the argv entry may be relative, and a drive
// letter makes `file://` parsing ambiguous. Round-tripping through
// `pathToFileURL` asks the platform instead of guessing.
function invokedAsProgram() {
  if (process.env.DSH_GAUNTLET_MCP === '1') return true;
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return pathToFileURL(entry).href === import.meta.url;
  } catch {
    return false;
  }
}

if (invokedAsProgram()) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      log(`fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      process.exitCode = 1;
    },
  );
}

export { LATEST_PROTOCOL, PROTOCOL_VERSIONS };
