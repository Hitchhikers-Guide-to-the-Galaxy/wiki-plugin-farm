// mcp.js — the door an agent knocks on. CommonJS (see server/package.json).
//
// The merged document is legible to a viewer, and the rendered pages are
// legible to a reader. This is the third reading of the same declarations, for
// the reader that will actually call them.
//
// Nothing new is declared to build it. A tool, as an agent understands one, is
// a name, a description and a schema for what it takes — and every mounted
// operation already carries all three. So this is a translation, not a second
// interface: what an agent can call is what the routes offer, by construction,
// and a plugin that declares nothing extra gets a tool anyway.
//
// WRITTEN OUT RATHER THAN CARRIED. The official library is 4.3 MB across 17
// dependencies — zod, ajv, jose, a second HTTP framework and a second express —
// against a farm whose heaviest plugin is 3.3 MB and whose whole farm server is
// 68 KB. The methods actually needed are five, over JSON-RPC, and they fit in
// this file. That is the same judgement the plan made about bundling a viewer,
// in a worse place: a viewer is weight in one browser and declinable, while
// this would be weight in every farm, loaded whether or not anything used it.

/**
 * Versions this speaks. A client asking for one of these is answered in it; a
 * client asking for anything else is answered in the newest and decides for
 * itself whether to continue, which is what the protocol asks of a server.
 */
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26']

const JSONRPC = '2.0'
const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602
const INTERNAL_ERROR = -32603

const error = (id, code, message) => ({ jsonrpc: JSONRPC, id, error: { code, message } })
const result = (id, value) => ({ jsonrpc: JSONRPC, id, result: value })

/**
 * One operation's query parameters, as the object schema a tool takes.
 *
 * Context parameters are deliberately absent. `origin` is not something a
 * caller supplies — it is which site the question was put to — so offering it
 * as an argument would invite an agent to set it and be quietly ignored.
 */
const inputSchemaFor = operation => {
  const properties = {}
  const required = []
  for (const p of operation.parameters || []) {
    if (p.in !== 'query') continue
    const schema = { ...(p.schema || {}) }
    if (p.description) schema.description = p.description
    properties[p.name] = schema
    if (p.required) required.push(p.name)
  }
  const schema = { type: 'object', properties }
  if (required.length) schema.required = required
  return schema
}

/**
 * What an agent reads to decide whether this is the tool it wants.
 *
 * The whole basis of that decision, in fact — which makes a thin description a
 * tool that fails by never being chosen. So everything the operation knows about
 * itself goes in, including the one thing an agent cannot otherwise discover:
 * that the answer depends on which site it asked.
 */
const descriptionFor = operation => {
  const parts = []
  if (operation.summary) parts.push(operation.summary)
  if (operation.description && operation.description !== operation.summary) parts.push(operation.description)
  if ((operation['x-fedwiki-context'] || []).includes('origin')) {
    parts.push(
      'The answer depends on which site of the wiki farm this was asked at — the same call put to two sites ' +
        'has two different right answers. That is taken from the address you call, not from an argument.',
    )
  }
  return parts.join('\n\n')
}

/**
 * Every mounted operation, as a tool. Built from the merged document rather
 * than from the registry, so what an agent is offered and what the document
 * promises cannot drift — they are one list read twice.
 */
/**
 * Whether an operation may be offered to an agent at all.
 *
 * Exported because it has two users and must have one answer: the door inside
 * the farm and the assembler outside it. Two copies of this rule would drift,
 * and the direction they would drift in is offering something that cannot work.
 *
 * Two exclusions, for different reasons:
 *
 *   A WRITE is gated on whether the caller may edit the site, and a request
 *   arriving here carries no wiki session to judge — so the gate could only
 *   ever refuse it. A tool that cannot succeed is worse than no tool, because
 *   an agent spends its turn discovering that.
 *
 *   A route SERVED BY THE PLUGIN ITSELF is real, live and callable as a URL,
 *   but there is no handler here to invoke. It stays in the document and out of
 *   this list until the farm can forward a call to its own routes — a gap worth
 *   closing rather than a decision.
 */
