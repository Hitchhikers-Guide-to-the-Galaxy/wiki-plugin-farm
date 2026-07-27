#!/usr/bin/env node
// contract.cjs — does a renderer keep the render contract?
//
//   node test/contract.cjs [providerDir]
//
// providerDir defaults to this package's own server directory — the builtin
// renderer. When the rendering estate crosses to wiki-plugin-beautiful-feedback
// this same file runs there unchanged, pointed at that package's server
// directory, which is what makes the agreement test span both packages: one
// test, two providers, one contract.
//
// The invariants are read from server/contract.js rather than restated here.
// A contract invariant this test has no check for FAILS the run — an invariant
// that cannot be enforced must not be declared — and needs no fixture, no
// network, and no farm running.

const path = require('node:path')

const providerDir = path.resolve(process.argv[2] || path.join(__dirname, '..', 'server'))

// The contract is the farm's. When this file runs inside the renderer's own
// package the farm is a sibling — the dev workshop and an installed farm's
// node_modules both put the two packages side by side.
const contract = (() => {
  for (const candidate of [
    path.join(providerDir, 'contract.js'),
    path.join(__dirname, '..', 'server', 'contract.js'),
    path.join(__dirname, '..', '..', 'wiki-plugin-farm', 'server', 'contract.js'),
  ]) {
    try {
      return require(candidate)
    } catch {}
  }
  throw new Error('no contract.js found — this test needs wiki-plugin-farm alongside the package under test')
})()

// Load the renders through the provider seam itself: a declared provider
// exports provideRenders from render.js, the farm's own raw renders are the
// builtin. The same doorway the farm uses, so the test cannot pass a module
// the farm could not resolve.
const renders = (() => {
  try {
    const ns = require(path.join(providerDir, 'render.js'))
    if (typeof ns.provideRenders === 'function') return ns.provideRenders({ builtin: null })
  } catch {}
  return require(path.join(providerDir, 'raw.js'))
})()

// ---- The fixture farm: one declaration exercising every shape that crosses.

const spec = {
  openapi: '3.0.3',
  info: { title: 'Demo', version: '1.0.0', description: 'A fixture interface.' },
  paths: {
    '/things.json': {
      get: {
        operationId: 'listThings',
        summary: 'List the things',
        description: 'Everything the demo holds.',
        'x-fedwiki-read-only': true,
        parameters: [
          {
            name: 'kind',
            in: 'query',
            required: true,
            'x-fedwiki-example': 'stone',
            schema: { type: 'string' },
            description: 'What sort of thing',
          },
          { name: 'sort', in: 'query', 'x-fedwiki-from-commands': 'sort', schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50, default: 10 } },
        ],
        responses: { 200: { description: 'The things.' } },
      },
      post: {
        operationId: 'addThing',
        summary: 'Add a thing',
        'x-fedwiki-writes': true,
        parameters: [{ name: 'name', in: 'query', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'The thing, added.' } },
      },
    },
    '/plugin/demo/echo.json': {
      get: {
        operationId: 'echo',
        summary: 'Echo from the plugin itself',
        'x-fedwiki-served-by': 'plugin',
        responses: { 200: { description: 'The echo.' } },
      },
    },
  },
}

const declaration = { plugin: 'wiki-plugin-demo', name: 'demo', version: 1, spec, base: '/system/api/demo' }

const RESULT = { query: 'stone', count: 2, things: [{ name: 'flint', count: 3 }, { name: 'chert', count: 1 }] }

const mounted = [
  {
    method: 'get',
    route: '/system/api/demo/things.json',
    operationId: 'listThings',
    summary: 'List the things',
    call: async () => RESULT,
    writes: false,
  },
  {
    method: 'post',
    route: '/system/api/demo/things.json',
    operationId: 'addThing',
    summary: 'Add a thing',
    call: async () => ({ ok: true }),
    writes: true,
  },
]
const described = [
  { method: 'get', route: '/plugin/demo/echo.json', operationId: 'echo', summary: 'Echo from the plugin itself', writes: false },
]
const skipped = [{ where: 'demo GET /hidden.json', why: 'kept aside so the fixture has something declined' }]

