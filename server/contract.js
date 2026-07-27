// contract.js — the render contract, as data. CommonJS.
//
// The seam the farm/renderer split hangs on. The farm decides what is true —
// what mounted, what a call answered, what went wrong — and hands it across
// this contract to whatever renders it as page JSON. The builtin raw renderer
// satisfies it; a plugin declaring itself a provider (wiki-plugin-
// beautiful-feedback) must satisfy the same version of it; the agreement test
// in test/contract.cjs reads THIS table and checks whichever provider it is
// pointed at, so the contract and the check cannot drift apart.
//
// Versioned the way declarations and vocabularies are versioned: an integer,
// bumped when the shape of what crosses changes. A provider names the version
// it renders; a farm accepts only versions it understands, falls back to the
// builtin otherwise, and records the substitution in the merged document.
//
// Three decisions are recorded here rather than in anyone's memory:
//
// RAW KEEPS THE FORM. The raw reply keeps the working form and the runnable
// curl, and loses only the dressing — summaries, tables, galleries, prose.
// A form is mechanism, not taste: it is generated from the spec and it IS the
// try door. The kill criterion in the plan guards exactly this line.
//
// CLASSIFICATION IS FARM TRUTH, DRAWING IS NOT. A command's kind — whether it
// reaches the farm at all — is checked against the spec by the farm
// (vocabulary.js) and crosses the contract already classified and bound. The
// renderer draws the tables and may not reclassify; the agreement test fails
// any page where classification did not survive rendering.
//
// A PROBLEM IS ALWAYS A PAGE. Whatever renders, a failure arrives as page
// JSON with a title and a plain sentence saying why — never as a status code
// the html plugin would drop on the floor.

const RENDER_CONTRACT_VERSION = 1

/** Versions this farm can hand across the seam. Anything else falls back to the builtin. */
const SUPPORTED_RENDER_VERSIONS = [1]

/**
 * What a provider renders, what each render takes, and what the rendered page
 * must contain. The `must` names are checked by test/contract.cjs — a name the
 * test does not know how to check fails the test, both ways, so an invariant
 * cannot be declared without being enforced.
 */
const RENDERS = {
  // One declaration as a reference page: pages.js renderDeclaration.
  reference: {
    exports: 'renderDeclaration',
    takes: ['declaration', 'mounted', 'described', 'skipped', 'vocabulary'],
    must: [
      'every-signature', // `METHOD /route` for every mounted and described operation
      'every-parameter', // **name** for every query parameter, with its facts
      'runnable-call', // a curl somebody can run, for every operation
      'working-form', // a form posting to try.json for every mounted operation — raw keeps the form
      'commands-classified', // every vocabulary word on the page, on the right side of the wire
      'skipped-named', // what was declared and not offered, named with its why
      'pure', // same declaration, same page — no disk, no clock, no randomness
      'generated-journal', // one create entry, date 0, provenance naming the generator
    ],
  },
  // Every interface on the farm, from one place: pages.js renderIndex.
  index: {
    exports: 'renderIndex',
    takes: ['registry'],
    must: ['every-declaring-plugin', 'runnable-call', 'pure', 'generated-journal'],
  },
  // A try answer as a ghost page. The farm found the operation, asked the
  // gate, made the call and built the repeatable curl — what crosses is only
  // what happened, and the renderer draws it.
  answer: {
    exports: 'renderAnswer',
    takes: ['wanted', 'operation', 'values', 'origin', 'result', 'asked'],
    must: [
      'whole-result', // the full answer on the page as JSON — nothing missing from the reply
      'repeatable-call', // the same call as a terminal item, arguments included
      'forkable-journal', // one create entry, so the title is editable and the fork keeps it
    ],
  },
  // A failure as a page. The words are the farm's — what went wrong is truth —
  // and the renderer only lays them out.
  problem: {
    exports: 'renderProblem',
    takes: ['title', 'why', 'hint', 'asked'],
    must: ['always-a-page', 'says-why'],
  },
}

/** The raw guarantee, stated as data: what the farm's own fallback keeps and loses. */
const RAW = {
  keeps: ['working forms', 'runnable calls', 'the whole result', 'command classification'],
  loses: ['summary sentences', 'tables for flat rows', 'galleries', 'grouped command prose'],
}

/**
 * How a provider is found, stated as data. A plugin declares `fedwiki.render`
 * in its package metadata — the contract version it renders and the module
 * that renders it. The module exports one function, `provideRenders`, which
 * takes the builtin renders and gives back its own; every name in RENDERS must
 * come back a function or the farm keeps the builtin. The outcome — provider
 * or builtin, and any refusal — is recorded in the merged document, so a raw
 * farm and a beautiful farm both say which they are.
 */
const RESOLUTION = {
  declaration: 'fedwiki.render',
  declares: ['version', 'module'],
  exports: 'provideRenders',
  recordedAt: 'x-fedwiki-farm.render',
}

module.exports = { RENDER_CONTRACT_VERSION, SUPPORTED_RENDER_VERSIONS, RENDERS, RAW, RESOLUTION }
