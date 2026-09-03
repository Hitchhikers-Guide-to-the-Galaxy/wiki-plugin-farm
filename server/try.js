// try.js — calling an operation from the page that describes it. CommonJS.
//
// The reference page says what an operation takes. This lets you hand it
// something and see what comes back, without leaving the wiki and without the
// page storing anything: the form posts, the farm calls the operation, and the
// answer comes back as page JSON that the client puts in the lineup. A ghost
// page — real enough to read, fork and annotate, never written to disk.
//
// Everything here is truth: which operation was meant, whether it is mounted,
// whether the gate allows it, what arguments crossed, what came back. How the
// answer LOOKS is the render contract's business — the caller passes in the
// renders that resolution chose, and this hands them what happened.
//
// ALWAYS ANSWERS 200. Not laziness: `wiki-plugin-html` submits with
// `$.ajax(req).done(show)` and registers no `.fail` handler, so any status
// outside 2xx is dropped on the floor and the reader sees the button do
// nothing. A failure has to arrive as a page saying what went wrong, or it does
// not arrive at all.

const { refuseWrite } = require('./gate.js')

/** Every operation in a document, by the name the form will send. */
const operationsOf = document => {
  const out = new Map()
  for (const [route, methods] of Object.entries(document.paths || {})) {
    for (const [method, operation] of Object.entries(methods)) {
      out.set(operation.operationId, { route, method, operation })
    }
  }
  return out
}

/**
 * Call one operation and render what happened.
 *
 * `registry` is the farm's own, so the call made here is the call the route
 * makes and the call an agent makes — the same closure, not a third path
 * through the same idea.
 */
const tryOperation = async ({ document, registry, params = {}, origin, site, status, app, req, renders }) => {
  const wanted = String(params.operation || '').trim()
  const operations = operationsOf(document)

  if (!wanted) {
    return renders.renderProblem({
      title: 'Nothing to try',
      why: 'The form did not say which operation to call.',
      hint: 'This usually means the form lost its hidden `operation` field while being edited.',
    })
  }

  const found = operations.get(wanted)
  if (!found) {
    const offered = [...operations.keys()]
    return renders.renderProblem({
      title: 'No such operation',
      why: `This farm has no operation called \`${wanted}\`.`,
      hint: offered.length
        ? `It offers ${offered.map(o => `\`${o}\``).join(', ')}. An operation that a plugin declares but the farm did not mount will not appear here — see the farm's own description at \`/system/api.json\` for why.`
        : 'This farm mounts no operations at all.',
    })
  }

  // Find the callable behind it, the same way the agent door does.
  const { route, operation } = found
  const base = operation['x-fedwiki-base'] || ''
  const shortName = base.split('/').filter(Boolean).pop() || ''
  const bare = wanted.startsWith(`${shortName}_`) ? wanted.slice(shortName.length + 1) : wanted
  const entry = (registry.find(r => r.declaration.name === shortName) || { mounted: [] }).mounted.find(
    m => m.operationId === bare,
  )

  if (!entry) {
    return renders.renderProblem({
      title: 'Not mounted here',
      why: `\`${wanted}\` is described by this farm but is not mounted, so it cannot be called.`,
      hint: "See the farm's own description at `/system/api.json`, which records why each one was left out.",
    })
  }

  // A form is a door like any other, and the gate lives at every door. The
  // handler behind this is a plain function that cannot see who pressed the
  // button, so the question has to be asked here — and answered as a page,
  // because a refusal the reader never sees is the same to them as a button
  // that does nothing.
  if (entry.writes) {
    const refusal = refuseWrite({ app, req, origin: site, status, scope: `${shortName}.${entry.operationId}` })
    if (refusal) {
      return renders.renderProblem({
        title: 'Not allowed to change that',
        why: refusal.error,
        hint:
          'This operation changes a page, so it is gated. Reading is offered freely; writing asks who you ' +
          'are, and where.',
      })
    }
  }

  // Only what the operation actually declares, so a stray form field cannot
  // become an argument.
  const values = {}
  for (const p of operation.parameters || []) {
    if (p.in !== 'query') continue
    const raw = params[p.name]
    if (raw !== undefined && String(raw).trim() !== '') values[p.name] = raw
  }

  const query = new URLSearchParams(
    Object.entries(values).map(([k, v]) => [k, String(v)]),
  ).toString()
  const asked = `curl -s '${origin || ''}${route}${query ? `?${query}` : ''}'`

  let result
  try {
    result = await entry.call(values)
  } catch (e) {
    return renders.renderProblem({
      title: 'That did not work',
      why: `\`${wanted}\` could not answer: **${e.message}**`,
      hint:
        e.status === 400
          ? 'Something required was left empty. Go back to the form, fill it in, and try again.'
          : 'The same call is below, if you want to run it yourself and see more.',
      asked,
    })
  }

  return renders.renderAnswer({ wanted, operation, values, origin, result, asked })
}

module.exports = { tryOperation, operationsOf }
