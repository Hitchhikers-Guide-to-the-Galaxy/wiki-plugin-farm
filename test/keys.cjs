#!/usr/bin/env node
// keys.cjs — does the API-key door open for the right caller and nobody else?
//
//   node test/keys.cjs
//
// No farm, no network. A temporary status directory stands in for a site's,
// and the door is asked the questions a caller would ask it: with no file,
// with a wrong key, with the right key for the wrong scope, with the star,
// and after the file is edited under a running process.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const keys = require('../server/keys.js')
const gate = require('../server/gate.js')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-keys-'))
const status = path.join(tmp, 'status')
fs.mkdirSync(status)
const file = path.join(status, 'api-keys.json')

const req = key => ({ headers: key ? { 'x-api-key': key } : {} })
const ask = (key, scope) => keys.authorize({ status, req: req(key), scope })

const problems = []
const check = (name, ok) => {
  if (!ok) problems.push(name)
}

// No file: the door does not exist.
check('no file — refused', ask('anything', 'table.write') === null)
check('no file — not offered', keys.offered(status) === false)

fs.writeFileSync(
  file,
  JSON.stringify({
    '*': { 'star-secret': { id: 'marvin', note: 'the radio bot' } },
    'table.write': { 'table-secret': { id: 'ci' } },
  }),
)
check('file — offered', keys.offered(status) === true)
check('no header — refused', ask(undefined, 'table.write') === null)
check('wrong key — refused', ask('nope', 'table.write') === null)
check('right key, right scope — holder named', (ask('table-secret', 'table.write') || {}).id === 'ci')
check('right key, wrong scope — refused', ask('table-secret', 'shortlink.mint') === null)
check('star — any scope', (ask('star-secret', 'anything.at.all') || {}).id === 'marvin')
check('star — no scope asked', (ask('star-secret', undefined) || {}).id === 'marvin')
check('scoped key — no scope asked, refused', ask('table-secret', undefined) === null)
check('prefix of a key — refused', ask('table-secre', 'table.write') === null)

// Edited under a running process: the cache is by mtime, so no restart.
fs.writeFileSync(file, JSON.stringify({ 'table.write': { 'later-secret': { id: 'later' } } }))
const bumped = new Date(Date.now() + 5000)
fs.utimesSync(file, bumped, bumped)
check('edited file — old key gone', ask('table-secret', 'table.write') === null)
check('edited file — new key works', (ask('later-secret', 'table.write') || {}).id === 'later')

// Broken file: the door closes rather than opening wide.
fs.writeFileSync(file, '{ not json')
fs.utimesSync(file, new Date(Date.now() + 10000), new Date(Date.now() + 10000))
check('broken file — refused', ask('later-secret', 'table.write') === null)

// The gate: a key answers both refusals, place and person, on a public site.
fs.writeFileSync(file, JSON.stringify({ '*': { 'star-secret': { id: 'marvin' } }, 'table.write': { 'table-secret': { id: 'ci' } } }))
fs.utimesSync(file, new Date(Date.now() + 15000), new Date(Date.now() + 15000))
delete process.env.FARM_API_PUBLIC_WRITES
const app = { securityhandler: { isAuthorized: () => false } }
const refuse = (key, scope, origin = 'fm.ide.earth') =>
  gate.refuseWrite({ app, req: req(key), origin, status, scope })
check('gate — public site, no key: refused 403', (refuse(undefined, 'table.write') || {}).status === 403)
check('gate — public site, star key: allowed', refuse('star-secret', 'table.write') === null)
check('gate — public site, scoped key: allowed', refuse('table-secret', 'table.write') === null)
check('gate — public site, wrong scope: refused', (refuse('table-secret', 'shortlink.mint') || {}).status === 403)
check('gate — refusal names the key file', /api-keys\.json/.test((refuse(undefined, 'table.write') || {}).error))
check('describe — accepted here', /^accepted/.test(gate.describeGate('fm.ide.earth', status).apiKey))
check('describe — not offered elsewhere', /^not offered/.test(gate.describeGate('x.localhost', path.join(tmp, 'none')).apiKey))
check('describe — undefined status stays general', /where one is configured/.test(gate.describeGate('x.localhost').apiKey))

fs.rmSync(tmp, { recursive: true, force: true })

console.log(`keys:      ${problems.length ? 'BREAKS' : 'KEEPS'} the door — ${26 - problems.length} of 26 questions answered right`)
if (problems.length) {
  console.log('\nWRONG ANSWERS:')
  for (const p of problems) console.log('  ' + p)
  process.exitCode = 1
}