// Already classified and bound — classification is farm truth and crosses the
// contract done; a renderer only draws it.
const vocabulary = {
  version: 1,
  itemType: 'demo',
  fallback: ['SORT'],
  commands: {
    SORT: { kind: 'parameter', parameter: 'sort', value: 'name', description: 'By name', route: mounted[0].route, reachable: true },
    NEWEST: { kind: 'parameter', parameter: 'sort', value: 'newest', description: 'Newest first', route: mounted[0].route, reachable: true },
    FIND: { kind: 'payload', parameter: 'kind', description: 'The rest of the line is the kind', route: mounted[0].route, reachable: true },
    HEIGHT: { kind: 'presentation', argument: 'pixels', description: 'How tall to draw', reachable: false },
    ME: { kind: 'client-data', why: 'only the browser knows who is reading', reachable: false },
    ORDER: { kind: 'alias', alias: 'SORT', reachable: null },
  },
}

const entry = { declaration, mounted, described, skipped, vocabulary }
const registry = [entry]

// What the farm hands the answer and problem renders: what happened, already
// decided — the operation it found, the values that crossed, the call it built.
const OPERATION = spec.paths['/things.json'].get
const ASKED = "curl -s 'http://demo.localhost/system/api/demo/things.json?kind=stone&limit=5'"
const OUTCOME = {
  wanted: 'demo_listThings',
  operation: OPERATION,
  values: { kind: 'stone', limit: '5' },
  origin: 'http://demo.localhost',
  result: RESULT,
  asked: ASKED,
}
const PROBLEM = {
  title: 'No such operation',
  why: 'This farm has no operation called `demo_missing`.',
  hint: 'It offers `demo_listThings`.',
}

// ---- The checks, one per contract invariant, by render.

const textOf = page => page.story.map(i => i.text || '').join('\n')
const section = (text, heading) => {
  const m = new RegExp(`# ${heading}\\n[\\s\\S]*?(?=\\n# |$)`).exec(text)
  return m ? m[0] : ''
}
const generatedJournal = page => {
  const problems = []
  if (!Array.isArray(page.journal) || page.journal.length !== 1) problems.push('journal is not a single entry')
  else {
    const [j] = page.journal
    if (j.type !== 'create') problems.push('journal entry is not a create')
    if (j.date !== 0) problems.push('generated page carries a clock — its date must be 0')
    if (!/Generated/.test(j.provenance || '')) problems.push('provenance does not say the page was generated')
  }
  return problems
}

