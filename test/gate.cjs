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
check('place gate on a public site still asks who (no security module → refused)', refused('https://fedwiki.club', { gate: 'place' })?.status === 403)
const signedOut = { app: { securityhandler: { isAuthorized: () => false } } }
const signedIn = { app: { securityhandler: { isAuthorized: () => true } } }
check('place gate on a public site refuses a caller without rights', /needs the rights/.test(refused('https://fedwiki.club', { gate: 'place', ...signedOut })?.error || ''))
check('place gate on a public site passes the site owner', refused('https://fedwiki.club', { gate: 'place', ...signedIn }) === null)
check('rights gate on a public site passes the site owner with no setting', refused('https://fedwiki.club', signedIn) === null)
check('rights gate on a public site refuses a caller without rights', /needs the rights/.test(refused('https://fedwiki.club', signedOut)?.error || ''))
check('place gate on a private site asks nobody', refused('http://localhost:4242', { gate: 'place', ...signedOut }) === null)
process.env.FARM_API_PUBLIC_REFUSE = 'audionote.hear'
check('a public site marked to refuse the scope refuses its owner', /marked to refuse audionote\.hear/.test(refused('https://fedwiki.club', signedIn)?.error || ''))
check('the mark names one scope only', refused('https://fedwiki.club', { ...signedIn, scope: 'plan.saveRevision' }) === null)
check('the mark leaves a private site alone', refused('http://localhost:4242', { gate: 'place' }) === null)
process.env.FARM_API_PUBLIC_REFUSE = 'all'
check('all refuses every scope on a public site', refused('https://fedwiki.club', { ...signedIn, scope: 'plan.saveRevision' })?.status === 403)
delete process.env.FARM_API_PUBLIC_REFUSE
process.env.FARM_API_PUBLIC_WRITES = 'off'
check('FARM_API_PUBLIC_WRITES=off still refuses on a public site', refused('https://fedwiki.club', signedIn)?.status === 403)
process.env.FARM_API_PUBLIC_WRITES = 'audionote.hear'
check('a FARM_API_PUBLIC_WRITES list no longer restricts other scopes', refused('https://fedwiki.club', { ...signedIn, scope: 'plan.saveRevision' }) === null)
check('but still widens cross-origin for the scopes it lists', gate.crossOriginAllowed('https://fedwiki.club', 'audionote.hear') === true)
delete process.env.FARM_API_PUBLIC_WRITES

// The farm-wide spend policy: operations that use the farm's keys or machine.
const spend = { ...signedIn, scope: 'plan.revise', spends: true }
delete process.env.FARM_API_SPEND
check('spend, default policy: a public site\'s owner is refused', /FARM_API_SPEND=authors/.test(refused('https://arena.solidarity.quest', spend)?.error || ''))
process.env.FARM_API_PRIVATE_SUFFIXES = '.private.fish'
check('spend, default policy: a private-suffix site\'s owner may', refused('https://dns.private.fish', spend) === null)
delete process.env.FARM_API_PRIVATE_SUFFIXES
check('spend, default policy: a localhost owner may', refused('http://demo.localhost', spend) === null)
check('no spend: the public owner may still save a page', refused('https://arena.solidarity.quest', { ...spend, spends: false }) === null)
process.env.FARM_API_SPEND = 'authors'
check('spend, authors: a public site\'s owner may', refused('https://arena.solidarity.quest', spend) === null)
check('spend, authors: still asks who', /needs the rights/.test(refused('https://arena.solidarity.quest', { ...spend, ...signedOut })?.error || ''))
check('spend, authors: a public mark still refuses', (process.env.FARM_API_PUBLIC_REFUSE = 'plan.revise', refused('https://arena.solidarity.quest', spend)?.status === 403))
delete process.env.FARM_API_PUBLIC_REFUSE
process.env.FARM_API_SPEND = 'none'
check('spend, none: even localhost is refused', /FARM_API_SPEND=none/.test(refused('http://demo.localhost', spend)?.error || ''))
process.env.FARM_API_SPEND = 'nonsense'
check('spend, unknown value reads as private', gate.spendPolicy() === 'private')
delete process.env.FARM_API_SPEND
const ds = gate.describeGate('https://arena.solidarity.quest', undefined, 'rights', true)
check('described: spends + policy', ds.spends && ds.spends.policy === 'private')

// Private-only: the farm machine's own operations.
check('private-only refuses a public site\'s owner', /only on private sites/.test(refused('https://arena.solidarity.quest', { ...signedIn, scope: 'keychain.reveal', privateOnly: true })?.error || ''))
check('private-only passes a localhost owner', refused('http://wiki.localhost', { ...signedIn, scope: 'keychain.reveal', privateOnly: true }) === null)

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
