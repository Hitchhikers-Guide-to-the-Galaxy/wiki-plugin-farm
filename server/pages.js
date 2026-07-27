// pages.js — writing the reference pages to disk. CommonJS.
//
// The rendering crossed to the render contract in phase 3 of the Plugin
// Feedback Plan — whichever renderer resolution chose draws each page, and
// this decides which pages exist and writes them. Generated pages are written
// into THIS plugin's own pages folder, which the wiki serves on every site of
// the farm without storing a copy in any of them: the served page is always
// regenerated and never stale, and the moment somebody wants to annotate it
// they fork it to their own site, where regeneration can never reach their
// copy. Hand edits are safe because they live somewhere else, not because the
// generator is careful.

const fs = require('node:fs')
const path = require('node:path')

const { slugFor, titleFor } = require('./raw.js')

/**
 * Write the pages, and say which ones are new.
 *
 * The wiki builds its map of plugin pages once, when a site's server starts, so
 * a page file that appears afterwards is not served until the next start. The
 * content of a page already in the map is read per request, so regeneration is
 * seen immediately — it is only a brand new page that waits. Rather than let
 * that look like a bug, the caller is told and says so.
 */
const writePages = ({ registry, dir, renders }) => {
  fs.mkdirSync(dir, { recursive: true })

  const documents = [{ slug: 'farm-api', page: renders.renderIndex(registry) }]
  for (const entry of registry) {
    // A plugin that only has routes described still gets a reference page —
    // those routes are the ones with no documentation anywhere else, so they
    // are the ones that most need one.
    if (!(entry.mounted || []).length && !(entry.described || []).length) continue
    documents.push({
      slug: slugFor(titleFor(entry.declaration)),
      page: renders.renderDeclaration(entry.declaration, entry),
    })
  }

  const created = []
  const updated = []
  for (const { slug, page } of documents) {
    const file = path.join(dir, slug)
    const body = JSON.stringify(page, null, 2) + '\n'
    const existed = fs.existsSync(file)
    if (existed && fs.readFileSync(file, 'utf8') === body) continue
    fs.writeFileSync(file, body)
    ;(existed ? updated : created).push(slug)
  }

  return { created, updated, slugs: documents.map(d => d.slug) }
}

module.exports = { writePages }
