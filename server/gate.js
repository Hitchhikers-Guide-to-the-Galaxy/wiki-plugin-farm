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
  const host = String(origin || '').split(':')[0].toLowerCase()
  if (!host) return false
  return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')
}

/**
 * Whether this farm has been told, out loud, that writes to public sites are
 * wanted. Off unless set, and set by the person running the farm rather than by
 * anything a plugin declares — a plugin asking for its own writes to be exposed
 * publicly is exactly the request that should not be self-served.
 */
const publicWritesAllowed = () => /^(1|yes|true|on)$/i.test(process.env.FARM_API_PUBLIC_WRITES || '')

/**
 * Why this write may not happen — or null if it may.
 *
 * `isAuthorized` is the wiki's own test for "may this person edit this site",
 * the same one it applies before accepting any page change. Borrowing it rather
 * than inventing a second notion of rights means an operation mounted here can
 * never be a way around the wiki's own answer.
 */
const refuseWrite = ({ app, req, origin }) => {
  if (!isPrivateSite(origin) && !publicWritesAllowed()) {
    return {
      status: 403,
      error:
        `${origin} is not a private site, and this farm has not been asked to allow writes to public ones. ` +
        'Set FARM_API_PUBLIC_WRITES to turn that on, knowing that it opens page changes to anyone this farm ' +
        'considers authorised.',
    }
  }

  const security = app && app.securityhandler
  if (!security || typeof security.isAuthorized !== 'function') {
    // No security module means no way to tell who is asking, which is not the
    // same as everybody being allowed.
    return { status: 403, error: 'this farm has no security module, so it cannot tell who is asking' }
  }
  if (!security.isAuthorized(req)) {
    return {
      status: 403,
      error: `changing a page on ${origin} needs the rights to edit it — sign in to this wiki as its owner first`,
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
const describeGate = origin => ({
  rights: 'may edit this site, by the wiki\'s own test',
  publicSites: publicWritesAllowed() ? 'allowed — FARM_API_PUBLIC_WRITES is set' : 'refused unless FARM_API_PUBLIC_WRITES is set',
  here: origin ? (isPrivateSite(origin) ? 'private' : 'public') : undefined,
  offeredToAgents: false,
})

module.exports = { isPrivateSite, publicWritesAllowed, refuseWrite, describeGate }
