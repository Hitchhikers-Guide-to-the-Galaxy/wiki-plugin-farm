#!/usr/bin/env node
// agrees.js — does the rendered page say the same thing as the document?
//
//   node test/agrees.js [http://localhost/system/api.json]
//
// Two renderings of the same declarations drift apart the moment one of them is
// generated differently from the other. This checks them against each other:
// every operation in the document must appear on a page, with every parameter
// it takes, and no page may describe a route the document does not have.
//
// Run it against a live farm. It reads the generated pages from disk, so it is
// checking the pages the farm is actually serving.

const fs = require('node:fs')
const path = require('node:path')

const url = process.argv[2] || 'http://localhost/system/api.json'
const pagesDir = path.join(__dirname, '..', 'pages')

const readPages = () =>
  fs
    .readdirSync(pagesDir)
    .filter(name => name === 'farm-api' || name.endsWith('-api'))
    .map(name => ({ slug: name, page: JSON.parse(fs.readFileSync(path.join(pagesDir, name), 'utf8')) }))

const textOf = page => page.story.map(i => i.text || '').join('\n')

const main = async () => {
  const document = await fetch(url).then(r => r.json())
  const pages = readPages()
  const everything = pages.map(p => textOf(p.page)).join('\n')
  const problems = []

  const operations = Object.entries(document.paths).flatMap(([route, methods]) =>
    Object.entries(methods).map(([method, operation]) => ({ route, method, operation })),
  )

  for (const { route, method, operation } of operations) {
    const signature = `\`${method.toUpperCase()} ${route}\``
    if (!everything.includes(signature)) {
      problems.push(`no page carries ${signature}`)
      continue
    }
    for (const p of operation.parameters || []) {
      if (p.in !== 'query') continue
      if (!everything.includes(`**${p.name}**`)) problems.push(`${route} — parameter ${p.name} is on no page`)
    }
    if (operation.summary && !everything.includes(operation.summary)) {
      problems.push(`${route} — summary "${operation.summary}" is on no page`)
    }
    // The page must offer a call somebody can run, not a shape of one.
    if (!everything.includes(`curl -s 'http://localhost${route}`)) {
      problems.push(`${route} — no runnable call on any page`)
    }
  }

  // The command tables, both directions. A plugin's vocabulary is the one place
  // where a hand edit is most tempting and least visible, so the check runs both
  // ways: nothing declared is missing from the pages, and nothing on the pages
  // was invented.
  for (const [plugin, vocabulary] of Object.entries(document['x-fedwiki-vocabulary'] || {})) {
    // Scope to THIS plugin's own page. Every declaring plugin renders its own
    // crossing table, and a regex over the concatenation of all pages only
    // ever finds the first one — which is how a wrong classification on the
    // fourth plugin's page sailed through while the first plugin's table
    // vouched for it.
    const own = pages.find(p => p.slug === `${plugin}-api`)
    const ownText = own ? textOf(own.page) : everything
    for (const [word, command] of Object.entries(vocabulary.commands)) {
      if (!everything.includes(`\`${word}\``)) problems.push(`${plugin} — command ${word} is on no page`)

      // Classification must survive rendering: the single most useful fact on
      // the page is which side of the wire a command lives on. Payload
      // commands cross exactly as parameter commands do — they carry the rest
      // of the line where a parameter command carries a fixed value.
      const crossing = /# Commands That Reach The Farm\n[\s\S]*?(?=\n# |$)/.exec(ownText)
      const crosses = crossing ? crossing[0].includes(`\`${word}\``) : false
      const shouldCross = ['parameter', 'operation', 'macro', 'payload'].includes(command.kind)
      if (crosses !== shouldCross && command.kind !== 'alias') {
        problems.push(`${plugin} — ${word} is ${command.kind} but is ${crosses ? '' : 'not '}listed as reaching the farm`)
      }
    }
    if (!everything.includes(`\`${vocabulary.itemType}\` item`)) {
      problems.push(`${plugin} — no page says which item type the commands are written into`)
    }
  }

  // Every value a parameter derived from a vocabulary may take must be on the page.
  for (const { operation } of operations) {
    for (const p of operation.parameters || []) {
      const byCommand = p['x-fedwiki-commands']
      if (!byCommand) continue
      for (const [value, word] of Object.entries(byCommand)) {
        if (!everything.includes(`\`${word}\` → ${value}`)) {
          problems.push(`${p.name}=${value} is not shown as written by ${word}`)
        }
      }
    }
  }

  // And nothing invented: every route a page names must be in the document.
  const named = [...everything.matchAll(/`([A-Z]+) (\/system\/api\/[^`]+)`/g)]
  for (const [, method, route] of named) {
    if (!document.paths[route] || !document.paths[route][method.toLowerCase()]) {
      problems.push(`a page describes ${method} ${route}, which the document does not offer`)
    }
  }

  // A context name an operation declares but the document never defines is a
  // promise to a reader that cannot be kept: it says the answer depends on
  // something, and then does not say what that something is or what it may be.
  const context = (document['x-fedwiki-farm'] || {}).context || {}
  for (const { route, operation } of operations) {
    for (const name of operation['x-fedwiki-context'] || []) {
      if (!context[name]) problems.push(`${route} declares context ${name}, which the document never defines`)
    }
  }
  const farm = document['x-fedwiki-farm'] || {}
  if (!farm.id) problems.push('the document carries no farm identity')
  if (!Array.isArray(farm.sites) || !farm.sites.length) problems.push('the document lists no sites')
  if (context.origin && context.origin.addressable && !Array.isArray(context.origin.values)) {
    problems.push('origin is marked addressable but offers no values to choose from')
  }

  console.log(`document: ${operations.length} operation(s) at ${url}`)
  console.log(`pages:    ${pages.map(p => p.slug).join(', ')}`)
  if (problems.length) {
    console.log('\nDISAGREE:')
    for (const p of problems) console.log('  ' + p)
    process.exitCode = 1
  } else {
    console.log('\nAGREE — every operation, parameter, summary and call matches.')
  }
}

main().catch(e => {
  console.error(e.message)
  process.exitCode = 1
})
