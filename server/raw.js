// raw.js — the farm's own answer, plain. CommonJS.
//
// What renders when no plugin provides the render contract: correct, complete,
// and unadorned. The contract's RAW table says what that means — raw keeps the
// working forms, the runnable calls, the whole result and the command
// classification, and loses only the dressing: summary prose, tables for flat
// rows, galleries, grouped command sections. Ugly, honest, complete — and
// enough for an agent, which never wanted the beauty anyway.
//
// The same invariants bind this and any declared provider — test/contract.cjs
// checks both against the same table, which is what stops "raw" from quietly
// coming to mean "less".

const crypto = require('node:crypto')

/** Item ids must be stable across regenerations, or every run rewrites the page. */
const idFor = (...parts) => crypto.createHash('sha1').update(parts.join('/')).digest('hex').slice(0, 16)

/** "FreeCulture API" → "freeculture-api", the wiki's own slug rule. */
const slugFor = title =>
  title
    .replace(/\s/g, '-')
    .replace(/[^A-Za-z0-9-]/g, '')
    .toLowerCase()

const titleFor = declaration => `${(declaration.spec.info && declaration.spec.info.title) || declaration.name} API`

const typeOf = schema => {
  if (!schema) return ''
  if (schema.$ref) return schema.$ref.split('/').pop()
  if (schema.type === 'array') return `array of ${typeOf(schema.items)}`
  return schema.type || ''
}

/** One parameter, as a bullet: name, type, whether you may leave it out. Facts only. */
const parameterLine = p => {
  const s = p.schema || {}
  const facts = [typeOf(s)]
  if (p.required) facts.push('required')
  else if (s.default !== undefined) facts.push(`default ${JSON.stringify(s.default)}`)
  else facts.push('optional')
  if (s.minimum !== undefined || s.maximum !== undefined) {
    facts.push(`${s.minimum !== undefined ? s.minimum : '…'} to ${s.maximum !== undefined ? s.maximum : '…'}`)
  }
  return `- **${p.name}** — ${facts.filter(Boolean).join(', ')}. ${p.description || ''}`.trimEnd()
}

/** The values a parameter may take, stated in the spec or bound from the command table. */
const choicesFor = (p, vocabulary) => {
  const schema = p.schema || {}
  const stated = (schema.type === 'array' ? schema.items && schema.items.enum : schema.enum) || []
  if (stated.length || !p['x-fedwiki-from-commands'] || !vocabulary) return stated
  return Object.values(vocabulary.commands)
    .filter(c => c.kind === 'parameter' && c.parameter === p['x-fedwiki-from-commands'] && c.value !== undefined)
    .map(c => c.value)
}

/**
 * One control for one parameter. Single-valued controls only — wiki-plugin-html
 * folds serializeArray() into an object, so two inputs sharing a name leave
 * only the last. A parameter with known values gets a menu of them.
 */
const controlFor = (p, vocabulary) => {
  const schema = p.schema || {}
  const label = `<label>${p.name}${p.required ? ' *' : ''}`
  const choices = choicesFor(p, vocabulary)

  if (choices.length) {
    const chosen = schema.default !== undefined ? [].concat(schema.default).join(',') : ''
    return (
      `${label}\n<select name="${p.name}">\n` +
      (p.required ? '' : '<option value="">(leave out)</option>\n') +
      choices.map(v => `<option value="${v}"${v === chosen ? ' selected' : ''}>${v}</option>`).join('\n') +
      `\n</select></label>`
    )
  }

  const attrs = [`name="${p.name}"`]
  if (schema.type === 'integer' || schema.type === 'number') {
    attrs.push('type="number"')
    if (schema.minimum !== undefined) attrs.push(`min="${schema.minimum}"`)
    if (schema.maximum !== undefined) attrs.push(`max="${schema.maximum}"`)
  } else {
    attrs.push('type="text"')
  }
  const preset = p['x-fedwiki-example'] !== undefined ? p['x-fedwiki-example'] : schema.default
  if (preset !== undefined) attrs.push(`value="${preset}"`)
  return `${label} <input ${attrs.join(' ')}></label>`
}

/**
 * The form that calls the operation described just above it. Kept in the raw
 * reply on purpose — a form is mechanism, generated from the spec, and it IS
 * the try door. The action is relative so the answer comes from the site
 * being read.
 */
