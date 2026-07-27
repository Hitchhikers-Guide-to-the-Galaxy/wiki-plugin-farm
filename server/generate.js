#!/usr/bin/env node
// generate.js — write the reference pages without a farm running. CommonJS.
//
// The wiki builds its map of plugin pages when a site's server starts, so a
// page file created afterwards waits for the next start. The farm plugin writes
// its pages at startup anyway — this is the same work done a moment earlier, so
// a first run has the pages before anything asks for them.
//
//   node server/generate.js [packageDir]
//
// packageDir defaults to the node_modules directory this plugin is installed
// in, which is where its siblings are.

const fs = require('node:fs')
const path = require('node:path')

const { discover } = require('./discover.js')
const { mountDeclaration } = require('./mount.js')
const { writePages } = require('./pages.js')
const raw = require('./raw.js')
const { resolveRenders } = require('./resolve.js')

const packageDir = path.resolve(process.argv[2] || path.join(__dirname, '..', '..'))
const wikiPackage = path.join(packageDir, '..', 'package.json')

const main = async () => {
  if (!fs.existsSync(wikiPackage)) {
    console.error(`no wiki package.json at ${wikiPackage} — pass the node_modules directory as an argument`)
    process.exitCode = 1
    return
  }
  const packageJson = JSON.parse(fs.readFileSync(wikiPackage, 'utf8'))
  const { found, failed } = discover({ packageDir, packageJson })
  for (const { plugin, error } of failed) console.log(`refused ${plugin} — ${error}`)

  // Mounting against a collector rather than express: the same code decides
  // what would be mounted, so the pages cannot describe a different farm from
  // the one the routes make.
  const collect = () => {}
  const app = { get: collect, post: collect, put: collect, delete: collect, patch: collect, options: collect }

  const registry = []
  for (const declaration of found) {
    try {
      // No argv here, so no context VALUES — mount decides what would mount from
      // the context NAMES it knows, so the pages describe the farm the routes make.
      registry.push({ declaration, ...(await mountDeclaration({ app, declaration })) })
    } catch (e) {
      console.log(`refused ${declaration.plugin} — ${e.message}`)
    }
  }

  // The same renderer the farm would resolve, so pages written early are the
  // pages the farm would have written.
  const { renders, record } = await resolveRenders({
    packageDir,
    packageJson,
    builtin: {
      renderDeclaration: raw.renderDeclaration,
      renderIndex: raw.renderIndex,
      renderAnswer: raw.renderAnswer,
      renderProblem: raw.renderProblem,
    },
  })
  if (record.provider !== 'builtin') console.log(`rendered by ${record.provider} (render contract ${record.version})`)
  if (record.refused) console.log(`refused renderer ${record.refused.plugin} — ${record.refused.why}`)

  const { created, updated, slugs } = writePages({ registry, dir: path.join(__dirname, '..', 'pages'), renders })
  console.log(`pages: ${slugs.join(', ') || 'none'}`)
  if (created.length) console.log(`  created ${created.join(', ')}`)
  if (updated.length) console.log(`  rewrote ${updated.join(', ')}`)
  if (!created.length && !updated.length) console.log('  already up to date')
}

main()
