// keys.js — the API-key door, for callers the wiki's own sign-in cannot reach.
//
// The farm's write gate asks the wiki "may this person edit this site", and the
// wiki answers from a session cookie. A script, a cron job or an agent on
// another machine has no cookie and never will, so before this file every
// plugin that wanted headless writes grew its own key check — table and
// shortlink both did, identically. That is a shared concern, and this is where
// it belongs.
//
// A site opts in by writing a key file into its own status directory, which is
// not served over HTTP. No file means no keys and no change in behaviour: this
// door does not exist until somebody deliberately builds it.
//
//   {status}/api-keys.json
//   {
//     "*":            { "<secret>": { "id": "marvin", "note": "the radio bot" } },
//     "table.write":  { "<secret>": { "id": "ci",     "note": "nightly import" } }
//   }
//
// Scopes are "*" (any write on this site) or "<plugin>.<operation>". A key
// listed under a scope may perform that operation and nothing else.

const fs = require('node:fs')
const path = require('node:path')

const cache = new Map() // statusDir -> { mtimeMs, keys }

/** Read the site's key file, cached by mtime so an edit needs no restart. */
const load = statusDir => {
  if (!statusDir) return null
  const file = path.join(statusDir, 'api-keys.json')
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    cache.delete(statusDir)
    return null
  }
  const hit = cache.get(statusDir)
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit.keys
  let keys = null
  try {
    keys = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    console.log(`caution: ${file}: ${e.message}`)
    keys = null
  }
  cache.set(statusDir, { mtimeMs: stat.mtimeMs, keys })
  return keys
}

/** Constant-time-ish compare, so a wrong key cannot be found a character at a time. */
const same = (a, b) => {
  const x = String(a || '')
  const y = String(b || '')
  if (x.length !== y.length) return false
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i)
  return diff === 0
}

const findIn = (bucket, presented) => {
  if (!bucket || typeof bucket !== 'object') return null
  for (const [secret, holder] of Object.entries(bucket)) {
    if (same(secret, presented)) return holder && typeof holder === 'object' ? holder : { id: 'unnamed' }
  }
  return null
}

/**
 * Who is asking, if they hold a key good for this operation — or null.
 *
 * `scope` is `<plugin>.<operation>`; a key under "*" is good for any write on
 * the site. Returns the holder record so a caller can attribute the change.
 */
const authorize = ({ status, req, scope } = {}) => {
  const presented = req && req.headers && req.headers['x-api-key']
  if (!presented) return null
  const keys = load(status)
  if (!keys) return null
  return (scope ? findIn(keys[scope], presented) : null) || findIn(keys['*'], presented)
}

/** Whether this site has opted in at all — for the published description. */
const offered = status => !!load(status)

module.exports = { authorize, offered, load }