const tryForm = (operation, toolName, vocabulary) => {
  const controls = (operation.parameters || [])
    .filter(p => p.in === 'query')
    .map(p => controlFor(p, vocabulary))
    .join('\n')
  const warning = operation['x-fedwiki-writes'] === true ? `<p><strong>Changes this page.</strong></p>\n` : ''
  return (
    `<form action="/system/api/try.json" method="POST">\n` +
    warning +
    `<input type="hidden" name="operation" value="${toolName}">\n` +
    (controls ? `${controls}\n` : '') +
    `<button type="submit">${operation['x-fedwiki-writes'] === true ? 'Do it' : 'Try it'}</button>\n` +
    `</form>`
  )
}

/** A call somebody can actually run, or an instruction shaped like one. */
const exampleCall = (route, operation) => {
  const query = (operation.parameters || [])
    .filter(p => p.in === 'query' && p.required)
    .map(p => `${p.name}=${p['x-fedwiki-example'] !== undefined ? p['x-fedwiki-example'] : `<${p.name}>`}`)
    .join('&')
  return `curl -s 'http://localhost${route}${query ? `?${query}` : ''}' | head -c 400`
}

/**
 * The command table, classified. The same headings the beautiful renderer uses,
 * because which side of the wire a command lives on is truth, not taste — only
 * the prose around the tables is dressing, so only the prose is missing.
 */
const commandSections = (declaration, vocabulary) => {
  if (!vocabulary) return []
  const commands = Object.entries(vocabulary.commands)
  const cell = text => String(text || '').replace(/\|/g, '\\|')
  const row = (word, becomes) => `| \`${word}\` | ${cell(becomes)} |`
  const table = rows => ['| Command | Becomes |', '| --- | --- |', ...rows].join('\n')
  const sections = []

  sections.push({
    type: 'markdown',
    id: idFor(declaration.name, 'itemtext'),
    text: `Written into a \`${vocabulary.itemType}\` item, one command per line.`,
  })

  const crossing = commands.filter(([, c]) => ['parameter', 'operation', 'macro', 'payload'].includes(c.kind))
  if (crossing.length) {
    sections.push({
      type: 'markdown',
      id: idFor(declaration.name, 'commands', 'crossing'),
      text:
        `# Commands That Reach The Farm\n\n` +
        table(
          crossing.map(([word, c]) =>
            c.kind === 'macro'
              ? row(word, `\`${c.expands.join('` + `')}\` together`)
              : row(word, c.kind === 'payload' ? `**${c.parameter}** = the rest of the line` : `**${c.parameter}** = \`${c.value}\``),
          ),
        ),
    })
  }

  const presentation = commands.filter(([, c]) => c.kind === 'presentation')
  if (presentation.length) {
    sections.push({
      type: 'markdown',
      id: idFor(declaration.name, 'commands', 'presentation'),
      text: `# Never Leaves The Browser\n\n` + table(presentation.map(([word, c]) => row(word, c.argument ? `\`${c.argument}\`` : '—'))),
    })
  }

  const clientData = commands.filter(([, c]) => c.kind === 'client-data')
  if (clientData.length) {
    sections.push({
      type: 'markdown',
      id: idFor(declaration.name, 'commands', 'client'),
      text: `# The Farm Cannot Answer These\n\n` + table(clientData.map(([word, c]) => row(word, cell(c.why || c.description) || '—'))),
    })
  }

  const aliases = commands.filter(([, c]) => c.kind === 'alias')
  if (aliases.length) {
    sections.push({
      type: 'markdown',
      id: idFor(declaration.name, 'commands', 'alias'),
      text: aliases.map(([word, c]) => `\`${word}\` is another spelling of \`${c.alias}\`.`).join(' '),
    })
  }

  return sections
}

