// context.js — what the farm can tell a handler about where it was asked.
//
// Some answers genuinely depend on the site the question arrived at: put to two
// sites of one farm, the same operation has two different right answers. That is
// an input, and it should behave like one — declared in the specification,
// supplied by the farm, never reached for by the handler.
//
// The names are a closed set on purpose. An operation asking for something not
// listed here is refused at mount time rather than answered wrongly, and the
// list is exported separately from the values so a generator with no running
// server can still tell what WOULD mount. Without that split the rendered pages
// would quietly describe a smaller farm than the routes actually make.

const fs = require('node:fs')
const path = require('node:path')

/** Every context name this farm knows how to supply. */
const KNOWN_CONTEXT = ['origin', 'farmRoot', 'status', 'url', 'port']

/**
 * What each context name means, and — the part that matters to anything building
 * on this — whether a caller can choose it.
 *
 * Only `origin` is addressable, and it is chosen by picking which host to send
 * the request to rather than by passing an argument. Saying so in the document
 * is what lets a reader act on it: without this, "the answer depends on where
 * you asked" is prose a person can follow and a program cannot.
 */
const CONTEXT_MEANING = {
  origin: {
    description:
      'The site this question was put to. The same operation asked at two sites of one farm has two ' +
      'different right answers.',
    addressable: true,
    chosenBy: 'the host you send the request to, not an argument you pass',
  },
  farmRoot: {
    description: 'Where this farm keeps its sites on disk.',
    addressable: false,
    chosenBy: 'the farm — it is a filesystem path and is never taken from a caller',
  },
  status: {
    description: "The origin site's status directory.",
    addressable: false,
    chosenBy: 'the farm',
  },
  url: {
    description: 'The base address the origin site was started with.',
    addressable: false,
    chosenBy: 'the farm',
  },
  port: {
    description:
      "The TCP port this farm's server listens on. For a handler calling back into " +
      'its own farm: site names resolve for browsers, not for this process — ' +
      '127.0.0.1 and this port is the only address that is always true here.',
    addressable: false,
    chosenBy: 'the farm',
  },
}

/**
 * The sites of this farm — every directory holding pages.
 *
 * The same test `wiki-plugin-hitchhiker` uses for `/system/farm-domains.json`,
 * deliberately: two enumerations of one farm that disagreed would be worse than
 * either. Unlike the family plugin's `kinds=farm`, this INCLUDES the site you
 * asked at — that one is building a neighbourhood, which by definition is the
 * others, while this is a list of what exists.
 */
const sitesOf = farmRoot => {
  if (!farmRoot) return []
  try {
    return fs
      .readdirSync(farmRoot, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .filter(e => fs.existsSync(path.join(farmRoot, e.name, 'pages')))
      .map(e => e.name)
      .sort()
  } catch {
    return []
  }
}

/**
 * A stable name for this farm — its root domain, being the site fewest labels
 * deep. Needed only by something merging two farms, which otherwise finds every
 * farm calling itself the same thing.
 */
const farmIdentity = farmRoot => {
  const sites = sitesOf(farmRoot)
  if (!sites.length) return farmRoot ? path.basename(farmRoot) : ''
  return sites.slice().sort((a, b) => a.split('.').length - b.split('.').length || a.length - b.length)[0]
}

/**
 * Build the context for one site from the argv its server was started with.
 *
 * Derived from `argv.status` rather than `argv.data`, because a site may set
 * status elsewhere and a plugin migrating its own route must keep answering
 * identically. Byte-identity beats tidiness here.
 */
const contextFor = argv => {
  if (!argv || !argv.status) return {}
  return {
    origin: path.basename(path.dirname(argv.status)), // e.g. plan.localhost
    farmRoot: path.dirname(path.dirname(argv.status)),
    status: argv.status,
    url: argv.url,
    port: argv.port,
  }
}

/** Names an operation asks for that this farm cannot supply. */
const unmetContext = operation =>
  (operation['x-fedwiki-context'] || []).filter(name => !KNOWN_CONTEXT.includes(name))

/**
 * The context vocabulary, with the site list filled in where it applies.
 *
 * Published in the document so that "this answer depends on where you stand"
 * stops being something only a person can act on. A reader that finds
 * `addressable: true` and a list of values knows it may offer the choice; one
 * that finds `addressable: false` knows not to.
 */
const contextVocabulary = farmRoot => {
  const sites = sitesOf(farmRoot)
  const out = {}
  for (const name of KNOWN_CONTEXT) {
    out[name] = { ...CONTEXT_MEANING[name] }
    if (name === 'origin' && sites.length) out[name].values = sites
  }
  return out
}

module.exports = {
  KNOWN_CONTEXT,
  CONTEXT_MEANING,
  contextFor,
  unmetContext,
  sitesOf,
  farmIdentity,
  contextVocabulary,
}
