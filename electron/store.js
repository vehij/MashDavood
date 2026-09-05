const { app } = require('electron')
const fs = require('fs')
const path = require('path')

const FILE = path.join(app.getPath('userData'), 'settings.json')

const DEFAULTS = {
  theme: 'system',           // system | light | dark
  viewMode: 'split',         // editor | split | preview
  direction: 'auto',         // auto | rtl | ltr
  fontSize: 16,
  editorFontSize: 14.5,
  editorFont: 'auto',        // auto (Estedad for RTL docs) | estedad | mono
  lineHeight: 1.9,
  contentWidth: 780,
  sidebarVisible: true,
  sidebarWidth: 250,
  sidebarTab: 'files',       // files | outline
  splitRatio: 0.5,
  autosave: true,
  spellcheck: false,
  seenWelcome: false,
  recentFiles: [],
  recentFolders: [],
  lastFolder: null,
  openTabs: [],
  activeTab: null
}

let cache = null

function read () {
  if (cache) return cache
  try {
    cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }
  } catch {
    cache = { ...DEFAULTS }
  }
  return cache
}

let writeTimer = null
function persist () {
  clearTimeout(writeTimer)
  writeTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true })
      fs.writeFileSync(FILE, JSON.stringify(cache, null, 2), 'utf8')
    } catch (e) { /* ignore */ }
  }, 150)
}

module.exports = {
  all: () => ({ ...read() }),
  get: (key) => read()[key],
  set: (key, value) => { read()[key] = value; persist() },
  merge: (obj) => { Object.assign(read(), obj); persist() },
  flush: () => {
    clearTimeout(writeTimer)
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true })
      fs.writeFileSync(FILE, JSON.stringify(read(), null, 2), 'utf8')
    } catch (e) { /* ignore */ }
  },
  DEFAULTS
}
