// vocabulary.js — reading a plugin's command table. CommonJS.
//
// A plugin whose item text is a line-oriented command language may name the
// table it parses with. The client imports that table to parse; the farm reads
// the same one. That is the whole point: not a second declaration to be kept in
// step, but the same table read twice.
//
// The check split, stated plainly because it bounds what any of this proves:
//
//   the farm     checks the table against the plugin's own specification
//   the plugin   checks its parser against the table, in its own tests
//   the import   is what makes them the same table
//
// The farm has no DOM and cannot execute a client parser, so it can never prove
// the item text behaves as the table says. It can prove the table is coherent
// and agrees with the API — and because the parser imports the table rather than
// copying it, that is enough to make drift a thing you have to do on purpose.

const { pathToFileURL } = require('node:url')

const SUPPORTED_VOCABULARY_VERSIONS = [1]

/** The five kinds a command may be, plus alias, which resolves before the rest. */
const KINDS = ['operation', 'parameter', 'payload', 'presentation', 'client-data', 'macro', 'alias']

/** Kinds that never reach a server, and the reason differs between them. */
const UNBOUND = ['presentation', 'client-data']

const loadVocabulary = async declaration => {
  const ns = await import(pathToFileURL(declaration.vocabularyPath).href)
  const version = ns.VOCABULARY_VERSION
  if (!SUPPORTED_VOCABULARY_VERSIONS.includes(version)) {
    throw new Error(
      `vocabulary version ${JSON.stringify(version)} is not understood ` +
        `(this farm understands ${SUPPORTED_VOCABULARY_VERSIONS.join(', ')})`,
    )
  }
  if (!ns.COMMANDS || typeof ns.COMMANDS !== 'object') throw new Error('vocabulary exports no COMMANDS table')
  return {
    version,
    commands: ns.COMMANDS,
    itemType: ns.ITEM_TYPE || declaration.name,
    fallback: ns.FALLBACK || [],
  }
}

/** Every query parameter any operation in a spec declares, by name. */
const parametersOf = spec => {
  const found = new Map()
  for (const operations of Object.values(spec.paths || {})) {
    for (const operation of Object.values(operations)) {
      for (const p of (operation && operation.parameters) || []) {
        if (p.in === 'query') found.set(p.name, p)
      }
    }
  }
  return found
}

/** The values a parameter may take, in declaration order, from the commands that produce it. */
const deriveEnum = (vocabulary, parameter) =>
  Object.values(vocabulary.commands)
    .filter(c => c.kind === 'parameter' && c.parameter === parameter && c.value !== undefined)
    .map(c => c.value)

/**
 * What is wrong with this table, judged against the plugin's own specification.
 * An empty list means the two agree. Problems are returned, never thrown, so the
 * caller can drop the vocabulary and still mount the interface.
 */
const checkVocabulary = (vocabulary, spec) => {
  const problems = []
  const declared = parametersOf(spec)
  const commands = vocabulary.commands

  for (const [name, command] of Object.entries(commands)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) problems.push(`${name} is not an UPPERCASE command word`)
    if (!command || !command.kind) {
      problems.push(`${name} declares no kind — every command must say what it is`)
      continue
    }
    if (!KINDS.includes(command.kind)) problems.push(`${name} has unknown kind ${command.kind}`)

    if (command.kind === 'alias') {
      const target = commands[command.alias]
      if (!target) problems.push(`${name} is an alias of ${command.alias}, which is not a command`)
      else if (target.kind === 'alias') problems.push(`${name} aliases an alias`)
    }

    if (command.kind === 'macro') {
      for (const target of command.expands || []) {
        if (!commands[target]) problems.push(`${name} expands to ${target}, which is not a command`)
        else if (commands[target].kind === 'macro') problems.push(`${name} expands to another macro, ${target}`)
      }
      if (!command.expands || !command.expands.length) problems.push(`${name} is a macro expanding to nothing`)
    }

    if (command.kind === 'parameter') {
      if (!command.parameter) problems.push(`${name} names no parameter`)
      else if (!declared.has(command.parameter)) {
        problems.push(`${name} names parameter ${command.parameter}, which no operation declares`)
      }
      if (command.value === undefined) problems.push(`${name} supplies no value for ${command.parameter}`)
    }

    // The likeliest authoring mistake: documenting a drawing choice as if the
    // server had an opinion about it.
    if (UNBOUND.includes(command.kind) && (command.parameter || command.operationId)) {
      problems.push(`${name} is ${command.kind} but names a parameter or operation — those never reach a server`)
    }
    if (command.kind === 'client-data' && !command.why) {
      problems.push(`${name} is client-data but does not say why a server cannot supply it`)
    }
  }

  // Reachability, one direction only as an error. A parameter may accept more
  // than the item text can say — a plain HTTP caller is not writing item text —
  // so an unreachable enum value is a note, not a fault.
  for (const [parameterName, parameter] of declared) {
    const derived = deriveEnum(vocabulary, parameterName)
    const schema = parameter.schema || {}
    const stated = schema.enum || (schema.items && schema.items.enum)
    if (!stated || !derived.length) continue
    for (const value of derived) {
      if (!stated.includes(value)) problems.push(`a command emits ${parameterName}=${value}, which the spec forbids`)
    }
  }

  return problems
}

/**
 * Mark each command with whether it can actually be reached on this farm.
 *
 * Same discipline as the merged document: describe what is mounted. A command
 * naming an operation that was skipped is declared but unreachable here, which
 * is worth saying rather than hiding.
 */
const bindCommands = (vocabulary, mounted) => {
  const routeFor = {}
  for (const m of mounted) routeFor[m.operationId] = m.route

  const bound = {}
  for (const [name, command] of Object.entries(vocabulary.commands)) {
    const entry = { ...command }
    if (command.kind === 'parameter' || command.kind === 'operation' || command.kind === 'payload') {
      // Family declares one operation, so a parameter command belongs to it;
      // a plugin with several says which by naming an operationId.
      const target = command.operationId || (mounted[0] && mounted[0].operationId)
      entry.route = routeFor[target] || null
      entry.reachable = Boolean(entry.route)
    } else if (command.kind === 'macro' || command.kind === 'alias') {
      entry.reachable = null // decided by what it resolves to
    } else {
      entry.reachable = false // presentation and client-data never cross
    }
    bound[name] = entry
  }
  return bound
}

module.exports = {
  loadVocabulary,
  checkVocabulary,
  deriveEnum,
  bindCommands,
  parametersOf,
  KINDS,
  UNBOUND,
  SUPPORTED_VOCABULARY_VERSIONS,
}