/** One declaration as a reference page: the facts, the form, the call. Pure. */
const renderDeclaration = (declaration, { mounted = [], described = [], skipped = [], vocabulary = null } = {}) => {
  const title = titleFor(declaration)
  const story = []

  for (const { method, route, operationId, servedByPlugin } of [
    ...mounted.map(m => ({ ...m, servedByPlugin: false })),
    ...described.map(m => ({ ...m, servedByPlugin: true })),
  ]) {
    let operation = null
    for (const operations of Object.values(declaration.spec.paths)) {
      if (operations[method] && operations[method].operationId === operationId) operation = operations[method]
    }
    if (!operation) continue

    const parameters = (operation.parameters || []).filter(p => p.in === 'query')
    const lines = [`\`${method.toUpperCase()} ${route}\``]
    if (parameters.length) lines.push('', ...parameters.map(parameterLine))
    if (servedByPlugin) lines.push('', `Served by \`${declaration.plugin}\` itself, not mounted by the farm.`)
    story.push({ type: 'markdown', id: idFor(declaration.name, operationId, 'text'), text: lines.join('\n') })

    // No form for a route the farm does not serve: it has no handler to call.
    if (!servedByPlugin) {
      story.push({
        type: 'html',
        id: idFor(declaration.name, operationId, 'form'),
        text: tryForm(operation, `${declaration.name}_${operationId}`, vocabulary),
      })
    }
    story.push({ type: 'terminal', id: idFor(declaration.name, operationId, 'call'), text: exampleCall(route, operation) })
  }

  if (skipped.length) {
    story.push({
      type: 'markdown',
      id: idFor(declaration.name, 'skipped'),
      text: `# Declared, Not Offered\n\n` + skipped.map(({ where, why }) => `- \`${where}\` — ${why}`).join('\n'),
    })
  }

  story.push(...commandSections(declaration, vocabulary))
  story.push({ type: 'markdown', id: idFor(declaration.name, 'see'), text: `# See\n\n[[Farm API]]` })

  return {
    title,
    story,
    journal: [
      {
        type: 'create',
        item: { title, story: [story[0]] },
        // No clock: a generated page that changes its own date every run would
        // look edited when nothing about it had changed.
        date: 0,
        provenance:
          `Generated by the Farm Plugin from what ${declaration.plugin} declares. ` +
          `Edits here are overwritten on the next start — fork the page to keep them.`,
      },
    ],
    plugin: 'farm',
  }
}

/** Every interface on the farm, listed. Pure. */
const renderIndex = registry => {
  const declaring = registry.filter(r => r.mounted && r.mounted.length)
  const story = [
    {
      type: 'markdown',
      id: idFor('index', 'intro'),
      text: declaring.length
        ? declaring
            .map(({ declaration, mounted }) => {
              const count = mounted.length
              return `- [[${titleFor(declaration)}]] — ${count} operation${count === 1 ? '' : 's'} under \`${declaration.base}/\``
            })
            .join('\n')
        : `No plugin on this farm declares an interface.`,
    },
  ]
  if (declaring.length) {
    story.push({ type: 'terminal', id: idFor('index', 'call'), text: "curl -s 'http://localhost/system/api.json' | head -c 400" })
  }

  return {
    title: 'Farm API',
    story,
    journal: [
      {
        type: 'create',
        item: { title: 'Farm API', story: [story[0]] },
        date: 0,
        provenance:
          'Generated by the Farm Plugin from the interfaces installed on this farm. ' +
          'Edits here are overwritten on the next start — fork the page to keep them.',
      },
    ],
    plugin: 'farm',
  }
}

/** What one call answered: the whole result, the repeatable call, nothing else. */
const renderAnswer = ({ wanted, operation, values = {}, origin, result, asked }) => {
  const title = (operation && operation.summary) || wanted
  const story = [
    // Untruncated on purpose — raw means nothing missing from the reply.
    { type: 'code', id: idFor(wanted, 'json', asked), text: JSON.stringify(result, null, 2), language: 'json' },
    { type: 'terminal', id: idFor(wanted, 'curl', asked), text: asked },
  ]
  return {
    title,
    story,
    journal: [
      {
        type: 'create',
        item: { title, story: [story[0]] },
        date: Date.now(),
        provenance: `Generated by the Farm Plugin by calling ${wanted}. Not stored — fork it to keep it.`,
      },
    ],
  }
}

/** A failure is always a page — a status code the html plugin would drop is not an answer. */
const renderProblem = ({ title, why, hint, asked }) => ({
  title,
  story: [
    { type: 'markdown', id: idFor('problem', why), text: why },
    ...(hint ? [{ type: 'markdown', id: idFor('hint', hint), text: hint }] : []),
    ...(asked ? [{ type: 'code', id: idFor('asked', asked), text: asked }] : []),
  ],
  journal: [
    {
      type: 'create',
      item: { title, story: [] },
      date: 0,
      provenance: 'Generated by the Farm Plugin in answer to a form. Not stored — fork it to keep it.',
    },
  ],
})

module.exports = { renderDeclaration, renderIndex, renderAnswer, renderProblem, idFor, slugFor, titleFor }
