// mount.js — turning a declaration into live routes. CommonJS (see server/package.json).
//
// This is the whole adaptation layer between HTTP and a plugin's handlers. The
// handlers are plain functions that take and return plain values; everything
// that knows about a request or a response lives here, in one place, once —
// rather than being copied into every plugin that wants an interface.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { pathToFileURL } = require('node:url')

const { unmetContext } = require('./context.js')
const { refuseWrite } = require('./gate.js')
const { loadVocabulary, checkVocabulary, bindCommands } = require('./vocabulary.js')

/**
 * Routes live under a reserved prefix, and every mounted path must end in an
 * extension.
 *
 * Neither is decoration. The wiki claims root-level names for pages before any
 * plugin loads, so a route named after a plugin alone is answered by the page
 * of that name and never reached. And the page route is a pattern over pairs of
 * path segments whose second segment may not contain a dot — so a path ending
 * `.json` is invisible to it, while one ending in a bare word is swallowed and
 * answered with the wiki's own HTML. That failure is silent and looks like a
 * broken handler, so it is refused here instead.
 */
const EXTENSION = /\.[a-z0-9]+$/i

/** Coerce one query-string value using what the spec says it is. */
const coerce = (raw, schema = {}) => {
  if (raw === undefined) return undefined
  switch (schema.type) {
    case 'integer': {
      const n = parseInt(raw, 10)
      return Number.isNaN(n) ? raw : n
    }
    case 'number': {
      const n = Number(raw)
      return Number.isNaN(n) ? raw : n
    }
    case 'boolean':
      return raw === 'true' || raw === '1'
    case 'array':
      // Comma separated, the ordinary form for a repeated query value. Split
      // here so a handler receives what the document says it will, rather than
      // a string it has to know to split for itself.
      //
      // An agent calling the same operation sends a real array rather than a
      // query string, so one arriving already in the right shape is passed
      // through. Without this it would be stringified and split back, which
      // happens to work and would fail the moment a value contained a comma.
      //
      // An empty result means the caller supplied nothing usable — `?kinds=`,
      // or `?kinds=,,` — and must come back as undefined so the DECLARED default
      // applies. Returning `[]` would be defined, so the default would be
      // skipped and the caller would get an empty answer where the spec
      // promises a filled one. That divergence was live: the plugin's own older
      // route answered `?kinds=` with its default while this answered with
      // nothing.
      if (Array.isArray(raw)) {
        const kept = raw.map(v => String(v).trim()).filter(Boolean)
        return kept.length ? kept : undefined
      }
      const split = String(raw)
        .split(',')
        .map(v => v.trim())
        .filter(Boolean)
      return split.length ? split : undefined
    default:
      return raw
  }
}

/**
 * Query string in, plain object out — the only place a request is touched.
 * Missing parameters carrying a default are filled from the spec, so a handler
 * and a reader of the document agree about what happens when you leave one out.
 */
/**
 * A JSON request body's fields, read as parameters. The wiki has already parsed
 * the body by the time a route sees it, so a field arrives as a value much like
 * a query parameter does — and treating it as one means a body argument is
 * defaulted, coerced and required by exactly the rules a query argument is,
 * rather than by a second set kept level by hand. Bodies exist for what does
 * not fit in a URL: a transcript, a page of text.
 */
const bodyParameters = operation => {
  const schema = operation.requestBody?.content?.['application/json']?.schema
  if (!schema || !schema.properties) return []
  const required = new Set(schema.required || [])
  return Object.entries(schema.properties).map(([name, s]) => ({ name, in: 'body', schema: s, required: required.has(name) }))
}

/** Query and body parameters together — everything a caller may supply. */
const suppliedParameters = operation => [
  ...(operation.parameters || []).filter(p => p.in === 'query'),
  ...bodyParameters(operation),
]

/**
 * Whether the operation takes a file as its body. Such a body is never parsed:
 * it is streamed to a temporary file and the handler is told where, so a
 * recording of an hour costs disk rather than memory.
 */
const takesBinaryBody = operation =>
  Object.keys(operation.requestBody?.content || {}).some(t => t === 'application/octet-stream' || /\/\*$/.test(t))

/** Largest body accepted: the operator's setting, else the operation's own, else 500 MB. */
const bodyLimit = operation =>
  Number(process.env.FARM_API_MAX_BODY_BYTES) || Number(operation['x-fedwiki-max-bytes']) || 500 * 1024 * 1024

/**
 * Stream a request body into `dir`, refusing it the moment it passes `limit`.
 * The directory must lie outside anything the wiki serves: a half-received file
 * in the assets tree would be downloadable by anyone while it arrived.
 */
