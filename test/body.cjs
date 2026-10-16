#!/usr/bin/env node
// body.cjs — request bodies, and the farm's own assets operations.
//
//   node test/body.cjs
//
// No farm, no network beyond loopback. A temporary site stands in for a real
// one, the farm's own declaration is mounted on a few lines of router over
// node:http, and it is asked what a recorder, an agent and an intruder would
// ask: store a file, store it again, climb out of the folder, send too much,
// send nothing, list what is there. A small declaration of our own checks that
// JSON body fields arrive as arguments with the spec's defaults and rules.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')

const { readDeclaration } = require('../server/discover.js')
const { mountDeclaration } = require('../server/mount.js')
const { contextFor } = require('../server/context.js')

// ---------- a site on disk ----------
const farmRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-body-'))
const site = path.join(farmRoot, 'test.localhost')
const status = path.join(site, 'status')
fs.mkdirSync(status, { recursive: true })
const context = contextFor({ status, url: 'http://test.localhost', port: 0 })

// ---------- just enough of express ----------
const routes = []
let owner = true
const app = {
  securityhandler: { isAuthorized: () => owner },
}
for (const m of ['get', 'post', 'put', 'delete', 'patch']) app[m] = (route, fn) => routes.push({ m, route, fn })

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://test.localhost')
  const found = routes.find(r => r.m === req.method.toLowerCase() && r.route === url.pathname)
  res.status = code => ((res.statusCode = code), res)
  res.json = value => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(value))
  }
  req.get = name => req.headers[name.toLowerCase()]
  req.query = Object.fromEntries(url.searchParams)
  if (!found) return res.status(404).json({ error: 'no route' })
  // what bodyParser.json does in the wiki, and only for JSON
  if ((req.headers['content-type'] || '').startsWith('application/json')) {
    let text = ''
    req.on('data', c => (text += c))
    req.on('end', () => {
      req.body = text ? JSON.parse(text) : {}
      found.fn(req, res)
    })
  } else {
    req.body = {}
    found.fn(req, res)
  }
})

const problems = []
const check = (name, ok, detail = '') => {
  if (!ok) problems.push(detail ? `${name} — ${detail}` : name)
}