const CHECKS = {
  reference: {
    'every-signature': ({ text }) =>
      [...mounted, ...described]
        .filter(({ method, route }) => !text.includes(`\`${method.toUpperCase()} ${route}\``))
        .map(({ method, route }) => `no signature for ${method.toUpperCase()} ${route}`),
    'every-parameter': ({ text }) =>
      ['kind', 'sort', 'limit', 'name'].filter(p => !text.includes(`**${p}**`)).map(p => `parameter ${p} is not on the page`),
    'runnable-call': ({ page }) => {
      const calls = page.story.filter(i => i.type === 'terminal').map(i => i.text)
      return [...mounted, ...described]
        .filter(({ route }) => !calls.some(c => c.includes(`curl -s 'http://localhost${route}`)))
        .map(({ route }) => `no runnable call for ${route}`)
    },
    'working-form': ({ page }) => {
      const problems = []
      const forms = page.story.filter(i => i.type === 'html' && /<form /.test(i.text))
      for (const { operationId } of mounted) {
        const form = forms.find(f => f.text.includes(`value="demo_${operationId}"`))
        if (!form) {
          problems.push(`no form for ${operationId} — raw keeps the form`)
          continue
        }
        if (!form.text.includes('action="/system/api/try.json"')) problems.push(`${operationId} form posts somewhere else`)
        if (!/<button type="submit">/.test(form.text)) problems.push(`${operationId} form has no button`)
      }
      const listForm = forms.find(f => f.text.includes('value="demo_listThings"')) || { text: '' }
      for (const value of ['name', 'newest']) {
        if (!listForm.text.includes(`<option value="${value}"`)) {
          problems.push(`sort's derived value ${value} is not offered by the form`)
        }
      }
      if (forms.some(f => f.text.includes('value="demo_echo"'))) {
        problems.push('a form offers echo, which the farm does not serve — a button that could only fail')
      }
      return problems
    },
    'commands-classified': ({ text }) => {
      const problems = []
      const crossing = section(text, 'Commands That Reach The Farm')
      const drawing = section(text, 'Never Leaves The Browser')
      const client = section(text, 'The Farm Cannot Answer These')
      for (const [word, command] of Object.entries(vocabulary.commands)) {
        if (command.kind === 'alias') {
          if (!text.includes(`\`${word}\``)) problems.push(`alias ${word} is not on the page`)
          continue
        }
        const belongs =
          ['parameter', 'operation', 'macro', 'payload'].includes(command.kind) ? crossing
          : command.kind === 'presentation' ? drawing
          : client
        if (!belongs.includes(`\`${word}\``)) problems.push(`${word} (${command.kind}) is not on the right side of the wire`)
      }
      if (!text.includes(`\`${vocabulary.itemType}\` item`)) problems.push('the page never says which item the commands are written into')
      return problems
    },
    'skipped-named': ({ text }) =>
      skipped
        .filter(({ where, why }) => !text.includes(where) || !text.includes(why))
        .map(({ where }) => `${where} was declined without being named`),
    pure: ({ render }) =>
      JSON.stringify(render()) === JSON.stringify(render()) ? [] : ['two renders of the same declaration differ'],
    'generated-journal': ({ page }) => generatedJournal(page),
  },
  index: {
    'every-declaring-plugin': ({ text }) => (text.includes('[[Demo API]]') ? [] : ['the declaring plugin is not linked']),
    'runnable-call': ({ page }) =>
      page.story.some(i => i.type === 'terminal' && i.text.includes('/system/api.json')) ? [] : ['no runnable call to the document'],
    pure: ({ render }) => (JSON.stringify(render()) === JSON.stringify(render()) ? [] : ['two renders of the same registry differ']),
    'generated-journal': ({ page }) => generatedJournal(page),
  },
  answer: {
    'whole-result': ({ page }) => {
      const code = page.story.find(i => i.type === 'code')
      if (!code) return ['the answer carries no JSON of the result']
      try {
        return JSON.stringify(JSON.parse(code.text)) === JSON.stringify(RESULT) ? [] : ['the JSON on the page is not the whole result']
      } catch {
        return ['the JSON on the page does not parse']
      }
    },
    'repeatable-call': ({ page }) => {
      const call = page.story.find(i => i.type === 'terminal')
      if (!call) return ['no repeatable call on the answer']
      return ['kind=stone', 'limit=5'].filter(part => !call.text.includes(part)).map(part => `the call lost ${part}`)
    },
    'forkable-journal': ({ page }) =>
      Array.isArray(page.journal) && page.journal.length === 1 && page.journal[0].type === 'create'
        ? []
        : ['the answer has no single create entry, so a fork cannot name it'],
  },
  problem: {
    'always-a-page': ({ page }) =>
      page && page.title && Array.isArray(page.story) && page.story.length ? [] : ['a failure did not arrive as a page'],
    'says-why': ({ page }) => (/no operation called/.test(textOf(page)) ? [] : ['the page does not say what went wrong']),
  },
}

// ---- Run every render the contract names, checking every invariant it declares.

const main = async () => {
  const problems = []
  const renderReference = () => renders.renderDeclaration(declaration, entry)
  const renderIndex = () => renders.renderIndex(registry)

  const subjects = {
    reference: { page: renderReference(), render: renderReference },
    index: { page: renderIndex(), render: renderIndex },
    answer: { page: renders.renderAnswer(OUTCOME) },
    problem: { page: renders.renderProblem(PROBLEM) },
  }

  for (const [name, render] of Object.entries(contract.RENDERS)) {
    const subject = subjects[name]
    const checks = CHECKS[name] || {}
    for (const invariant of render.must) {
      const check = checks[invariant]
      if (!check) {
        problems.push(`${name} — the contract names ${invariant}, which this test cannot check`)
        continue
      }
      for (const p of check({ ...subject, text: textOf(subject.page) })) problems.push(`${name} — ${p}`)
    }
  }

  console.log(`contract:  version ${contract.RENDER_CONTRACT_VERSION}, ${Object.keys(contract.RENDERS).length} renders`)
  console.log(`provider:  ${providerDir}`)
  if (problems.length) {
    console.log('\nBREAKS THE CONTRACT:')
    for (const p of problems) console.log('  ' + p)
    process.exitCode = 1
  } else {
    console.log('\nKEEPS THE CONTRACT — every render, every invariant.')
  }
}

main().catch(e => {
  console.error(e.message)
  process.exitCode = 1
})
