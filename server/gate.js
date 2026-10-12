// gate.js — who may change something, and where. CommonJS (see server/package.json).
//
// Reading was safe to offer widely: every mounted read answers the same thing to
// anybody, and the farm's whole surface until now has been operations that look
// and do not touch. Writing is not like that, and the difference is not one of
// degree — a read that goes wrong wastes a request, a write that goes wrong
// changes somebody's page.
//
// Two refusals, in this order, because the order is itself the answer to a
// question a caller would otherwise ask wrongly:
//
//   1. Is this farm willing to be written to at all, here?
//   2. Is this caller allowed to write?
//
// Asking them the other way round would tell an unauthenticated caller to sign
// in, on a site where signing in would not have helped either. Refusing on the
// place first is both more honest and less of an invitation.

/**
 * A site nobody outside this machine can reach.
 *
 * Deliberately a small allow-list rather than a guess. Everything that is not
 * recognisably local is treated as public, so a farm this plugin has never seen
 * — a public host, a mirror, a container with a real domain — is refused by
 * default rather than opened by default. Being wrong in that direction costs a
 * refusal somebody can lift; being wrong in the other costs a public edit.
 */
const isPrivateSite = origin => {
  // A bare host, a host:port, or a full origin with its scheme — the document
  // route hands over the last of these, and splitting it on the first colon
  // used to read the scheme as the host, so every site described as public.
  const host = String(origin || '').replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('/')[0].split(':')[0].toLowerCase()
  if (!host) return false
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  return privateSuffixes().some(suffix => host === suffix || host.endsWith(`.${suffix}`))
}

/**
 * Further private names, told to this farm by the person running it — for a
 * farm whose boundary is enforced somewhere this plugin cannot see, such as a
 * reverse proxy that answers only the tailnet. `FARM_API_PRIVATE_SUFFIXES` is a
 * comma list (`.private.fish,lan`); a leading dot is optional. Like the public
 * switch below, it is the operator's to set and never a plugin's.
 */
const privateSuffixes = () =>
  String(process.env.FARM_API_PRIVATE_SUFFIXES || '')
    .split(',')
    .map(s => s.trim().toLowerCase().replace(/^\.+/, ''))
    .filter(Boolean)

/**
 * Whether this farm has been told, out loud, that writes to public sites are
 * wanted. Off unless set, and set by the person running the farm rather than by
 * anything a plugin declares — a plugin asking for its own writes to be exposed
 * publicly is exactly the request that should not be self-served.
 */
//
// Either a switch (`1`, `yes`, `true`, `on`) that opens every write, or a comma
// list of scopes — `<plugin>.<operationId>`, the same names the api-key door
// uses — that opens only those. The list is what lets a public farm take audio
// from its site owners without also opening every page-changing operation.
const publicWritesSetting = () => String(process.env.FARM_API_PUBLIC_WRITES || '').trim()
const publicWritesAllowed = scope => {
  const setting = publicWritesSetting()
  if (/^(1|yes|true|on)$/i.test(setting)) return true
  if (!scope || !setting) return false
  return setting.split(',').map(s => s.trim()).includes(scope)
}
const publicWriteScopes = () => {
  const setting = publicWritesSetting()
  if (!setting || /^(1|yes|true|on|0|no|false|off)$/i.test(setting)) return []
  return setting.split(',').map(s => s.trim()).filter(Boolean)
}

const keys = require('./keys.js')

/**
 * Why this write may not happen — or null if it may.
 *
 * `isAuthorized` is the wiki's own test for "may this person edit this site",
 * the same one it applies before accepting any page change. Borrowing it rather
 * than inventing a second notion of rights means an operation mounted here can
 * never be a way around the wiki's own answer.
 */
