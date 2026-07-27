// wiki-plugin-farm — the one server component the farm needs.
//
// A plugin that wants an interface declares two things in its own package
// metadata: a specification of what it offers, and a module of plain functions
// that answer it. Neither is a server. This finds those declarations, loads
// what they name, mounts the operations beneath a reserved prefix, and
// publishes one merged description of everything the farm can do.
//
// Authored as CommonJS on purpose. wiki-server loads a plugin's
// server/server.js with require() on older releases and import() on newer ones;
// CJS is the only format that works under both, on every Node version, and the
// wiki swallows the load error so an ESM server fails invisibly. The sibling
// server/package.json ({"type":"commonjs"}) confines that to this directory.

const fs = require('node:fs')
const path = require('node:path')

const { discover, PREFIX } = require('./discover.js')
const { mountDeclaration } = require('./mount.js')
const { mergeDocument } = require('./merge.js')
const { writePages } = require('./pages.js')
const { contextFor } = require('./context.js')
const { handleMessage, originAllowed, error: mcpError, INTERNAL_ERROR } = require('./mcp.js')
const { tryOperation } = require('./try.js')
const raw = require('./raw.js')
const { resolveRenders } = require('./resolve.js')

const log = (...args) => console.log('farm plugin:', ...args)

/** Our own version, for the merged document's info block. */
const ownVersion = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version
  } catch {
    return '0.0.0'
  }
}

/**
 * The document must be readable from another origin, or the compatibility
 * claim is empty: a viewer running on someone else's page fetches it from the
 * browser, and without this it never gets to see it. Reading a description of
 * public read-only operations gives nothing away that the operations do not.
 */
const allowAnyOrigin = res => {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.header('Access-Control-Allow-Headers', 'Accept, Content-Type')
}