const main = async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const ask = async (method, route, { body, type } = {}) => {
    const res = await fetch(base + route, { method, body, headers: type ? { 'content-type': type } : {} })
    let json = null
    try {
      json = await res.json()
    } catch {}
    return { status: res.status, json }
  }

  // ---------- the farm's own declaration ----------
  const ownDir = path.resolve(__dirname, '..')
  const declaration = readDeclaration(path.dirname(ownDir), path.basename(ownDir))
  check('farm declares itself as "farm"', declaration && declaration.name === 'farm')
  const { mounted, skipped } = await mountDeclaration({ app, declaration, context })
  check('upload and list mounted', mounted.length === 2, JSON.stringify(skipped))

  const UP = '/system/api/farm/assets/upload.json'
  const LIST = '/system/api/farm/assets/list.json'
  const audio = Buffer.from('OggS fake audio bytes')

  let r = await ask('POST', `${UP}?folder=open-questions&name=note.webm`, { body: audio, type: 'audio/webm' })
  check('upload — 200', r.status === 200, JSON.stringify(r.json))
  const stored = path.join(site, 'assets', 'open-questions', 'note.webm')
  check('upload — file in place', fs.existsSync(stored) && fs.readFileSync(stored).equals(audio))
  check('upload — src', r.json && r.json.src === 'assets/open-questions/note.webm')
  check('upload — size', r.json && r.json.size === audio.length)
  check('upload — sha256', r.json && /^[a-f0-9]{64}$/.test(r.json.sha256))
  check('upload — type kept', r.json && r.json.type === 'audio/webm')
  check('upload — nothing left in farm-tmp', fs.readdirSync(path.join(status, 'farm-tmp')).length === 0)

  r = await ask('POST', `${UP}?folder=open-questions&name=note.webm`, { body: audio, type: 'audio/webm' })
  check('same name — 409', r.status === 409)
  r = await ask('POST', `${UP}?folder=open-questions&name=note.webm&replace=true`, { body: Buffer.from('new'), type: 'audio/webm' })
  check('replace=true — 200', r.status === 200 && fs.readFileSync(stored, 'utf8') === 'new')

  for (const [label, q] of [
    ['.. folder', 'folder=../status&name=x.webm'],
    ['dotted folder', 'folder=a.b&name=x.webm'],
    ['separator in name', 'folder=p&name=a%2Fb.webm'],
    ['hidden name', 'folder=p&name=.env'],
    ['no folder', 'name=x.webm'],
  ]) {
    r = await ask('POST', `${UP}?${q}`, { body: audio, type: 'audio/webm' })
    check(`${label} — refused 400`, r.status === 400, `got ${r.status}`)
  }
  r = await ask('POST', `${UP}?folder=/etc&name=passwd`, { body: audio, type: 'audio/webm' })
  check('absolute folder — confined to assets/etc', r.status === 200 && fs.existsSync(path.join(site, 'assets', 'etc', 'passwd')))
  check('nothing escaped the site', !fs.existsSync(path.join(farmRoot, 'passwd')) && !fs.existsSync(path.join(site, 'status', 'x.webm')))
  r = await ask('POST', `${UP}?folder=home&name=index.html`, { body: Buffer.from('<p>hi</p>'), type: 'text/html' })
  check('html inside home — 200', r.status === 200)
  r = await ask('POST', `${UP}?folder=my-page&name=deck.html`, { body: Buffer.from('<p>deck</p>'), type: 'text/html' })
  check('html in a page folder — 200', r.status === 200 && fs.readFileSync(path.join(site, 'assets', 'my-page', 'deck.html'), 'utf8') === '<p>deck</p>')

  process.env.FARM_API_MAX_BODY_BYTES = '10'
  r = await ask('POST', `${UP}?folder=p&name=big.webm`, { body: Buffer.alloc(64), type: 'audio/webm' })
  check('too large — 413', r.status === 413, `got ${r.status}`)
  check('too large — no partial file', !fs.existsSync(path.join(site, 'assets', 'p', 'big.webm')))
  check('too large — farm-tmp clean', fs.readdirSync(path.join(status, 'farm-tmp')).length === 0)
  delete process.env.FARM_API_MAX_BODY_BYTES

  owner = false
  r = await ask('POST', `${UP}?folder=p&name=intruder.webm`, { body: audio, type: 'audio/webm' })
  check('not the owner — 403', r.status === 403)
  check('not the owner — no file', !fs.existsSync(path.join(site, 'assets', 'p', 'intruder.webm')))
  owner = true

  const upload = mounted.find(m => m.operationId === 'assetsUpload')
  let refusedCall = null
  try {
    await upload.call({ folder: 'p', name: 'x.webm', body: { tmpPath: '/etc/hosts' } })
  } catch (e) {
    refusedCall = e
  }
  check('a caller cannot name the body file', refusedCall && refusedCall.status === 400)

  r = await ask('GET', `${LIST}?folder=open-questions`)
  check('list — the stored file', r.status === 200 && r.json.files.some(f => f.name === 'note.webm'))

  // ---------- a public site, and the operator's switches ----------
  const pubContext = contextFor({ status: path.join(farmRoot, 'trust.private.fish', 'status') })
  fs.mkdirSync(pubContext.status, { recursive: true })
  routes.length = 0
  await mountDeclaration({ app, declaration, context: pubContext })
  r = await ask('POST', `${UP}?folder=p&name=a.webm`, { body: audio, type: 'audio/webm' })
  check('public site, no setting — 403', r.status === 403)
  process.env.FARM_API_PRIVATE_SUFFIXES = '.private.fish'
  r = await ask('POST', `${UP}?folder=p&name=a.webm`, { body: audio, type: 'audio/webm' })
  check('private suffix — 200', r.status === 200, JSON.stringify(r.json))
  delete process.env.FARM_API_PRIVATE_SUFFIXES
  process.env.FARM_API_PUBLIC_WRITES = 'farm.assetsUpload'
  r = await ask('POST', `${UP}?folder=p&name=b.webm`, { body: audio, type: 'audio/webm' })
  check('scoped public write — 200', r.status === 200)
  process.env.FARM_API_PUBLIC_WRITES = 'pod.somethingElse'
  r = await ask('POST', `${UP}?folder=p&name=c.webm`, { body: audio, type: 'audio/webm' })
  check('other scope listed — 403', r.status === 403)
  delete process.env.FARM_API_PUBLIC_WRITES

  // ---------- JSON bodies as arguments ----------
  const echoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-echo-'))
  fs.mkdirSync(path.join(echoDir, 'wiki-plugin-echo', 'api'), { recursive: true })
  fs.writeFileSync(
    path.join(echoDir, 'wiki-plugin-echo', 'package.json'),
    JSON.stringify({ name: 'wiki-plugin-echo', fedwiki: { api: { version: 1, spec: 'api/openapi.json', handlers: 'api/handlers.js' } } }),
  )
  fs.writeFileSync(path.join(echoDir, 'wiki-plugin-echo', 'api', 'handlers.js'), 'module.exports = { echo: args => args }\n')
  fs.writeFileSync(
    path.join(echoDir, 'wiki-plugin-echo', 'api', 'openapi.json'),
    JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Echo', version: '1' },
      paths: {
        '/echo.json': {
          post: {
            operationId: 'echo',
            'x-fedwiki-read-only': false,
            'x-fedwiki-writes': true,
            parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }],
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['transcript'],
                    properties: {
                      transcript: { type: 'string' },
                      limit: { type: 'integer', default: 5 },
                      tags: { type: 'array' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    }),
  )
  routes.length = 0
  const echo = readDeclaration(echoDir, 'wiki-plugin-echo')
  await mountDeclaration({ app, declaration: echo, context })
  const long = 'word '.repeat(5000)
  r = await ask('POST', '/system/api/echo/echo.json?q=hi', { body: JSON.stringify({ transcript: long, tags: ['a', 'b'] }), type: 'application/json' })
  check('json body — 200', r.status === 200, JSON.stringify(r.json))
  check('json body — long field arrives', r.json && r.json.transcript === long)
  check('json body — default applied', r.json && r.json.limit === 5)
  check('json body — array kept', r.json && Array.isArray(r.json.tags) && r.json.tags.length === 2)
  check('json body — query still read', r.json && r.json.q === 'hi')
  r = await ask('POST', '/system/api/echo/echo.json', { body: JSON.stringify({}), type: 'application/json' })
  check('json body — required field missing, 400', r.status === 400)

  server.close()
  fs.rmSync(farmRoot, { recursive: true, force: true })
  fs.rmSync(echoDir, { recursive: true, force: true })

  if (problems.length) {
    console.log(`body:      FAILS — ${problems.length} wrong`)
    for (const p of problems) console.log(`  - ${p}`)
    process.exit(1)
  }
  console.log('body:      KEEPS bodies and assets — every question answered right')
}

main().catch(e => {
  console.error(e)
  server.close()
  process.exit(1)
})
