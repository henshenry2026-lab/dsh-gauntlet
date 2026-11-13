import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = fileURLToPath(new URL('../', import.meta.url))
const read = (relative) => readFileSync(join(root, relative), 'utf8')
const json = (relative) => JSON.parse(read(relative))
const has = (relative) => existsSync(join(root, relative))

/**
 * The package ships four manifests, and three of them are read by software that
 * silently ignores a bad one: a client that cannot parse `plugin.json` loads no
 * skills, and a client that cannot find the MCP entry loads no tools. Nothing
 * warns. These tests are the warning.
 */

test('the npm manifest and both plugin manifests agree on the name and version', () => {
  const pkg = json('package.json')
  const agentPlugins = json('plugin.json')
  const codex = json('.codex-plugin/plugin.json')

  assert.equal(pkg.name, 'dsh-gauntlet')
  assert.equal(agentPlugins.name, pkg.name)
  assert.equal(codex.name, pkg.name)
  assert.equal(agentPlugins.version, pkg.version)
  assert.equal(codex.version, pkg.version)
})

test('the Agent Plugins manifest satisfies its closed schema', () => {
  const manifest = json('plugin.json')
  const allowed = new Set([
    '$schema',
    'name',
    'version',
    'description',
    'author',
    'homepage',
    'repository',
    'license',
    'keywords',
    'extensions',
  ])
  for (const key of Object.keys(manifest)) {
    assert.ok(allowed.has(key), `plugin.json carries a field the schema rejects: ${key}`)
  }
  assert.equal(manifest.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json')
  assert.match(manifest.name, /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/)
  assert.ok(!manifest.name.includes('--') && !manifest.name.includes('..'))
  assert.ok(manifest.name.length <= 64)
  for (const key of Object.keys(manifest.author)) {
    assert.ok(['name', 'email', 'url'].includes(key), `author carries an unknown field: ${key}`)
  }
  assert.ok(Array.isArray(manifest.keywords))
  assert.ok(manifest.keywords.every((word) => typeof word === 'string'))
})

test('the Agent Plugins mcp.json only uses stdio with a plugin-relative path', () => {
  const config = json('mcp.json')
  assert.deepEqual(Object.keys(config).sort(), ['$schema', 'mcpServers'])
  assert.equal(config.$schema, 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json')

  const servers = Object.entries(config.mcpServers)
  assert.ok(servers.length >= 1)
  for (const [name, server] of servers) {
    assert.equal(server.type, 'stdio', `${name} must be stdio`)
    assert.ok(!server.command.includes(' '), `${name}.command must be one token`)
    // A plugin-relative path is the only form the spec resolves against the
    // plugin root; a bare `node` would depend on the client's PATH.
    assert.ok(server.command === 'node' || server.command.startsWith('./'))
    assert.ok(server.args.every((arg) => typeof arg === 'string'))
    const scriptArg = server.args.find((arg) => arg.includes('server.mjs'))
    assert.ok(scriptArg, `${name} must name the server entry`)
    const resolved = scriptArg.replace('${PLUGIN_ROOT}/', '')
    assert.ok(has(resolved), `${name} points at a file that does not exist: ${resolved}`)
    assert.ok(!server.cwd || server.cwd.startsWith('${PLUGIN_ROOT}') || server.cwd.startsWith('./'))
  }
})

test('the Codex manifest points at components that exist', () => {
  const manifest = json('.codex-plugin/plugin.json')
  assert.match(manifest.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Codex requires kebab-case')
  for (const field of ['skills', 'mcpServers']) {
    assert.ok(manifest[field].startsWith('./'), `${field} must start with ./`)
    assert.ok(!manifest[field].split('/').includes('..'), `${field} must not escape the plugin root`)
  }
  assert.ok(has(manifest.skills.replace('./', '')), 'skills directory is missing')
  assert.ok(has(manifest.mcpServers.replace('./', '')), 'Codex MCP config is missing')

  assert.ok(Array.isArray(manifest.interface.defaultPrompt))
  assert.ok(manifest.interface.defaultPrompt.length <= 3, 'at most 3 starter prompts')
  for (const prompt of manifest.interface.defaultPrompt) {
    assert.ok(prompt.length <= 128, `starter prompt is too long: ${prompt.length} chars`)
  }
})

test('the Codex MCP config can actually launch the server', () => {
  const config = json('.mcp.json')
  const servers = config.mcpServers ?? config
  const entry = servers.gauntlet
  assert.ok(entry, '.mcp.json must declare a gauntlet server')
  assert.equal(entry.command, 'node')
  assert.ok(Array.isArray(entry.args) && entry.args.length > 0)
  const script = entry.args.find((arg) => arg.endsWith('server.mjs'))
  assert.ok(script, '.mcp.json must name the server entry')
  assert.ok(has(script.replace('./', '')), `server entry does not exist: ${script}`)
})

test('the marketplace entry points at this package and nothing above it', () => {
  const marketplace = json('.agents/plugins/marketplace.json')
  assert.equal(typeof marketplace.name, 'string')
  assert.ok(Array.isArray(marketplace.plugins) && marketplace.plugins.length >= 1)
  const entry = marketplace.plugins.find((plugin) => plugin.name === 'dsh-gauntlet')
  assert.ok(entry, 'the marketplace must list this plugin')
  assert.equal(entry.source.source, 'local')
  assert.ok(entry.source.path.startsWith('./'), 'marketplace paths must start with ./')
  assert.ok(!entry.source.path.split('/').includes('..'), 'marketplace paths must not escape their root')
  assert.ok(['available', 'installed'].includes(entry.policy.installation))
  assert.ok(has('.codex-plugin/plugin.json'), 'the marketplace entry must resolve to a real plugin')
})

test('every skill is discoverable and has valid frontmatter', () => {
  const skillsDir = join(root, 'skills')
  assert.ok(existsSync(skillsDir), 'skills/ must exist')

  const names = readdirSync(skillsDir).filter((entry) => statSync(join(skillsDir, entry)).isDirectory())
  assert.ok(names.length >= 1, 'at least one skill must be packaged')

  for (const name of names) {
    const path = join(skillsDir, name, 'SKILL.md')
    assert.ok(existsSync(path), `skills/${name}/SKILL.md is missing`)
    const text = readFileSync(path, 'utf8')
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text)
    assert.ok(frontmatter, `skills/${name}/SKILL.md must open with frontmatter`)

    const fields = new Map()
    for (const line of frontmatter[1].split(/\r?\n/)) {
      const match = /^([a-z-]+):\s*(.*)$/.exec(line)
      if (match !== null) fields.set(match[1], match[2].trim())
    }
    assert.equal(fields.get('name'), name, 'a skill name must match its directory')
    assert.match(fields.get('name'), /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    const description = fields.get('description') ?? ''
    assert.ok(description.length >= 40, `skills/${name} needs a description long enough to route on`)
    assert.ok(description.length <= 1024, `skills/${name} description is too long to route on`)

    // The body is what the model reads, so an empty one is a broken skill.
    const body = text.slice(frontmatter[0].length).trim()
    assert.ok(body.length > 200, `skills/${name} body is too thin`)
  }
})

test('the DSH bundle patch names the same plugin id the module exports', () => {
  const patch = read('cordis.patch.yml')
  const module = read('src/dsh/index.mjs')

  const rows = [...patch.matchAll(/^\s+- id:\s*(\S+)/gm)].map((match) => match[1])
  assert.deepEqual(rows, ['dsh-gauntlet'], 'the patch must insert exactly one row')
  assert.match(patch, /name:\s*dsh-gauntlet/)
  assert.match(module, /export const name = 'dsh-gauntlet'/, 'the row name must equal the plugin name')
  assert.match(module, /export const inject = \['tools'\]/)
  assert.match(module, /export function apply\(ctx\)/)
  assert.match(module, /export default plugin/)

  // Comments and blank lines only: a patch with a stray top-level key would be
  // rejected by the loader, and the file is hand-edited often enough to matter.
  const body = patch
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'))
  assert.deepEqual(body, ['- insert:', '    - id: dsh-gauntlet', '      name: dsh-gauntlet'])
})

test('the DSH module imports nothing outside node: and its own files', () => {
  const module = read('src/dsh/index.mjs')
  const specifiers = [...module.matchAll(/^import .*? from '([^']+)'/gm)].map((match) => match[1])
  assert.ok(specifiers.length > 0)

  // The comment that documents this rule naturally contains the forbidden
  // specifier, so the rule is checked against imports, not against prose.
  const imports = [...module.matchAll(/^\s*(?:import|export)\b[^\n]*?from\s*'([^']+)'/gm)].map((match) => match[1])
  const required = [...module.matchAll(/^\s*import\s*'([^']+)'/gm)].map((match) => match[1])
  for (const specifier of [...imports, ...required]) {
    assert.ok(
      specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('node:'),
      `a third-party DSH plugin cannot import ${specifier}`,
    )
  }
})

test('the package publishes exactly what it declares', () => {
  const pkg = json('package.json')
  assert.equal(pkg.type, 'module')
  assert.ok(pkg.engines.node.startsWith('>='))
  assert.ok(pkg.files.includes('src'))
  assert.ok(pkg.files.includes('skills'))
  assert.ok(pkg.files.includes('cordis.patch.yml'))
  for (const entry of Object.values(pkg.exports)) {
    const path = entry.replace('./', '')
    assert.ok(has(path), `exports points at a missing file: ${entry}`)
  }
  assert.ok(has(pkg.bin['dsh-gauntlet-mcp'].replace('./', '')))
  assert.equal(pkg.mcpServers, './.mcp.json')
  // `files` gates the published tarball: anything the runtime reads but `files`
  // omits ships broken, and npm gives no error for that. The fixtures are load
  // bearing — the engine copies them at run time — so they must be published.
  for (const required of ['src', 'skills', 'fixtures', 'cordis.patch.yml', 'plugin.json', 'mcp.json', 'LICENSE']) {
    assert.ok(pkg.files.includes(required), `files/ must publish ${required}`)
  }
  for (const entry of Object.values(pkg.exports)) {
    const top = entry.replace('./', '').split('/')[0]
    if (top === 'package.json') continue
    assert.ok(
      pkg.files.includes(top),
      `exports ${entry} but files/ does not include ${top}`,
    )
  }
})

/** Import node:fs lazily so the top of this file stays dependency-free. */
