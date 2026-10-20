// gate.js — who may change something, and where. CommonJS (see server/package.json).
//
// Reading was safe to offer widely: every mounted read answers the same thing to
// anybody, and the farm's whole surface until now has been operations that look
// and do not touch. Writing is not like that, and the difference is not one of
// degree — a read that goes wrong wastes a request, a write that goes wrong
// changes somebody's page.
//
// Two questions, in this order:
//
//   1. Has this place been marked as refusing this write?
//   2. Is this caller allowed to write?
//
// The second is the wiki's own test, the one it applies to every page change,
// so a signed-in owner may do through this farm what they may already do by
// hand. Until 0.10.0 the first question was asked the other way round: a
// public site refused every write unless the operator listed it, which meant
// each new operation (Revise Plan's save, say) was refused to the very owner
// who could have made the same edit in the browser. David, 2026-10-20: "the
// default should be to allow revision and only if we mark it not allowed
// should it be prevented". So a public site now refuses only what
// FARM_API_PUBLIC_REFUSE names, and the owner test is never skipped there.

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
 * Which writes a public site refuses even to its signed-in owner.
 *
 * `FARM_API_PUBLIC_REFUSE` is `all` (or `1`, `yes`, `true`, `on`) to refuse
 * every write on a public site, or a comma list of scopes —
 * `<plugin>.<operationId>`, the names the api-key door uses — to refuse only
 * those. Unset, nothing is refused on the place and the wiki's owner test
 * decides. The old blanket off-switch, FARM_API_PUBLIC_WRITES=off (or 0, no,
 * false), still refuses everything.
 */
const ON = /^(1|yes|true|on|all)$/i
const OFF = /^(0|no|false|off)$/i
const publicWritesSetting = () => String(process.env.FARM_API_PUBLIC_WRITES || '').trim()
const publicRefuseSetting = () => String(process.env.FARM_API_PUBLIC_REFUSE || '').trim()
const publicRefuseScopes = () => {
  const setting = publicRefuseSetting()
  if (!setting || ON.test(setting) || OFF.test(setting)) return []
  return setting.split(',').map(s => s.trim()).filter(Boolean)
}
const publicWritesRefused = scope => {
  if (OFF.test(publicWritesSetting())) return true
  if (ON.test(publicRefuseSetting())) return true
  return Boolean(scope) && publicRefuseScopes().includes(scope)
}

/**
 * Who may spend this farm's keys and machine.
 *
 * Some operations cost the person running the farm: a model behind their API
 * key or subscription, a transcription on their hardware. They declare
 * `x-fedwiki-spends: true`. Whether a site's author may run them is the farm
 * owner's decision, made once for the whole farm — David, 2026-10-20: "for my
 * farm I am OK giving authors access to my keys - but for other farms the farm
 * owner may not be - this is a farm wide policy".
 *
 * `FARM_API_SPEND`:
 *   private  (the default) — only on private sites, i.e. the farm owner's own;
 *            a public site's author is refused.
 *   authors  — the owner of any site on this farm (signed in, by the wiki's own
 *            test) may spend.
 *   none     — nobody, private sites included (api keys aside).
 *
 * The default is the cautious one because this plugin is installed on farms
 * whose owners never read this comment: being wrong that way costs a refusal
 * the owner can lift; the other way, a bill.
 */
const spendPolicy = () => {
  const setting = String(process.env.FARM_API_SPEND || '').trim().toLowerCase()
  return ['authors', 'none'].includes(setting) ? setting : 'private'
}
const spendRefused = origin => {
  const policy = spendPolicy()
  if (policy === 'none') return true
  if (policy === 'authors') return false
  return !isPrivateSite(origin)
}

