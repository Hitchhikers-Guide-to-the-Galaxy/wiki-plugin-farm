// resolve.js — finding who renders this farm's answers. CommonJS.
//
// The farm decides what is true; something else may decide what it looks like.
// A sibling plugin declares `fedwiki.render` — the contract version it renders
// and the module that renders it — and this resolves the declaration the way
// FreeCulture's FIND resolves a search provider: named provider if declared
// and understood, builtin fallback otherwise, the substitution always
// recorded. A farm that answers raw says so; a farm that answers beautifully
// says who dressed it.
//
// Refusals are returned, never thrown. Rendering is declinable by design, so
// nothing about a bad provider may cost the farm its routes — the worst a
// broken renderer can do is leave the farm plain.

const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const { RENDERS, SUPPORTED_RENDER_VERSIONS } = require('./contract.js')

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'))

/** Every sibling that declares itself a provider of the render contract. */
const declaredProviders = ({ packageDir, packageJson }) =>
  Object.keys((packageJson && packageJson.dependencies) || {})
    .filter(name => name.startsWith('wiki-plugin-') && name !== 'wiki-plugin-farm')
    .sort() // deterministic, like discovery — the result must not depend on dependency order
    .flatMap(name => {
      try {
        const pkg = readJson(path.join(packageDir, name, 'package.json'))
        const render = pkg.fedwiki && pkg.fedwiki.render
        return render ? [{ plugin: name, render }] : []
      } catch {
        return [] // an unreadable sibling is discovery's problem, not rendering's
      }
    })

/**
 * The renders this farm will use, and the record of how they were chosen.
 * Always answers: `renders` is usable whatever happened, and `record` is what
 * the merged document publishes at x-fedwiki-farm.render.
 */
const resolveRenders = async ({ packageDir, packageJson, builtin }) => {
  const fallback = { renders: builtin, record: { provider: 'builtin', version: SUPPORTED_RENDER_VERSIONS.at(-1) } }
  const declared = declaredProviders({ packageDir, packageJson })
  if (!declared.length) return fallback

  // One renderer per farm. Two declared providers cannot both dress the same
  // answers, so the first by name wins and the rest are recorded as refused —
  // visible, like every substitution here, rather than silently ignored.
  const [{ plugin, render }, ...rest] = declared
  const refuse = why => ({ ...fallback, record: { ...fallback.record, refused: { plugin, why } } })

  if (!SUPPORTED_RENDER_VERSIONS.includes(render.version)) {
    return refuse(
      `declares render contract version ${JSON.stringify(render.version)}, and this farm understands ${SUPPORTED_RENDER_VERSIONS.join(', ')}`,
    )
  }
  if (!render.module) return refuse('declares no render module')

  let renders
  try {
    const ns = await import(pathToFileURL(path.join(packageDir, plugin, render.module)).href)
    const provide = ns.provideRenders || (ns.default && ns.default.provideRenders)
    if (typeof provide !== 'function') return refuse(`${render.module} exports no provideRenders function`)
    renders = await provide({ builtin, version: render.version })
  } catch (e) {
    return refuse(`render module would not load — ${e.message}`)
  }

  // Every render the contract names, or none: a provider that dresses answers
  // but cannot draw a problem page would lose exactly the pages that explain
  // what went wrong.
  const missing = Object.values(RENDERS)
    .map(r => r.exports)
    .filter(name => typeof (renders || {})[name] !== 'function')
  if (missing.length) return refuse(`provides no ${missing.join(', ')}`)

  const record = { provider: plugin, version: render.version }
  if (rest.length) {
    record.refused = { plugin: rest.map(r => r.plugin).join(', '), why: `${plugin} already renders here — one renderer per farm` }
  }
  return { renders, record }
}

module.exports = { resolveRenders, declaredProviders }
