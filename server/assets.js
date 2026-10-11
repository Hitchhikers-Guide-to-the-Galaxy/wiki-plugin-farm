// assets.js — the farm's own operations: putting a file into a site's assets
// folder, and listing one. CommonJS (see server/package.json).
//
// Every plugin that records, draws or imports something ends up needing to put
// a file beside a page. The route the wiki ships for that belongs to the Assets
// plugin, which this farm does not own and cannot fix; so the farm offers one of
// its own, documented and gated like every other operation, and leaves that
// plugin untouched in its seat. The rules below are the hardened ones from the
// anarchive fork of the Assets plugin — copied, not depended on.

const fs = require('node:fs')
const path = require('node:path')

/** Types a browser would run if served from the wiki's origin. Kept to the reserved folder. */
const EXECUTABLE = new Set(['.html', '.htm', '.xhtml', '.js', '.mjs', '.cjs', '.wasm', '.svgz'])
const RESERVED = 'home'
const MAX_NAME = 200

const problem = (status, message) => Object.assign(new Error(message), { status })

/** The site's assets directory, from the status directory the farm supplies. */
const assetsDir = status => {
  if (!status) throw problem(500, 'this farm did not say where the site lives')
  return path.join(path.dirname(status), 'assets')
}

/**
 * A folder beneath assets: word characters and hyphens, separated by slashes.
 * No dots anywhere, so neither `..` nor a hidden folder can be spelled.
 */
const checkFolder = folder => {
  const f = String(folder ?? '').replace(/^\/+|\/+$/g, '')
  if (!f) throw problem(400, 'name a folder — usually the slug of the page the file belongs to')
  if (!/^[\w-]+(\/[\w-]+)*$/.test(f)) throw problem(400, `not an acceptable folder: ${folder}`)
  return f
}

const checkName = (name, folder) => {
  const n = String(name ?? '')
  if (!n || n === '.' || n === '..') throw problem(400, 'name the file')
  if (n.includes('\0')) throw problem(400, 'the file name contains a null byte')
  if (/[/\\]/.test(n)) throw problem(400, `the file name contains a path separator: ${n}`)
  if (n.startsWith('.')) throw problem(400, `hidden files are not accepted: ${n}`)
  if (n.length > MAX_NAME) throw problem(400, `the file name is longer than ${MAX_NAME} characters`)
  const ext = path.extname(n).toLowerCase()
  if (EXECUTABLE.has(ext) && folder.split('/')[0] !== RESERVED) {
    throw problem(400, `${ext} files are only accepted in the reserved '${RESERVED}' folder`)
  }
  return n
}

/** Rename, or copy then remove when the temporary file sits on another device. */
const move = (from, to) => {
  try {
    fs.renameSync(from, to)
  } catch (e) {
    if (e.code !== 'EXDEV' && e.code !== 'EPERM') throw e
    fs.copyFileSync(from, to)
    fs.rmSync(from, { force: true })
  }
}

/**
 * Store the request body as assets/<folder>/<name>. The answer is sent only once
 * the file is in place, so a success means the file is there — the Assets
 * plugin's own route answers before its rename finishes, and reports success
 * when it fails.
 */
const assetsUpload = ({ folder, name, replace, status, body }) => {
  const f = checkFolder(folder)
  const n = checkName(name, f)
  const dir = path.join(assetsDir(status), f)
  const dest = path.join(dir, n)
  if (fs.existsSync(dest) && !replace) {
    throw problem(409, `assets/${f}/${n} already exists — choose another name, or pass replace=true`)
  }
  fs.mkdirSync(dir, { recursive: true })
  move(body.tmpPath, dest)
  const src = `assets/${f}/${n}`
  return { src, url: `/${src}`, size: body.size, sha256: body.sha256, type: body.type, replaced: !!replace }
}

/** The files in one assets folder, hidden files left out. */
const assetsList = ({ folder, status }) => {
  const f = checkFolder(folder)
  const dir = path.join(assetsDir(status), f)
  if (!fs.existsSync(dir)) return { folder: f, files: [] }
  const files = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isFile() && !d.name.startsWith('.') && !d.name.startsWith('_'))
    .map(d => {
      const st = fs.statSync(path.join(dir, d.name))
      return { name: d.name, src: `assets/${f}/${d.name}`, size: st.size, modified: st.mtime.toISOString() }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
  return { folder: f, files }
}

module.exports = { assetsUpload, assetsList, checkFolder, checkName }