//
// `gate` is how much the operation asks: 'rights' (the default) asks both
// questions; 'place' asks only the first. An operation may declare 'place'
// when it changes no page and keeps nothing — the Voice Tool's hear, which
// transcribes a recording and deletes it — so that a private farm will do that
// for any caller: in particular a browser on the laptop the farm runs on,
// reading a page served from elsewhere. The place-check still stands, so a
// public farm refuses it exactly as before.
const refuseWrite = ({ app, req, origin, status, scope, gate = 'rights' }) => {
  // A key held for this site answers both questions at once, and deliberately.
  // The place-check exists because a plugin should not be able to expose its own
  // writes publicly — but a key is not self-served: it is a secret the site
  // owner wrote by hand into a directory the web cannot read. That is the
  // out-loud authorisation the first refusal is asking for, stated per caller
  // rather than per farm. A site with no key file is unaffected.
  if (keys.authorize({ status, req, scope })) return null

  if (!isPrivateSite(origin) && !publicWritesAllowed(scope)) {
    return {
      status: 403,
      error:
        `${origin} is not a private site, and this farm has not been asked to allow writes to public ones. ` +
        `Set FARM_API_PUBLIC_WRITES to turn that on (or list ${scope || 'the operation'} in it), knowing that it opens page changes to anyone this farm ` +
        'considers authorised — or give the caller an API key in this site\'s status/api-keys.json.',
    }
  }

  if (gate === 'place') return null

  const security = app && app.securityhandler
  if (!security || typeof security.isAuthorized !== 'function') {
    // No security module means no way to tell who is asking, which is not the
    // same as everybody being allowed.
    return { status: 403, error: 'this farm has no security module, so it cannot tell who is asking' }
  }
  if (!security.isAuthorized(req)) {
    return {
      status: 403,
      error:
        `changing a page on ${origin} needs the rights to edit it — sign in to this wiki as its owner, ` +
        'or present an X-Api-Key listed in its status/api-keys.json',
    }
  }
  return null
}

/**
 * How an operation is gated, for the document.
 *
 * Published so that a reader is told the rule before being refused by it, and
 * so an agent can see that a tool it is not offered exists and why.
 */
const describeGate = (origin, status, gate = 'rights') => ({
  asks: gate === 'place' ? 'the place only — any caller, where the site is private or public writes are allowed' : 'the place, then the caller',
  rights: gate === 'place' ? 'not asked — this operation changes no page' : 'may edit this site, by the wiki\'s own test',
  apiKey:
    status === undefined
      ? 'an X-Api-Key listed in the site\'s status/api-keys.json is accepted where one is configured'
      : keys.offered(status)
        ? 'accepted — an X-Api-Key listed in this site\'s status/api-keys.json may write without signing in'
        : 'not offered here — this site has no status/api-keys.json',
  publicSites: publicWritesAllowed()
    ? 'allowed — FARM_API_PUBLIC_WRITES is set'
    : publicWriteScopes().length
      ? `allowed only for ${publicWriteScopes().join(', ')} — FARM_API_PUBLIC_WRITES lists them`
      : 'refused unless FARM_API_PUBLIC_WRITES is set',
  here: origin ? (isPrivateSite(origin) ? 'private' : 'public') : undefined,
  offeredToAgents: false,
})

/**
 * Whether an operation that declares x-fedwiki-cross-origin may be answered to
 * a page from another origin: only where the site is private (or public writes
 * are allowed for it), so a public farm's reads are not handed to every page a
 * visitor opens. The headers echo the asking origin and never allow credentials
 * — the place gate, not a cookie, is what lets the call through.
 */
const crossOriginAllowed = (origin, scope) => isPrivateSite(origin) || publicWritesAllowed(scope)
const CORS_HEADERS = {
  'Access-Control-Allow-Headers': 'Accept, Content-Type, X-Recording-Type, X-Api-Key',
  'Access-Control-Max-Age': '600',
}
const allowOrigin = (req, res, method) => {
  const asking = req.get && req.get('origin')
  if (!asking) return
  res.header('Access-Control-Allow-Origin', asking)
  res.header('Vary', 'Origin')
  res.header('Access-Control-Allow-Methods', `${String(method || 'get').toUpperCase()}, OPTIONS`)
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.header(k, v)
}

module.exports = { crossOriginAllowed, allowOrigin, isPrivateSite, privateSuffixes, publicWritesAllowed, publicWriteScopes, refuseWrite, describeGate, keys }
