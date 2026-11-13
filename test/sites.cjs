#!/usr/bin/env node
// sites.cjs — the site list follows symlinked aliases (0.10.5).
//
//   node test/sites.cjs

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { sitesOf } = require('../server/context.js')
const { farmSites } = require('../server/assets.js')

const problems = []
const check = (name, ok, detail = '') => ok || problems.push(detail ? `${name} — ${detail}` : name)

const farm = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-sites-'))
const site = name => {
  fs.mkdirSync(path.join(farm, name, 'pages'), { recursive: true })
  fs.mkdirSync(path.join(farm, name, 'status'), { recursive: true })
  fs.writeFileSync(path.join(farm, name, 'status', 'owner.json'), JSON.stringify({ name: 'David Bovill', oauth2: { id: 'david' } }))
}
site('bot.private.hitchhiker.institute')
site('plain.private.fish')
fs.mkdirSync(path.join(farm, 'nopages'))
fs.symlinkSync(path.join(farm, 'bot.private.hitchhiker.institute'), path.join(farm, 'bot.pi5.private.fish'))
fs.symlinkSync(path.join(farm, 'gone'), path.join(farm, 'dangling.private.fish'))
fs.writeFileSync(path.join(farm, 'afile'), '')

const all = sitesOf(farm)
check('real site listed', all.includes('plain.private.fish'), all.join(','))
check('symlinked alias listed', all.includes('bot.pi5.private.fish'), all.join(','))
check('its target listed too', all.includes('bot.private.hitchhiker.institute'))
check('dangling symlink skipped', !all.includes('dangling.private.fish'))
check('folder without pages skipped', !all.includes('nopages'))
check('plain file skipped', !all.includes('afile'))
check('sorted', JSON.stringify(all) === JSON.stringify([...all].sort()))

const owned = farmSites({ owner: 'david', farmRoot: farm }).sites
check("owner's alias listed", owned.includes('bot.pi5.private.fish'), owned.join(','))
check("owner's real site listed", owned.includes('plain.private.fish'))
check('dangling alias not owned', !owned.includes('dangling.private.fish'))

fs.rmSync(farm, { recursive: true, force: true })
if (problems.length) {
  console.error('sites: FAIL\n  ' + problems.join('\n  '))
  process.exit(1)
}
console.log('sites: ok')
