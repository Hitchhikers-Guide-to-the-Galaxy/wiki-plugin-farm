// merge.js — one document for the whole farm. CommonJS (see server/package.json).
//
// The prize the specification was chosen for. Each plugin describes itself in
// the ordinary format; merged, those descriptions become a single answer to
// "what can this farm do, and how do I call it" — for a reader, for a viewer
// that has never met this software, or for an agent that has never met the
// plugin.
//
// The document describes what is actually MOUNTED, never what was merely
// declared. An operation that was skipped — not read-only, no handler, a path
// the page route would shadow — must not appear, or the document becomes a
// promise the farm does not keep. What was refused or skipped is reported
// instead, under an extension field, because honest absence is more useful
// than silence.

const { deriveEnum } = require('./vocabulary.js')
const { sitesOf, farmIdentity, contextVocabulary } = require('./context.js')
const { describeGate, publicWritesAllowed } = require('./gate.js')

const OPENAPI_VERSION = '3.1.0'

/** wiki-plugin-freeculture → freeculture_ , namespacing that plugin's components. */
const prefixFor = name => `${name}_`

/**
 * Rewrite every local $ref in a subtree to its namespaced name.
 *
 * Two plugins may both call a schema `Result` and mean different things, so the
 * components of a merged document have to be namespaced. Rewriting the refs is
 * the whole cost of that, and it is done on a copy — a plugin's own spec, read
 * on its own, must keep working unchanged.
 */
const namespaceRefs = (node, prefix) => {
  if (Array.isArray(node)) return node.map(n => namespaceRefs(n, prefix))
  if (!node || typeof node !== 'object') return node

  const out = {}
  for (const [key, value] of Object.entries(node)) {
    if (key === '$ref' && typeof value === 'string' && value.startsWith('#/components/')) {
      const [, , kind, ...rest] = value.split('/')
      out[key] = `#/components/${kind}/${prefix}${rest.join('/')}`
    } else {
      out[key] = namespaceRefs(value, prefix)
    }
  }
  return out
}

/** A plugin's components, namespaced, ready to be poured into the farm's. */
const namespacedComponents = (spec, prefix) => {
  const out = {}
  for (const [kind, members] of Object.entries(spec.components || {})) {
    if (!members || typeof members !== 'object') continue
    out[kind] = {}
    for (const [name, definition] of Object.entries(members)) {
      out[kind][prefix + name] = namespaceRefs(definition, prefix)
    }
  }
  return out
}

/**
 * Build the farm's document from what is mounted.
 *
 * `registry` is a list of { declaration, mounted, skipped }, and `refused` is
 * the plugins whose declaration could not be read at all — a version not
 * understood, a missing module, a spec that declares no paths.
 */