// FARM_API_PUBLIC_WRITES now only widens cross-origin answers (below): a
// switch, or a list of scopes a page from another origin may call on a public
// site. Before 0.10.0 it was also the list of writes a public site allowed.
const publicWritesAllowed = scope => {
  const setting = publicWritesSetting()
  if (ON.test(setting)) return true
  if (!scope || !setting) return false
  return setting.split(',').map(s => s.trim()).includes(scope)
}
const publicWriteScopes = () => {
  const setting = publicWritesSetting()
  if (!setting || ON.test(setting) || OFF.test(setting)) return []
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
const refuseWrite = ({ app, req, origin, status, scope, gate = 'rights', spends = false, privateOnly = false }) => {
  // An operation that acts on the farm's own machine rather than on a page —
  // its Keychain, its microphone, its restarts — declares
  // x-fedwiki-private-only and is refused on every public site, key or no key:
  // a public site's author is not the person whose machine it is.
  if (privateOnly && !isPrivateSite(origin)) {
    return {
      status: 403,
      error: `${scope || 'this operation'} acts on the farm's own machine and is offered only on private sites; ${origin} is public.`,
    }
  }

  // A key held for this site answers both questions at once, and deliberately.
  // The place-check exists because a plugin should not be able to expose its own
  // writes publicly — but a key is not self-served: it is a secret the site
  // owner wrote by hand into a directory the web cannot read. That is the
  // out-loud authorisation the first refusal is asking for, stated per caller
  // rather than per farm. A site with no key file is unaffected.
  if (keys.authorize({ status, req, scope })) return null

  if (!isPrivateSite(origin) && publicWritesRefused(scope)) {
    return {
      status: 403,
      error:
        `${origin} is a public site and this farm is marked to refuse ${scope || 'this operation'} there ` +
        '(FARM_API_PUBLIC_REFUSE, or FARM_API_PUBLIC_WRITES=off). Lift that mark, ' +
        'or give the caller an API key in this site\'s status/api-keys.json.',
    }
  }

  if (spends && spendRefused(origin)) {
    return {
      status: 403,
      error:
        `${scope || 'this operation'} spends this farm's keys or machine (a model, a transcription), and this farm ` +
        (spendPolicy() === 'none'
          ? 'lets nobody spend them (FARM_API_SPEND=none). '
          : `keeps that to its private sites, which ${origin} is not. The farm owner can let site authors spend them with FARM_API_SPEND=authors. `) +
        'An API key in this site\'s status/api-keys.json also opens it.',
    }
  }

  // A place-gated operation skips the who-check only where the place itself is
  // private. On a public site the caller must be someone the wiki lets edit
  // the site — otherwise anyone on the internet could spend
  // this farm's transcription (measured 2026-10-15: an anonymous post ran a
  // whisper job on the public farm). The laptop door is a private site, so a
  // page from elsewhere still gets heard there without a login.
  if (gate === 'place' && isPrivateSite(origin)) return null

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
const describeGate = (origin, status, gate = 'rights', spends = false, privateOnly = false) => ({
  asks:
    gate === 'place'
      ? 'the place only on a private site — any caller; on a public site, the caller too'
      : 'the caller (and, on a public site, whether the farm marks this operation refused)',
  rights:
    gate === 'place'
      ? 'not asked on a private site — this operation changes no page; on a public site, may edit this site, by the wiki\'s own test'
      : 'may edit this site, by the wiki\'s own test',
  apiKey:
    status === undefined
      ? 'an X-Api-Key listed in the site\'s status/api-keys.json is accepted where one is configured'
      : keys.offered(status)
        ? 'accepted — an X-Api-Key listed in this site\'s status/api-keys.json may write without signing in'
        : 'not offered here — this site has no status/api-keys.json',
  publicSites: publicWritesRefused()
    ? 'refused — FARM_API_PUBLIC_REFUSE (or FARM_API_PUBLIC_WRITES=off) marks every write'
    : publicRefuseScopes().length
      ? `allowed to the site owner, except ${publicRefuseScopes().join(', ')} — FARM_API_PUBLIC_REFUSE lists them`
      : 'allowed to the site owner, by the wiki\'s own test',
  privateOnly: privateOnly ? 'refused on every public site — this operation acts on the farm\'s own machine' : undefined,
  spends: spends
    ? {
        policy: spendPolicy(),
        means:
          spendPolicy() === 'authors'
            ? 'the owner of any site on this farm may run it (FARM_API_SPEND=authors)'
            : spendPolicy() === 'none'
              ? 'nobody may run it (FARM_API_SPEND=none), api keys aside'
              : 'only on this farm\'s private sites (FARM_API_SPEND unset or private)',
      }
    : undefined,
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

module.exports = { crossOriginAllowed, allowOrigin, isPrivateSite, privateSuffixes, publicWritesAllowed, publicWriteScopes, publicWritesRefused, publicRefuseScopes, spendPolicy, spendRefused, refuseWrite, describeGate, keys }
