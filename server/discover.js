// discover.js — reading what sibling plugins declare. CommonJS (see server/package.json).
//
// Registration pulls, it never pushes. Of the plugins installed on a farm most
// ship no server file at all, so they are never executed server-side and could
// never call a register function — there would be nothing running to call it.
// So a declaration has to be a file that this module reads, not a call it waits
// for. A useful side effect is that load order stops mattering: plugin servers
// are started asynchronously in no guaranteed order, and anything push-based
// would race.

const fs = require('node:fs')
const path = require('node:path')

/** Declaration versions this release understands. Anything else is refused whole. */
const SUPPORTED_VERSIONS = [1]

/** Everything mounted sits beneath this. See mount.js for why. */
const PREFIX = '/system/api'

/** wiki-plugin-freeculture → freeculture. The short name owns a path segment. */
const shortName = pkgName => pkgName.replace(/^wiki-plugin-/, '')

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'))

/**
 * Read one plugin's declaration. Returns null when the plugin declares nothing,
 * which is the ordinary case and not a fault. Throws only when a plugin has
 * declared something and that something is wrong — the caller guards each
 * plugin separately, so a bad declaration costs one interface and not all of
 * them.
 */
const readDeclaration = (packageDir, pkgName) => {
  const dir = path.join(packageDir, pkgName)
  const pkg = readJson(path.join(dir, 'package.json'))
  const api = pkg.fedwiki && pkg.fedwiki.api
  if (!api) return null

  if (!SUPPORTED_VERSIONS.includes(api.version)) {
    throw new Error(
      `declaration version ${JSON.stringify(api.version)} is not understood ` +
        `(this farm understands ${SUPPORTED_VERSIONS.join(', ')})`,
    )
  }
  if (!api.spec) throw new Error('declaration names no spec')

  const specPath = path.join(dir, api.spec)
  const spec = readJson(specPath)
  if (!spec.paths || typeof spec.paths !== 'object') throw new Error(`${api.spec} declares no paths`)

  // Handlers are needed only for what the farm is being asked to MOUNT. A plugin
  // that already answers on its own server declares its routes so they can be
  // described, and names no handlers because there is nothing for the farm to
  // call — the operations say `x-fedwiki-served-by: "plugin"` and the farm
  // writes them down rather than serving them.
  //
  // This is what lets one document describe everything the farm offers rather
  // than only the part of it this plugin happens to serve. The distinction is
  // kept visible in the document, because it decides who to blame when a route
  // breaks and what survives this plugin being uninstalled.
  const describesOnly = Object.values(spec.paths).every(operations =>
    Object.values(operations).every(o => o['x-fedwiki-served-by'] === 'plugin'),
  )
  if (!api.handlers && !describesOnly) {
    throw new Error('declaration names no handlers module, and not every operation is served by the plugin itself')
  }

  const handlersPath = api.handlers ? path.join(dir, api.handlers) : null
  if (handlersPath && !fs.existsSync(handlersPath)) throw new Error(`handlers module missing: ${api.handlers}`)

  // A plugin that parses its item text may name the vocabulary it parses with,
  // so the words an author may type and the values the operation accepts come
  // from one table. Optional: a plugin with no item DSL simply omits it, and a
  // vocabulary that will not load costs the vocabulary, never the interface.
  let vocabularyPath = null
  if (api.vocabulary) {
    vocabularyPath = path.join(dir, api.vocabulary)
    if (!fs.existsSync(vocabularyPath)) throw new Error(`vocabulary module missing: ${api.vocabulary}`)
  }

  return {
    plugin: pkgName,
    name: shortName(pkgName),
    version: api.version,
    dir,
    specPath,
    handlersPath,
    vocabularyPath,
    spec,
    base: `${PREFIX}/${shortName(pkgName)}`,
  }
}

/**
 * Every declaration installed on this farm, plus whatever went wrong reading
 * the rest. Failures are returned rather than thrown so the caller can mount
 * what works and report what does not.
 */
const discover = ({ packageDir, packageJson }) => {
  const found = []
  const failed = []

  const siblings = Object.keys((packageJson && packageJson.dependencies) || {})
    .filter(name => name.startsWith('wiki-plugin-'))
    .filter(name => name !== 'wiki-plugin-farm')
    .sort() // deterministic: the result must not depend on dependency order

  for (const name of siblings) {
    try {
      const declaration = readDeclaration(packageDir, name)
      if (declaration) found.push(declaration)
    } catch (e) {
      failed.push({ plugin: name, error: e.message })
    }
  }

  return { found, failed }
}

module.exports = { discover, readDeclaration, shortName, PREFIX, SUPPORTED_VERSIONS }