const mergeDocument = ({ registry, refused = [], origin, version, farmRoot }) => {
  const paths = {}
  const components = {}
  const tags = []
  const skippedAll = []
  const vocabularies = {}

  // Sorted by plugin, not by whichever handlers module finished loading first.
  // Two farms carrying the same plugins must publish the same document, or
  // "did the description change" becomes an unanswerable question.
  const ordered = [...registry].sort((a, b) => a.declaration.name.localeCompare(b.declaration.name))

  for (const { declaration, mounted, described = [], skipped, vocabulary } of ordered) {
    const { name, spec, base } = declaration
    const prefix = prefixFor(name)
    if (vocabulary) {
      vocabularies[name] = {
        itemType: vocabulary.itemType,
        version: vocabulary.version,
        fallback: vocabulary.fallback,
        commands: vocabulary.commands,
      }
    }

    for (const { where, why } of skipped || []) skippedAll.push({ plugin: name, operation: where, why })
    if (!(mounted || []).length && !described.length) continue

    tags.push({
      name,
      description: (spec.info && spec.info.description) || (spec.info && spec.info.title) || '',
    })

    for (const { method, route, operationId, servedByPlugin } of [
      ...(mounted || []).map(m => ({ ...m, servedByPlugin: false })),
      ...described.map(m => ({ ...m, servedByPlugin: true })),
    ]) {
      // Find the operation the mount came from, by the id it was named by.
      let operation = null
      let declaredPath = null
      for (const [p, operations] of Object.entries(spec.paths)) {
        if (operations[method] && operations[method].operationId === operationId) {
          operation = operations[method]
          declaredPath = p
          break
        }
      }
      if (!operation) continue

      const merged = namespaceRefs(operation, prefix)
      // A parameter may say its values come from the plugin's command table
      // rather than repeating them. Filled here, so the allowed values and the
      // words an author may type are one list that cannot drift.
      for (const p of merged.parameters || []) {
        const from = p['x-fedwiki-from-commands']
        if (!from || !vocabulary) continue
        const values = deriveEnum(vocabulary, from)
        if (!values.length) continue
        const target = p.schema && p.schema.type === 'array' ? p.schema.items : p.schema
        if (target) target.enum = values
        p['x-fedwiki-commands'] = Object.fromEntries(
          Object.entries(vocabulary.commands)
            .filter(([, c]) => c.kind === 'parameter' && c.parameter === from && c.value !== undefined)
            .map(([word, c]) => [c.value, word]),
        )
      }
      // Say which operations are gated, and how. A reader refused by a rule
      // they were never told about learns only that something is broken; the
      // rule itself belongs in the description, beside the operation it governs.
      if (merged['x-fedwiki-writes'] === true) merged['x-fedwiki-gated'] = describeGate(origin)
      merged.tags = [name]
      merged.operationId = `${name}_${operationId}` // unique across the farm
      merged['x-fedwiki-plugin'] = declaration.plugin
      merged['x-fedwiki-declared-path'] = declaredPath
      // Who answers this. The farm serves what it mounted and merely writes down
      // what a plugin's own server already answers — and a reader needs to know
      // which, because only one of the two disappears if this plugin does.
      if (servedByPlugin) delete merged['x-fedwiki-base']
      else merged['x-fedwiki-base'] = base

      paths[route] = paths[route] || {}
      paths[route][method] = merged
    }

    for (const [kind, members] of Object.entries(namespacedComponents(spec, prefix))) {
      components[kind] = Object.assign(components[kind] || {}, members)
    }
  }

  const document = {
    openapi: OPENAPI_VERSION,
    info: {
      title: 'Federated Wiki Farm',
      version,
      description:
        'Every interface this farm offers, merged from what its plugins declare. ' +
        'A plugin declares a specification and a module of plain functions; the farm ' +
        'mounts them and describes them here. Only operations that are actually ' +
        'mounted appear — what was refused or skipped is listed under x-fedwiki-farm. ' +
        'A plugin whose wiki item text is a line-oriented command language publishes that ' +
        'language under x-fedwiki-vocabulary: each command says which parameter it produces, ' +
        'or that it never leaves the browser.',
    },
    paths,
  }
  if (origin) document.servers = [{ url: origin }]
  if (tags.length) document.tags = tags
  if (Object.keys(components).length) document.components = components

  if (Object.keys(vocabularies).length) document['x-fedwiki-vocabulary'] = vocabularies

  // Enough for something else to build on this without having to know the farm
  // beforehand. `servers` names the one site the request arrived at, which is
  // right for calling but useless for reach — so the farm says who it is, which
  // sites it has, and what the context names an operation declares actually
  // mean. Without those three a reader can call one site and no other.
  document['x-fedwiki-farm'] = {
    id: farmIdentity(farmRoot),
    writes: {
      mounted: Object.values(paths).flatMap(m => Object.values(m)).filter(o => o['x-fedwiki-writes']).length,
      publicSites: publicWritesAllowed() ? 'allowed' : 'refused unless FARM_API_PUBLIC_WRITES is set',
      offeredToAgents: false,
    },
    sites: sitesOf(farmRoot),
    context: contextVocabulary(farmRoot),
    declaring: ordered.map(r => r.declaration.plugin),
    served: {
      byTheFarm: Object.values(paths).flatMap(m => Object.values(m)).filter(o => o['x-fedwiki-base']).length,
      byThePluginItself: Object.values(paths).flatMap(m => Object.values(m)).filter(o => o['x-fedwiki-served-by'] === 'plugin').length,
    },
    refused,
    skipped: skippedAll,
  }

  return document
}

module.exports = { mergeDocument, namespaceRefs, namespacedComponents, prefixFor, OPENAPI_VERSION }