const startServer = ({ argv, app, packageJson }) => {
  // Everything below is guarded per plugin. The wiki catches a failure in this
  // plugin but not in the plugins this plugin loads, so one bad declaration has
  // to cost one interface rather than every interface on the farm.
  const { found, failed } = discover({ packageDir: argv.packageDir, packageJson })

  // Where this server is: the site an operation may declare it needs to know.
  // Built once per site, because the farm runs one of these per domain.
  const context = contextFor(argv)

  const refused = failed.map(({ plugin, error }) => {
    log(`refused ${plugin} — ${error}`)
    return { plugin, why: error }
  })

  // What is mounted, as it becomes mounted. The document reads this at request
  // time rather than being built once, so it can never describe an operation
  // whose handler failed to load.
  const registry = []
  const version = ownVersion()

  // Who renders this farm's answers. A sibling may declare itself a provider
  // of the render contract; the builtin raw renders are the fallback, and the
  // outcome is recorded in the document either way. Resolved once, awaited by
  // every door that renders — a request cannot outrun it into the wrong dress.
  const builtin = {
    renderDeclaration: raw.renderDeclaration,
    renderIndex: raw.renderIndex,
    renderAnswer: raw.renderAnswer,
    renderProblem: raw.renderProblem,
  }
  let resolved = { renders: builtin, record: null }
  const resolving = resolveRenders({ packageDir: argv.packageDir, packageJson, builtin })
    .then(outcome => {
      resolved = outcome
      if (outcome.record.provider !== 'builtin') {
        log(`answers rendered by ${outcome.record.provider} (render contract ${outcome.record.version})`)
      }
      if (outcome.record.refused) log(`refused renderer ${outcome.record.refused.plugin} — ${outcome.record.refused.why}`)
      return outcome
    })
    .catch(e => {
      // Rendering is declinable; a broken resolution costs the dress, never the farm.
      log(`could not resolve a renderer — ${e.message}`)
      resolved = { renders: builtin, record: { provider: 'builtin', version: 1, refused: { plugin: 'unknown', why: e.message } } }
      return resolved
    })
  // Pages written after this server built its map of plugin pages, and so not
  // served until the next start. Reported rather than left to look like a bug.
  const pending = []

  // One description, read by everything that describes this farm — the document,
  // the pages and the tools an agent is offered. Built per request because the
  // registry fills in asynchronously and the origin comes from the caller.
  const describe = req => {
    const document = mergeDocument({
      registry,
      refused,
      origin: `${req.protocol}://${req.get('host')}`,
      version,
      farmRoot: context.farmRoot,
    })
    if (pending.length) document['x-fedwiki-farm'].pagesAwaitingRestart = [...pending]
    if (resolved.record) document['x-fedwiki-farm'].render = resolved.record
    return document
  }

  app.get(`${PREFIX}.json`, async (req, res) => {
    await resolving
    allowAnyOrigin(res)
    res.json(describe(req))
  })
  app.options(`${PREFIX}.json`, (req, res) => {
    allowAnyOrigin(res)
    res.sendStatus(204)
  })

  // The same declarations, for an agent. Three path segments on purpose: the
  // page route matches PAIRS of segments, so `/system/mcp` would be answered as
  // a page on GET while `/system/api/mcp` is invisible to it under any method.
  const MCP = `${PREFIX}/mcp`

  app.post(MCP, async (req, res) => {
    if (!originAllowed(req)) {
      return res.status(403).json({ error: 'cross-origin requests are not accepted here' })
    }
    const serverInfo = { name: 'federated-wiki-farm', version }
    const reply = async message => {
      try {
        return await handleMessage(message, { document: describe(req), registry, serverInfo })
      } catch (e) {
        log(`mcp ${message && message.method} failed — ${e.message}`)
        return mcpError(message && message.id, INTERNAL_ERROR, e.message)
      }
    }
    // A batch is answered as a batch, and a batch of notifications with the
    // silence the protocol asks for.
    if (Array.isArray(req.body)) {
      const replies = (await Promise.all(req.body.map(reply))).filter(Boolean)
      return replies.length ? res.json(replies) : res.status(202).end()
    }
    const reply1 = await reply(req.body)
    return reply1 ? res.json(reply1) : res.status(202).end()
  })

  // No server-initiated messages here, so there is no stream to open. Said
  // plainly, because a client that gets HTML back cannot tell why.
  app.get(MCP, (req, res) => {
    res.status(405).json({ error: 'this endpoint answers POST only — it opens no event stream' })
  })

  // Trying an operation from the page that describes it. Answers a page, which
  // the client puts in the lineup and never stores.
  //
  // Same-origin only, deliberately: the form on a generated page uses a relative
  // action, so the call lands on the site being read and an origin-relative
  // operation answers for the site you are looking at. No CORS headers, because
  // nothing off-site has business posting here.
  app.post(`${PREFIX}/try.json`, async (req, res) => {
    const { renders } = await resolving
    const answer = await tryOperation({
      document: describe(req),
      registry,
      params: req.body || {},
      origin: `${req.protocol}://${req.get('host')}`,
      site: context.origin,
      app,
      req,
      renders,
    }).catch(e => {
      log(`try failed — ${e.message}`)
      return renders.renderProblem({
        title: 'That did not work',
        why: `The farm could not answer: **${e.message}**`,
      })
    })
    // Always 200 — see try.js. A status the html plugin ignores is a button
    // that appears to do nothing.
    res.status(200).json(answer)
  })

  if (!found.length) {
    log(`no plugin declares an interface — ${PREFIX}.json will describe an empty farm`)
    return
  }

  // Mounting is asynchronous because loading a handlers module is. Each
  // declaration is awaited on its own chain, so a module that throws on import
  // takes only its own plugin down with it.
  const mounting = found.map(declaration =>
    mountDeclaration({ app, declaration, context })
      .then(({ mounted, described, skipped, vocabulary }) => {
        registry.push({ declaration, mounted, described, skipped, vocabulary })
        if (vocabulary) log(`read ${Object.keys(vocabulary.commands).length} commands from ${declaration.name}`)
        for (const { method, route, summary } of mounted) {
          log(`mounted ${method.toUpperCase()} ${route}${summary ? ` — ${summary}` : ''}`)
        }
        for (const { method, route } of described) {
          log(`described ${method.toUpperCase()} ${route} — served by ${declaration.plugin} itself`)
        }
        for (const { where, why } of skipped) {
          log(`skipped ${where} — ${why}`)
        }
      })
      .catch(e => {
        log(`refused ${declaration.plugin} — ${e.message}`)
        refused.push({ plugin: declaration.plugin, why: e.message })
      }),
  )

  // Once everything that is going to mount has mounted, render it as pages —
  // with whichever renders resolution chose.
  Promise.all([...mounting, resolving]).then(() => {
    try {
      const { created, updated } = writePages({ registry, dir: path.join(__dirname, '..', 'pages'), renders: resolved.renders })
      for (const slug of updated) log(`rewrote page ${slug}`)
      for (const slug of created) log(`wrote page ${slug} — new, served after the next restart`)
      if (created.length) pending.push(...created)
    } catch (e) {
      // A farm that cannot write its own pages must still serve its routes.
      log(`could not write pages — ${e.message}`)
    }
  })
}

module.exports = { startServer }