const receiveBody = (req, dir, limit) =>
  new Promise((resolve, reject) => {
    const tooLarge = () => Object.assign(new Error(`the body is larger than this farm accepts (${limit} bytes)`), { status: 413 })
    if (Number(req.get('content-length')) > limit) return reject(tooLarge())
    fs.mkdirSync(dir, { recursive: true })
    const tmpPath = path.join(dir, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.part`)
    const out = fs.createWriteStream(tmpPath, { flags: 'wx' })
    const hash = crypto.createHash('sha256')
    let size = 0
    let failed = false
    const fail = e => {
      if (failed) return
      failed = true
      req.unpipe(out)
      out.destroy()
      fs.rm(tmpPath, { force: true }, () => {})
      req.resume() // drain, so the client hears the refusal rather than a reset
      reject(e)
    }
    req.on('data', chunk => {
      size += chunk.length
      hash.update(chunk)
      if (size > limit) fail(tooLarge())
    })
    req.on('error', fail)
    req.on('aborted', () => fail(Object.assign(new Error('the upload was abandoned'), { status: 400 })))
    out.on('error', fail)
    out.on('finish', () => {
      if (failed) return
      resolve({ tmpPath, size, sha256: hash.digest('hex'), type: req.get('content-type') || 'application/octet-stream' })
    })
    req.pipe(out)
  })

const argumentsFor = (operation, query, context = {}) => {
  const args = {}
  for (const p of suppliedParameters(operation)) {
    const value = coerce(query[p.name], p.schema)
    if (value !== undefined) args[p.name] = value
    else if (p.schema && p.schema.default !== undefined) args[p.name] = p.schema.default
  }
  // Declared context. Some answers genuinely depend on where the question was
  // asked — the same operation put to two sites of one farm has two different
  // right answers. That is an input, so it arrives as one, named in the
  // specification rather than reached for. A handler gets only what it declared.
  for (const name of operation['x-fedwiki-context'] || []) {
    if (context[name] !== undefined) args[name] = context[name]
  }
  return args
}

const missingRequired = (operation, args) =>
  suppliedParameters(operation)
    .filter(p => p.required)
    .filter(p => args[p.name] === undefined || args[p.name] === '')
    .map(p => p.name)

/**
 * Load a declaration's handlers. Dynamic import, so a plugin may write its
 * handlers as ES modules or as CommonJS and the farm neither knows nor cares —
 * which is the point, since the two formats are both in use across the farm.
 */
const loadHandlers = async declaration => {
  const ns = await import(pathToFileURL(declaration.handlersPath).href)
  // A CommonJS module arrives with its exports both synthesized as named
  // exports and whole on `default`; an ES module has only the named ones.
  // Merging covers both, named exports winning, without having to ask which
  // format the plugin chose.
  const fromDefault = ns.default && typeof ns.default === 'object' ? ns.default : {}
  return { ...fromDefault, ...ns }
}

/**
 * Mount every operation a declaration describes. Returns what was mounted and
 * what was skipped — the caller logs both, because an operation that quietly
 * fails to appear is the hardest kind of fault to chase.
 */
const mountDeclaration = async ({ app, declaration, context = {} }) => {
  const handlers = declaration.handlersPath ? await loadHandlers(declaration) : {}
  const mounted = []
  const described = []
  const skipped = []

  // The vocabulary is optional and never fatal: a plugin with no item DSL has
  // none, and one whose table will not load or does not agree with its own spec
  // loses the table, not the interface.
  let vocabulary = null
  let vocabularyProblem = null
  if (declaration.vocabularyPath) {
    try {
      vocabulary = await loadVocabulary(declaration)
      const complaints = checkVocabulary(vocabulary, declaration.spec)
      if (complaints.length) {
        vocabularyProblem = complaints.join('; ')
        vocabulary = null
      }
    } catch (e) {
      vocabularyProblem = e.message
    }
    if (vocabularyProblem) skipped.push({ where: `${declaration.name} vocabulary`, why: vocabularyProblem })
  }

  for (const [specPath, operations] of Object.entries(declaration.spec.paths)) {
    for (const [method, operation] of Object.entries(operations)) {
      if (!['get', 'post', 'put', 'delete', 'patch'].includes(method)) continue

      const operationId = operation.operationId
      const where = `${declaration.name} ${method.toUpperCase()} ${specPath}`

      // A route the plugin already answers on its own server. Written down at
      // the address it actually lives at — absolute, not beneath the farm's
      // prefix, because the farm is describing it rather than hosting it and a
      // description that gave the wrong address would be worse than none.
      if (operation['x-fedwiki-served-by'] === 'plugin') {
        if (!operationId) {
          skipped.push({ where, why: 'no operationId, so it cannot be named in the document' })
          continue
        }
        described.push({
          method,
          route: specPath,
          operationId,
          summary: operation.summary || '',
          writes: operation['x-fedwiki-writes'] === true,
        })
        continue
      }

      const route = path.posix.join(declaration.base, specPath)

      if (!operationId) {
        skipped.push({ where, why: 'no operationId, so no handler can be named' })
        continue
      }
      const handler = handlers[operationId]
      if (typeof handler !== 'function') {
        skipped.push({ where, why: `handlers module exports no function ${operationId}` })
        continue
      }
      if (!EXTENSION.test(route)) {
        skipped.push({ where, why: `route ${route} has no extension and would be shadowed by the page route` })
        continue
      }
      // Refuse at mount rather than fail per request: an operation that asks for
      // context this farm cannot supply would answer wrongly, not partially.
      //
      // Checked against the NAMES the farm knows, not against the values in hand
      // — a generator running without a server has no values, and if that made
      // it skip the operation the rendered pages would describe a smaller farm
      // than the routes actually make.
      const unmet = unmetContext(operation)
      if (unmet.length) {
        skipped.push({ where, why: `declares context this farm cannot supply: ${unmet.join(', ')}` })
        continue
      }

      // An operation must say which kind it is, and saying nothing is not a
      // third kind. A plugin that declares neither gets nothing mounted —
      // because the alternative is inferring it from the method, and a plugin
      // author who forgot to think about this would have their omission read as
      // an answer.
      const readOnly = operation['x-fedwiki-read-only'] === true
      const writes = operation['x-fedwiki-writes'] === true

      if (readOnly && writes) {
        skipped.push({ where, why: 'declares itself both read-only and writing — one of the two is wrong' })
        continue
      }
      if (!readOnly && !writes) {
        skipped.push({
          where,
          why: 'declares neither x-fedwiki-read-only nor x-fedwiki-writes, and the farm mounts nothing whose nature it has not been told',
        })
        continue
      }
      if (readOnly && method !== 'get') {
        skipped.push({ where, why: `declared read-only but is a ${method.toUpperCase()} — read-only means GET` })
        continue
      }

      // The operation as a plain call: values in, value out, no request and no
      // response. The route below is a thin wrapper over it, and so is the tool
      // an agent calls — which is what makes "does the tool agree with the URL"
      // true by construction rather than by keeping two code paths level.
      //
      // `trusted` carries what only the route can know — the file a binary body
      // was streamed into. It is kept apart from `values` because values come
      // from callers, and a caller must never be able to name a path of its own.
      const binary = takesBinaryBody(operation)
      const call = async (values = {}, trusted = {}) => {
        if (binary && !trusted.body) {
          const e = new Error('this operation takes a file as its request body, so it can only be called over HTTP')
          e.status = 400
          throw e
        }
        const args = { ...argumentsFor(operation, values, context), ...(binary ? { body: trusted.body } : {}) }
        const missing = missingRequired(operation, args)
        if (missing.length) {
          const e = new Error(
            `missing required parameter${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`,
          )
          e.status = 400
          throw e
        }
        return handler(args)
      }

      app[method](route, async (req, res) => {
        try {
          // The gate lives at the entry point, not inside `call`, and it has to:
          // a handler is a plain function of its arguments and never sees who
          // asked. Only something holding the request can answer that, which is
          // why every door — this route, the try form, the agent door — asks
          // separately rather than trusting one central check it cannot see.
          if (writes) {
            const refusal = refuseWrite({
              app,
              req,
              origin: context.origin,
              status: context.status,
              scope: `${declaration.name}.${operationId}`,
            })
            if (refusal) {
              return res
                .status(refusal.status)
                .json({ error: refusal.error, plugin: declaration.name, operation: operationId })
            }
          }
          const values = bodyParameters(operation).length && req.body && typeof req.body === 'object'
            ? { ...req.query, ...req.body }
            : req.query
          if (!binary) return res.json(await call(values))
          const tmpDir = context.status ? path.join(context.status, 'farm-tmp') : path.join(os.tmpdir(), 'farm-tmp')
          const body = await receiveBody(req, tmpDir, bodyLimit(operation))
          try {
            res.json(await call(values, { body }))
          } finally {
            fs.rm(body.tmpPath, { force: true }, () => {}) // a handler that kept the file has already moved it
          }
        } catch (e) {
          res.status(e.status || 500).json({
            error: e.message,
            plugin: declaration.name,
            operation: operationId,
          })
        }
      })

      mounted.push({ method, route, operationId, summary: operation.summary || '', call, writes })
    }
  }

  return {
    mounted,
    described,
    skipped,
    vocabulary: vocabulary ? { ...vocabulary, commands: bindCommands(vocabulary, mounted) } : null,
  }
}

module.exports = { mountDeclaration, argumentsFor, missingRequired, coerce, bodyParameters, takesBinaryBody, receiveBody, EXTENSION }