const offerable = operation =>
  operation['x-fedwiki-writes'] !== true && operation['x-fedwiki-served-by'] !== 'plugin'

const toolsFrom = document => {
  const tools = []
  for (const [route, methods] of Object.entries(document.paths || {})) {
    for (const [method, operation] of Object.entries(methods)) {
      if (!offerable(operation)) continue
      tools.push({
        name: operation.operationId,
        description: descriptionFor(operation),
        inputSchema: inputSchemaFor(operation),
        // Not part of the protocol; useful to anything that wants to reach the
        // same operation over plain HTTP instead.
        _meta: { 'fedwiki/route': route, 'fedwiki/method': method.toUpperCase() },
      })
    }
  }
  return tools.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Tool name to the very same function the route calls.
 *
 * Not a reimplementation of the route: the identical `call`, so "does the tool
 * agree with the URL" is settled by construction rather than by hoping two code
 * paths stayed level with each other.
 */
const invokerFrom = registry => {
  const byName = new Map()
  for (const { declaration, mounted } of registry) {
    for (const entry of mounted || []) {
      byName.set(`${declaration.name}_${entry.operationId}`, entry)
    }
  }
  return byName
}

/**
 * Handle one JSON-RPC message. Returns the response, or null for a
 * notification, which by the protocol is answered with silence.
 */
const handleMessage = async (message, { document, registry, serverInfo }) => {
  const { id, method, params = {} } = message || {}
  const isNotification = id === undefined || id === null

  switch (method) {
    case 'initialize': {
      const asked = params.protocolVersion
      return result(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo,
        instructions:
          'Every interface this federated wiki farm offers, from the plugins installed on it. ' +
          'Tools are named plugin_operation and only ever read — nothing offered here changes a page. ' +
          'The farm may also mount operations that DO change pages; those are deliberately not offered ' +
          'as tools, because they are gated on the rights to edit the site and a request arriving here ' +
          'carries no session to judge. They are still described, along with the rule that governs them, ' +
          'at /system/api.json — where the same read operations are also available as ordinary URLs.',
      })
    }

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null

    case 'ping':
      return isNotification ? null : result(id, {})

    case 'tools/list':
      return result(id, { tools: toolsFrom(document) })

    case 'tools/call': {
      const entry = invokerFrom(registry).get(params.name)
      if (!entry) return error(id, INVALID_PARAMS, `no tool named ${params.name}`)
      try {
        const value = await entry.call(params.arguments || {})
        return result(id, {
          content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
          structuredContent: value,
        })
      } catch (e) {
        // A tool that fails is not a protocol failure. Reported inside the
        // result so the agent can read what went wrong and try again, rather
        // than as a transport error it can only give up on.
        return result(id, {
          content: [{ type: 'text', text: `${params.name} failed: ${e.message}` }],
          isError: true,
        })
      }
    }

    default:
      if (isNotification) return null
      return error(id, METHOD_NOT_FOUND, `unknown method ${method}`)
  }
}

/**
 * Refuse a browser that was sent here by a page on another origin.
 *
 * A local farm answers on a name any web page can reach, so without this a site
 * in another tab could put questions to it and read the answers. Everything here
 * only reads, but what it reads — the shape of the farm, what is installed, how
 * many pages each site holds — is nobody else's business. A request with no
 * Origin is not a browser and is left alone.
 */
const originAllowed = req => {
  const origin = req.get('origin')
  if (!origin) return true
  try {
    const host = new URL(origin).host
    return host === req.get('host') || /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)
  } catch {
    return false
  }
}

module.exports = { toolsFrom, offerable, invokerFrom, handleMessage, originAllowed, PROTOCOL_VERSIONS, JSONRPC, INTERNAL_ERROR, error }
