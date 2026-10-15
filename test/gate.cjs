#!/usr/bin/env node
// gate.cjs — the place gate: an operation that asks only where, not who.
//
//   node test/gate.cjs

const gate = require('../server/gate.js')

const problems = []
const check = (name, ok, detail = '') => ok || problems.push(detail ? `${name} — ${detail}` : name)

const noSecurity = { app: {}, req: { headers: {}, get: () => undefined }, status: null, scope: 'audionote.hear' }
const refused = (origin, extra = {}) => gate.refuseWrite({ ...noSecurity, origin, ...extra })

check('rights gate on a private site still asks who (no security module → refused)', refused('http://localhost:4242')?.status === 403)
check('place gate on a private site asks nobody', refused('http://localhost:4242', { gate: 'place' }) === null)
check('place gate on a .local name', refused('http://pi5.local', { gate: 'place' }) === null)
check('place gate on a public site is refused on the place', /not a private site/.test(refused('https://fedwiki.club', { gate: 'place' })?.error || ''))
process.env.FARM_API_PUBLIC_WRITES = 'audionote.hear'
check('place gate on a public site listed in FARM_API_PUBLIC_WRITES still asks who (no security module → refused)', refused('https://fedwiki.club', { gate: 'place' })?.status === 403)
const signedOut = { app: { securityhandler: { isAuthorized: () => false } } }
const signedIn = { app: { securityhandler: { isAuthorized: () => true } } }
check('place gate on a listed public site refuses a caller without rights', /needs the rights/.test(refused('https://fedwiki.club', { gate: 'place', ...signedOut })?.error || ''))
check('place gate on a listed public site passes the site owner', refused('https://fedwiki.club', { gate: 'place', ...signedIn }) === null)
check('place gate on a private site still asks nobody while public writes are listed', refused('http://localhost:4242', { gate: 'place', ...signedOut }) === null)
check('rights gate on that site still asks who', refused('https://fedwiki.club')?.status === 403)
delete process.env.FARM_API_PUBLIC_WRITES

check('cross-origin allowed on a private site', gate.crossOriginAllowed('http://localhost:4242', 'audionote.hear') === true)
check('cross-origin refused on a public site', gate.crossOriginAllowed('https://fedwiki.club', 'audionote.hear') === false)

const headers = {}
const res = { header: (k, v) => (headers[k] = v) }
gate.allowOrigin({ get: h => (h === 'origin' ? 'https://dns.private.fish' : undefined) }, res, 'post')
check('echoes the asking origin', headers['Access-Control-Allow-Origin'] === 'https://dns.private.fish')
check('varies on origin', headers.Vary === 'Origin')
check('allows the method and OPTIONS', headers['Access-Control-Allow-Methods'] === 'POST, OPTIONS')
check('allows the recording-type header', /X-Recording-Type/.test(headers['Access-Control-Allow-Headers']))
check('never allows credentials', !('Access-Control-Allow-Credentials' in headers))
const none = {}
gate.allowOrigin({ get: () => undefined }, { header: (k, v) => (none[k] = v) }, 'post')
check('no origin header, no CORS headers', Object.keys(none).length === 0)

const d = gate.describeGate('http://localhost:4242', undefined, 'place')
check('described as place-only', /place only/.test(d.asks) && /not asked/.test(d.rights))
const dp = gate.describeGate('https://fedwiki.club', undefined, 'place')
check('described as asking the caller too on a public site', /the caller too/.test(dp.asks) && /may edit/.test(dp.rights))

if (problems.length) {
  console.error('gate: FAILED\n  ' + problems.join('\n  '))
  process.exit(1)
}
console.log('gate: ok')
