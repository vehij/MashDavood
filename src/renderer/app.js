import 'katex/dist/katex.min.css'
import mermaid from 'mermaid'
import { createRenderer, renderMarkdown, extractOutline, documentStats, detectDirection, toFileUrl } from './markdown.js'
import { initUpdates, checkForUpdates } from './updates.js'
import { MarkdownEditor } from './editor.js'
import { WELCOME_DOC } from './welcome.js'

const api = window.api
const $ = (sel) => document.querySelector(sel)
const el = {
  app: $('#app'),
  tabstrip: $('#tabstrip'),
  sidebar: $('#sidebar'),
  sideFiles: $('#side-files'),
  sideOutline: $('#side-outline'),
  sideSearch: $('#side-search'),
  sideSearchWrap: $('#side-search-wrap'),
  preview: $('#preview'),
  previewScroll: $('#preview-scroll'),
  editorHost: $('#editor'),
  paneEditor: $('#pane-editor'),
  panes: $('#panes'),
  empty: $('#empty-state'),
  emptyRecent: $('#empty-recent'),
  stPath: $('#st-path'),
  stStats: $('#st-stats'),
  stCursor: $('#st-cursor'),
  stSaved: $('#st-saved'),
  stDir: $('#st-dir'),
  modalBackdrop: $('#modal-backdrop'),
  modal: $('#modal'),
  toasts: $('#toasts'),
  viewmode: $('#viewmode'),
  previewTools: $('#preview-tools'),
  quickPanel: $('#quick-panel'),
  ptCopy: $('#pt-copy'),
  ptQuick: $('#pt-quick')
}

const md = createRenderer()
let editor = null
let uid = 0

const state = {
  settings: {},
  tabs: [],
  activeId: null,
  folder: null,
  expanded: new Set(),
  outline: [],
  dark: false,
  lineMap: [],
  syncSource: null,
  syncTimer: null,
  filter: ''
}

/* ------------------------------------------------------------- utilities */

const debounce = (fn, ms) => {
  let t
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms) }
}

function toast (message, kind = '') {
  const node = document.createElement('div')
  node.className = 'toast ' + kind
  node.textContent = message
  el.toasts.appendChild(node)
  setTimeout(() => { node.style.opacity = '0'; node.style.transition = 'opacity .2s' }, 2600)
  setTimeout(() => node.remove(), 2900)
}

const SEP = api.platform === 'win32' ? '\\' : '/'
const basename = (p) => (p || '').split(/[\\/]/).pop()
const dirname = (p) => (p || '').split(/[\\/]/).slice(0, -1).join(SEP)
const joinPath = (...parts) => parts.filter(Boolean).join(SEP)
const activeTab = () => state.tabs.find((t) => t.id === state.activeId) || null

const IS_MAC = api.platform === 'darwin'
/** Shortcut hints are authored with mac glyphs; translate them elsewhere. */
const keys = (text) => IS_MAC
  ? text
  : text.replace(/⌘/g, 'Ctrl+').replace(/⌥/g, 'Alt+').replace(/⇧/g, 'Shift+').replace(/⌃/g, 'Ctrl+')
    .replace(/Ctrl\+Shift\+/g, 'Ctrl+Shift+').replace(/\+\s/g, '+')

function localiseShortcutHints () {
  if (IS_MAC) return
  document.querySelectorAll('kbd').forEach((k) => { k.textContent = keys(k.textContent) })
  document.querySelectorAll('[title]').forEach((n) => { n.title = keys(n.title) })
}

function saveSession () {
  api.settings.merge({
    openTabs: state.tabs.filter((t) => t.path).map((t) => t.path),
    activeTab: activeTab()?.path || null,
    lastFolder: state.folder?.root || null
  })
}
const saveSessionSoon = debounce(saveSession, 400)

/* ---------------------------------------------------------------- theme */

async function applyTheme (theme) {
  state.settings.theme = theme
  const dark = await api.setTheme(theme)
  setDarkClass(theme === 'system' ? dark : theme === 'dark')
}

function mermaidConfig (dark) {
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    theme: dark ? 'dark' : 'default',
    fontFamily: "Estedad, -apple-system, sans-serif",
    themeVariables: {
      fontSize: '15px',
      edgeLabelBackground: dark ? '#1b1d22' : '#f2f2f0'
    },
    flowchart: { htmlLabels: true, useMaxWidth: true },
    sequence: { useMaxWidth: true },
    gantt: { useMaxWidth: true }
  }
}

function setDarkClass (dark) {
  state.dark = dark
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  mermaid.initialize(mermaidConfig(dark))
  scheduleRender(true)
}

/* --------------------------------------------------------- typography */

function applyTypography () {
  const s = state.settings
  el.app.dataset.editorFont = s.editorFont || 'auto'
  const root = document.documentElement.style
  root.setProperty('--preview-font-size', s.fontSize + 'px')
  root.setProperty('--editor-font-size', s.editorFontSize + 'px')
  root.setProperty('--preview-line-height', String(s.lineHeight))
  root.setProperty('--content-width', s.contentWidth + 'px')
  el.preview.classList.toggle('justify', !!s.justify)
}

/* ------------------------------------------------------------ view mode */

function setViewMode (mode) {
  state.settings.viewMode = mode
  el.app.dataset.view = mode
  el.viewmode.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode))
  api.settings.merge({ viewMode: mode })
  if (mode !== 'preview') setTimeout(() => editor?.focus(), 0)
  requestAnimationFrame(() => { state.lineMap = [] })
}

function setSidebar (visible) {
  state.settings.sidebarVisible = visible
  el.app.classList.toggle('no-sidebar', !visible)
  $('#btn-sidebar').classList.toggle('on', visible)
  api.settings.merge({ sidebarVisible: visible })
}

function setDirection (dir) {
  state.settings.direction = dir
  const tab = activeTab()
  const effective = dir === 'auto' ? (tab ? tab.dir : 'ltr') : dir
  el.app.dataset.dir = effective
  // the document's direction, not dir="auto": auto ignores children that carry their own
  // dir (all blocks do), so it always resolved LTR for the few that don't
  el.preview.setAttribute('dir', effective)
  el.stDir.textContent = 'dir: ' + dir + (dir === 'auto' ? ` (${effective})` : '')
  api.settings.merge({ direction: dir })
}

/* ------------------------------------------------------------- tabs */

function makeTab ({ path = null, content = '', name = null }) {
  return {
    id: ++uid,
    path,
    name: name || (path ? basename(path) : 'Untitled'),
    content,
    saved: content,
    dirty: false,
    dir: detectDirection(content),
    editorScroll: 0,
    previewScroll: 0,
    cursorLine: 1
  }
}

function renderTabs () {
  el.tabstrip.innerHTML = ''
  for (const tab of state.tabs) {
    const node = document.createElement('div')
    node.className = 'tab' + (tab.id === state.activeId ? ' active' : '')
    node.title = tab.path || tab.name
    node.innerHTML = `${tab.dirty ? '<span class="dot"></span>' : ''}<span class="tab-name"></span><button class="tab-close" title="Close (⌘W)">×</button>`
    node.querySelector('.tab-name').textContent = tab.name
    node.addEventListener('mousedown', (e) => {
      if (e.button === 1) { e.preventDefault(); closeTab(tab.id) }
      else if (!e.target.closest('.tab-close')) activateTab(tab.id)
    })
    node.querySelector('.tab-close').addEventListener('click', (e) => { e.stopPropagation(); closeTab(tab.id) })
    el.tabstrip.appendChild(node)
  }
  el.empty.classList.toggle('hidden', state.tabs.length > 0)
}

function activateTab (id, { focus = true } = {}) {
  const current = activeTab()
  if (current) {
    current.content = editor.getValue()
    current.editorState = editor.state          // keeps undo history and selection per tab
    current.editorScroll = editor.getScrollInfo().top
    current.previewScroll = el.previewScroll.scrollTop
  }
  const tab = state.tabs.find((t) => t.id === id)
  if (!tab) return
  state.activeId = id
  editor.setState(tab.editorState || editor.createState(tab.content))
  renderTabs()
  renderPreview(true)
  requestAnimationFrame(() => {
    editor.setScrollTop(tab.editorScroll || 0)
    el.previewScroll.scrollTop = tab.previewScroll || 0
  })
  updateStatus()
  setDirection(state.settings.direction)
  markActiveInTree()
  if (focus && state.settings.viewMode !== 'preview') editor.focus()
  saveSessionSoon()
}

async function closeTab (id) {
  const idx = state.tabs.findIndex((t) => t.id === id)
  if (idx < 0) return
  const tab = state.tabs[idx]
  if (tab.id === state.activeId) tab.content = editor.getValue()
  if (tab.dirty) {
    const answer = await api.confirmClose(tab.name)
    if (answer === 'cancel') return
    if (answer === 'save') { const ok = await saveTab(tab); if (!ok) return }
  }
  if (tab.path) api.unwatch(tab.path)
  state.tabs.splice(idx, 1)
  if (state.activeId === id) {
    const next = state.tabs[idx] || state.tabs[idx - 1]
    if (next) activateTab(next.id)
    else {
      state.activeId = null
      editor.replaceAll('')
      el.preview.innerHTML = ''
      renderTabs()
      updateStatus()
      renderOutline([])
    }
  } else renderTabs()
  saveSession()
}

function cycleTab (delta) {
  if (state.tabs.length < 2) return
  const i = state.tabs.findIndex((t) => t.id === state.activeId)
  const next = state.tabs[(i + delta + state.tabs.length) % state.tabs.length]
  activateTab(next.id)
}

async function openFile (path, content = null) {
  const existing = state.tabs.find((t) => t.path === path)
  if (existing) { activateTab(existing.id); return existing }
  let text = content
  if (text === null) {
    try { text = await api.read(path) } catch (e) { toast('Could not open ' + basename(path), 'error'); return null }
  }
  const tab = makeTab({ path, content: text })
  state.tabs.push(tab)
  api.watch(path)
  activateTab(tab.id)
  return tab
}

function newTab (content = '', name = 'Untitled') {
  const tab = makeTab({ content, name })
  state.tabs.push(tab)
  activateTab(tab.id)
  return tab
}

/* ------------------------------------------------------------- saving */

async function saveTab (tab) {
  if (!tab) return false
  if (tab.id === state.activeId) tab.content = editor.getValue()
  if (!tab.path) return saveTabAs(tab)
  try {
    await api.write(tab.path, tab.content)
    tab.saved = tab.content
    tab.dirty = false
    renderTabs()
    updateStatus('Saved')
    return true
  } catch (e) {
    toast('Save failed: ' + e.message, 'error')
    return false
  }
}

async function saveTabAs (tab) {
  if (!tab) return false
  if (tab.id === state.activeId) tab.content = editor.getValue()
  const path = await api.saveAs(tab.path || (state.folder ? joinPath(state.folder.root, 'Untitled.md') : null), tab.content)
  if (!path) return false
  if (tab.path && tab.path !== path) api.unwatch(tab.path)
  tab.path = path
  tab.name = basename(path)
  tab.saved = tab.content
  tab.dirty = false
  api.watch(path)
  renderTabs()
  updateStatus('Saved')
  if (state.folder && path.startsWith(state.folder.root)) refreshTree()
  saveSession()
  return true
}

/** Save every modified tab; false if the user cancelled one (e.g. a Save As dialog). */
async function saveAllDirty () {
  const current = activeTab()
  if (current) current.content = editor.getValue()
  for (const tab of state.tabs) {
    if (tab.dirty && !(await saveTab(tab))) return false
  }
  return true
}

const autosave = debounce(() => {
  const tab = activeTab()
  if (state.settings.autosave && tab && tab.path && tab.dirty) saveTab(tab)
}, 900)

/* ------------------------------------------------------------ preview */

const mermaidCache = new Map()

async function renderMermaid (dark = state.dark) {
  const blocks = el.preview.querySelectorAll('.mermaid-block')
  if (!blocks.length) return
  for (const block of blocks) {
    const src = block.dataset.src || block.querySelector('.mermaid-source')?.textContent || ''
    if (!src.trim()) continue
    block.dataset.src = src
    if (block.dataset.rendered === String(dark)) continue
    block.dataset.rendered = String(dark)
    const key = src + '|' + dark
    if (mermaidCache.has(key)) { block.innerHTML = mermaidCache.get(key); continue }
    try {
      const id = 'mmd-' + Math.random().toString(36).slice(2, 9)
      const { svg } = await mermaid.render(id, src)
      mermaidCache.set(key, svg)
      block.innerHTML = svg
      block.classList.remove('error')
    } catch (e) {
      block.classList.add('error')
      const pre = document.createElement('pre')
      pre.textContent = 'Mermaid: ' + (e?.message || e)
      block.innerHTML = ''
      block.appendChild(pre)
    }
  }
  state.lineMap = []
}

function renderPreview (immediate = false) {
  const tab = activeTab()
  if (!tab) { el.preview.innerHTML = ''; return }
  const source = tab.id === state.activeId ? editor.getValue() : tab.content
  const html = renderMarkdown(md, source, { baseDir: tab.path ? dirname(tab.path) : null })
  el.preview.innerHTML = html
  decorateTables(tab)
  state.lineMap = []
  renderMermaid()
  const outline = extractOutline(source)
  state.outline = outline
  renderOutline(outline)
}

const scheduleRender = debounce((force) => renderPreview(force), 110)

function renderOutline (outline) {
  if (!outline.length) {
    el.sideOutline.innerHTML = '<div class="side-empty">این سند تیتری ندارد.<br><span style="opacity:.7">No headings in this document.</span></div>'
    return
  }
  el.sideOutline.innerHTML = ''
  for (const h of outline) {
    const btn = document.createElement('button')
    btn.className = 'outline-row h' + h.level
    btn.textContent = h.text
    btn.title = h.text
    btn.dir = 'auto'
    btn.addEventListener('click', () => {
      if (state.settings.viewMode === 'preview') {
        const target = el.preview.querySelector(`[id="${CSS.escape(h.id)}"]`) ||
          [...el.preview.querySelectorAll('[data-line]')].find((n) => Number(n.dataset.line) === h.line)
        if (target) el.previewScroll.scrollTo({ top: target.offsetTop - 24, behavior: 'smooth' })
      } else {
        editor.cursorToLine(h.line)
        syncPreviewFromEditor(true)
      }
    })
    el.sideOutline.appendChild(btn)
  }
}

/* ------------------------------------------------------ table columns */

/* Column widths are a view setting, like font size: they live in settings.json
   (per file, per table), never in the Markdown. A table is identified by its
   header row plus its position among tables with the same header, so editing
   text elsewhere in the file does not lose the widths. */

const MIN_COL = 48

function tableWidthsFor (tab, create = false) {
  if (!tab) return null
  if (!tab.path) {
    if (!tab.tableWidths && create) tab.tableWidths = {}
    return tab.tableWidths || null
  }
  const all = state.settings.tableWidths || (state.settings.tableWidths = {})
  if (!all[tab.path] && create) all[tab.path] = {}
  return all[tab.path] || null
}

function persistTableWidths (tab) {
  if (!tab?.path) return
  const all = state.settings.tableWidths
  if (all[tab.path] && !Object.keys(all[tab.path]).length) delete all[tab.path]
  api.settings.merge({ tableWidths: all })
}

const headerRow = (table) => table.tHead?.rows[0] || table.rows[0] || null

function setColumnWidths (table, widths) {
  let group = table.querySelector(':scope > colgroup')
  if (!group) { group = document.createElement('colgroup'); table.prepend(group) }
  const total = widths.reduce((a, b) => a + b, 0)
  group.replaceChildren(...widths.map((w) => {
    const col = document.createElement('col')
    col.style.width = (w / total * 100).toFixed(3) + '%'
    return col
  }))
  table.classList.add('has-colwidths')
  table.style.setProperty('--table-w', total.toFixed(1) + 'px')
}

function decorateTables (tab) {
  const saved = tableWidthsFor(tab) || {}
  const seen = new Map()
  for (const table of el.preview.querySelectorAll('table')) {
    const row = headerRow(table)
    if (!row) continue
    const head = [...row.cells].map((c) => c.textContent.trim()).join('|')
    const n = seen.get(head) || 0
    seen.set(head, n + 1)
    table.dataset.key = head + '#' + n
    const widths = saved[table.dataset.key]
    if (Array.isArray(widths) && widths.length === row.cells.length) setColumnWidths(table, widths)
    for (const cell of row.cells) {
      const handle = document.createElement('span')
      handle.className = 'col-resizer'
      handle.title = 'Drag to resize · double-click to reset'
      cell.appendChild(handle)
    }
  }
}

/** Narrowest each column can be without splitting a word: lay the table out once at min-content. */
function minContentWidths (table, cells) {
  const group = table.querySelector(':scope > colgroup')
  const fixed = table.classList.contains('has-colwidths')
  group?.remove()
  table.classList.remove('has-colwidths')
  const prev = table.style.width
  table.style.width = '1px'
  const mins = cells.map((c) => Math.ceil(c.getBoundingClientRect().width))
  table.style.width = prev
  if (group) table.prepend(group)
  if (fixed) table.classList.add('has-colwidths')
  return mins
}

function startColumnResize (e, handle) {
  e.preventDefault()
  e.stopPropagation()
  const cell = handle.parentElement
  const table = cell.closest('table')
  const wrap = table.closest('.table-wrap') || table.parentElement
  const cells = [...cell.parentElement.cells]
  const index = cells.indexOf(cell)
  const rtl = getComputedStyle(wrap).direction === 'rtl'
  // +3: fixed layout loses a pixel or two to collapsed borders and percentage rounding
  const mins = minContentWidths(table, cells).map((m) => Math.max(MIN_COL, m + 3))
  const base = cells.map((c, j) => Math.max(mins[j], c.getBoundingClientRect().width))
  const sum = (list) => list.reduce((a, b) => a + b, 0)
  // the table may grow until it fills the column (or stays as wide as it already was);
  // past that, a wider column takes the space from its neighbours, nearest first
  const pad = getComputedStyle(wrap)
  const room = wrap.clientWidth - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight)
  const maxTotal = Math.max(room, sum(base))
  const keys = [...base.keys()]
  const donors = keys.filter((j) => j > index).concat(keys.filter((j) => j < index).reverse())
  let widths = base.slice()
  const startX = e.clientX
  const start = base[index]
  const tab = activeTab()
  handle.classList.add('dragging')
  el.preview.classList.add('resizing-cols')

  const move = (ev) => {
    const dx = rtl ? startX - ev.clientX : ev.clientX - startX
    const next = base.slice()
    next[index] = Math.max(mins[index], start + dx)
    let excess = sum(next) - maxTotal
    for (const j of donors) {
      if (excess <= 0) break
      const give = Math.min(excess, Math.max(0, next[j] - mins[j]))
      next[j] -= give
      excess -= give
    }
    if (excess > 0) next[index] -= excess
    widths = next
    setColumnWidths(table, widths)
  }
  const up = () => {
    document.removeEventListener('mousemove', move)
    document.removeEventListener('mouseup', up)
    handle.classList.remove('dragging')
    el.preview.classList.remove('resizing-cols')
    state.lineMap = []
    if (widths.every((w, j) => w === base[j])) return
    tableWidthsFor(tab, true)[table.dataset.key] = widths.map((w) => Math.round(w))
    persistTableWidths(tab)
  }
  document.addEventListener('mousemove', move)
  document.addEventListener('mouseup', up)
}

function resetColumnWidths (handle) {
  const table = handle.closest('table')
  const tab = activeTab()
  const saved = tableWidthsFor(tab)
  if (saved) { delete saved[table.dataset.key]; persistTableWidths(tab) }
  table.querySelector(':scope > colgroup')?.remove()
  table.classList.remove('has-colwidths')
  table.style.removeProperty('--table-w')
  state.lineMap = []
}

/* ------------------------------------------------------------ copying */

/** The preview as a reader sees it, minus the app's own controls. */
function cleanPreviewClone () {
  const clone = el.preview.cloneNode(true)
  clone.querySelectorAll('.copy-btn, .heading-anchor, .col-resizer, .code-lang, .mermaid-source, .fm-raw')
    .forEach((n) => n.remove())
  // KaTeX markup only makes sense with its stylesheet; carry the TeX source instead
  clone.querySelectorAll('[data-tex]').forEach((m) => {
    const display = m.tagName === 'DIV'
    const node = document.createElement(display ? 'p' : 'span')
    node.setAttribute('dir', 'ltr')
    node.textContent = display ? `$$${m.dataset.tex}$$` : `$${m.dataset.tex}$`
    m.replaceWith(node)
  })
  // front-matter tags are separate badges on screen; as text they need separators
  clone.querySelectorAll('.fm-card dd').forEach((dd) => {
    const tags = [...dd.querySelectorAll('.fm-tag')].map((t) => t.textContent)
    if (tags.length) dd.textContent = tags.join(' · ')
  })
  clone.querySelectorAll('[data-line], [data-key], [data-rendered], [data-src]').forEach((n) => {
    n.removeAttribute('data-line'); n.removeAttribute('data-key'); n.removeAttribute('data-rendered'); n.removeAttribute('data-src')
  })
  return clone
}

/* Pasted into Word / Google Docs / mail, class names mean nothing: give the
   few things that need it a minimal inline style. */
const PASTE_STYLES = {
  table: 'border-collapse:collapse;margin:8px 0',
  'th, td': 'border:1px solid #c9ccd1;padding:4px 10px;vertical-align:middle',
  th: 'background:#f2f2f0;font-weight:bold',
  pre: 'background:#f4f4f2;padding:10px 12px;border-radius:6px;direction:ltr;text-align:left;white-space:pre-wrap;font-family:Menlo,Consolas,monospace;font-size:12px',
  code: 'font-family:Menlo,Consolas,monospace;direction:ltr;unicode-bidi:isolate',
  blockquote: 'border-inline-start:3px solid #c9ccd1;margin:8px 0;padding:2px 12px;color:#4b5058',
  mark: 'background:#fff2a8'
}

async function copyPreview ({ source = false } = {}) {
  const tab = activeTab()
  if (!tab) return
  if (source) {
    await writeClipboard({ text: editor.getValue() })
    flashCopied('Markdown copied')
    return
  }
  const clone = cleanPreviewClone()
  for (const [sel, css] of Object.entries(PASTE_STYLES)) {
    clone.querySelectorAll(sel).forEach((n) => { n.setAttribute('style', css + ';' + (n.getAttribute('style') || '')) })
  }
  const dir = state.settings.direction === 'auto' ? tab.dir : state.settings.direction
  const html = `<div dir="${dir}" style="font-family:Estedad,Tahoma,sans-serif;line-height:1.8">${clone.innerHTML}</div>`

  // innerText only follows the layout (table cells → tabs, blocks → newlines)
  // for an element that is actually rendered, so measure the clone off-screen
  const probe = cleanPreviewClone()
  probe.className = 'markdown-body'
  probe.style.cssText = 'position:fixed;left:-20000px;top:0;width:800px;max-width:none'
  document.body.appendChild(probe)
  const text = probe.innerText.replace(/\n{3,}/g, '\n\n').trim()
  probe.remove()

  await writeClipboard({ text, html })
  flashCopied('Copied')
}

/** Rich + plain text in one clipboard entry: Word/Docs take the HTML, plain editors the text. */
async function writeClipboard ({ text, html = null }) {
  try {
    const parts = { 'text/plain': new Blob([text], { type: 'text/plain' }) }
    if (html) parts['text/html'] = new Blob([html], { type: 'text/html' })
    await navigator.clipboard.write([new ClipboardItem(parts)])
  } catch (e) {
    toast('Copy failed: ' + e.message, 'error')
    throw e
  }
}

function flashCopied (label) {
  const btn = el.ptCopy
  const text = btn.querySelector('.pt-label')
  btn.classList.add('done')
  text.textContent = label
  clearTimeout(btn._t)
  btn._t = setTimeout(() => { btn.classList.remove('done'); text.textContent = 'Copy' }, 1400)
}

/* -------------------------------------------------------- scroll sync */

function buildLineMap () {
  const nodes = el.preview.querySelectorAll('[data-line]')
  const map = []
  for (const node of nodes) {
    const line = Number(node.dataset.line)
    if (Number.isNaN(line)) continue
    map.push({ line, top: node.offsetTop, height: node.offsetHeight })
  }
  map.sort((a, b) => a.line - b.line)
  state.lineMap = map
  return map
}

function lineMap () {
  return state.lineMap.length ? state.lineMap : buildLineMap()
}

function lockSync (source) {
  state.syncSource = source
  clearTimeout(state.syncTimer)
  state.syncTimer = setTimeout(() => { state.syncSource = null }, 220)
}

function syncPreviewFromEditor (force = false) {
  if (state.settings.viewMode !== 'split' && !force) return
  if (state.syncSource === 'preview' && !force) return
  const map = lineMap()
  if (!map.length) return
  const { line, frac } = editor.topLineFraction()
  let i = 0
  while (i < map.length - 1 && map[i + 1].line <= line) i++
  const cur = map[i]
  const next = map[i + 1]
  let top
  if (next && next.line > cur.line) {
    const ratio = Math.min(1, Math.max(0, (line + frac - cur.line) / (next.line - cur.line)))
    top = cur.top + (next.top - cur.top) * ratio
  } else {
    top = cur.top + cur.height * frac
  }
  lockSync('editor')
  el.previewScroll.scrollTop = Math.max(0, top - 40)
}

function syncEditorFromPreview () {
  if (state.settings.viewMode !== 'split') return
  if (state.syncSource === 'editor') return
  const map = lineMap()
  if (!map.length) return
  const y = el.previewScroll.scrollTop + 40
  let i = 0
  while (i < map.length - 1 && map[i + 1].top <= y) i++
  const cur = map[i]
  const next = map[i + 1]
  let line = cur.line
  if (next && next.top > cur.top) {
    const ratio = Math.min(1, Math.max(0, (y - cur.top) / (next.top - cur.top)))
    line = cur.line + (next.line - cur.line) * ratio
  }
  lockSync('preview')
  editor.scrollToLine(Math.round(line))
}

/* ------------------------------------------------------------- status */

function updateStatus (flash = null) {
  const tab = activeTab()
  if (!tab) {
    el.stPath.textContent = ''
    el.stStats.textContent = ''
    el.stCursor.textContent = ''
    el.stSaved.textContent = ''
    document.title = 'MashDavood'
    return
  }
  const source = tab.id === state.activeId ? editor.getValue() : tab.content
  const st = documentStats(source)
  el.stPath.textContent = tab.path ? tab.path.replace(state.home || '~', '~') : 'Untitled — not saved yet'
  el.stStats.textContent = `${st.words.toLocaleString()} words · ${st.minutes} min read`
  el.stSaved.textContent = flash || (tab.dirty ? 'Unsaved' : tab.path ? 'Saved' : '')
  el.stSaved.classList.toggle('dirty', !!tab.dirty)
  document.title = (tab.dirty ? '• ' : '') + tab.name + ' — MashDavood'
  if (flash) setTimeout(() => { if (el.stSaved.textContent === flash) updateStatus() }, 1400)
}

/* --------------------------------------------------------- file tree */

function renderTree () {
  const wrap = el.sideFiles
  wrap.innerHTML = ''
  if (!state.folder) {
    wrap.innerHTML = '<div class="side-empty">هیچ پوشه‌ای باز نیست.<br><button id="tree-open">Open Folder…</button></div>'
    wrap.querySelector('#tree-open').addEventListener('click', () => api.openFolderDialog())
    return
  }
  const rootRow = document.createElement('div')
  rootRow.className = 'tree-row'
  rootRow.style.fontWeight = '700'
  rootRow.style.color = 'var(--text)'
  rootRow.innerHTML = '<span class="caret"></span><span class="label"></span>'
  rootRow.querySelector('.label').textContent = basename(state.folder.root)
  rootRow.title = state.folder.root
  rootRow.addEventListener('dblclick', () => api.reveal(state.folder.root))
  wrap.appendChild(rootRow)
  wrap.appendChild(buildNodes(state.folder.tree, 0))
  markActiveInTree()
}

function matchesFilter (node) {
  if (!state.filter) return true
  const f = state.filter.toLowerCase()
  if (node.type === 'file') return node.name.toLowerCase().includes(f)
  return node.children.some(matchesFilter)
}

function buildNodes (nodes, depth) {
  const frag = document.createDocumentFragment()
  for (const node of nodes) {
    if (!matchesFilter(node)) continue
    const row = document.createElement('div')
    row.className = 'tree-row'
    row.style.paddingInlineStart = 6 + depth * 13 + 'px'
    row.dataset.path = node.path
    const caret = node.type === 'dir'
      ? `<span class="caret${state.expanded.has(node.path) || state.filter ? ' open' : ''}"><svg viewBox="0 0 12 12" width="10" height="10"><path d="M4 2.5 8 6l-4 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></span>`
      : '<span class="caret"></span>'
    row.innerHTML = caret + '<span class="label"></span>'
    row.querySelector('.label').textContent = node.name
    row.title = node.path
    frag.appendChild(row)

    if (node.type === 'dir') {
      const children = document.createElement('div')
      children.className = 'tree-children'
      const open = state.expanded.has(node.path) || !!state.filter
      children.style.display = open ? '' : 'none'
      children.appendChild(buildNodes(node.children, depth + 1))
      frag.appendChild(children)
      row.addEventListener('click', () => {
        const isOpen = children.style.display !== 'none'
        children.style.display = isOpen ? 'none' : ''
        row.querySelector('.caret').classList.toggle('open', !isOpen)
        if (isOpen) state.expanded.delete(node.path); else state.expanded.add(node.path)
      })
    } else {
      row.addEventListener('click', () => openFile(node.path))
      row.addEventListener('dblclick', () => api.reveal(node.path))
    }
  }
  return frag
}

function markActiveInTree () {
  const path = activeTab()?.path
  el.sideFiles.querySelectorAll('.tree-row').forEach((r) => r.classList.toggle('active', !!path && r.dataset.path === path))
}

async function refreshTree () {
  if (!state.folder) return
  const res = await api.readTree(state.folder.root)
  state.folder = res
  renderTree()
}

/* --------------------------------------------------------- export/print */

function collectCss () {
  let css = ''
  for (const sheet of document.styleSheets) {
    let rules
    try { rules = sheet.cssRules } catch { continue }
    for (const rule of rules) {
      const text = rule.cssText
      if (!text) continue
      if (text.startsWith('@font-face')) continue                 // main process injects the font
      if (text.includes("[data-theme='dark']") || text.includes('[data-theme="dark"]')) continue
      if (text.startsWith('.cm-') || text.includes(' .cm-')) continue
      css += text + '\n'
    }
  }
  // make relative asset URLs absolute so they still resolve outside the app
  css = css.replace(/url\((['"]?)(?!data:|https?:|file:)([^'")]+)\1\)/g, (m, q, url) => {
    try { return `url("${new URL(url, document.baseURI).href}")` } catch { return m }
  })
  return css
}

/** Preview markup for export: the colgroup widths stay, the drag handles go. */
function exportBody () {
  const clone = el.preview.cloneNode(true)
  clone.querySelectorAll('.col-resizer').forEach((n) => n.remove())
  return clone.innerHTML
}

async function doExport (kind, outPath = null) {
  const tab = activeTab()
  if (!tab) return
  renderPreview(true)
  await new Promise((r) => setTimeout(r, 300))     // let mermaid finish
  // exports are always on a light page, so diagrams get the light palette too
  if (state.dark) {
    mermaid.initialize(mermaidConfig(false))
    await renderMermaid(false)
  }
  const title = tab.name.replace(/\.[^.]+$/, '')
  const payload = {
    title,
    body: exportBody(),
    css: collectCss(),
    dir: state.settings.direction === 'auto' ? tab.dir : state.settings.direction,
    typography: {
      fontSize: state.settings.fontSize,
      lineHeight: state.settings.lineHeight,
      justify: !!state.settings.justify
    },
    defaultPath: tab.path ? tab.path.replace(/\.[^.]+$/, '') + (kind === 'pdf' ? '.pdf' : '.html') : null,
    outPath
  }
  try {
    const out = kind === 'pdf' ? await api.exportPdf(payload) : await api.exportHtml(payload)
    if (out) toast(`Exported → ${basename(out)}`)
  } catch (e) {
    toast('Export failed: ' + e.message, 'error')
  } finally {
    if (state.dark) {
      mermaid.initialize(mermaidConfig(true))
      await renderMermaid(true)
    }
  }
}

/* -------------------------------------------------------------- modals */

function openModal (html, afterMount) {
  el.modal.innerHTML = html
  el.modalBackdrop.classList.remove('hidden')
  afterMount?.(el.modal)
  const close = () => el.modalBackdrop.classList.add('hidden')
  el.modal.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close))
  el.modalBackdrop.onclick = (e) => { if (e.target === el.modalBackdrop) close() }
  return close
}

function settingsModal () {
  const s = state.settings
  const closeSettings = () => el.modalBackdrop.classList.add('hidden')
  openModal(`
    <h2>Settings</h2>
    <div class="row"><label>Theme<span class="hint">تم روشن، تیره یا تبعیت از سیستم</span></label>
      <select id="set-theme">
        <option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option>
      </select></div>
    <div class="row"><label>Default text direction<span class="hint">جهت پیش‌فرض متن</span></label>
      <select id="set-dir"><option value="auto">Auto</option><option value="rtl">RTL</option><option value="ltr">LTR</option></select></div>
    <div class="row"><label>Preview font size<span class="hint">اندازه فونت پیش‌نمایش</span></label>
      <span><input type="range" id="set-fs" min="12" max="26" step="0.5"> <b id="set-fs-v"></b></span></div>
    <div class="row"><label>Editor font<span class="hint">فونت ویرایشگر — «خودکار» یعنی استعداد برای متن راست‌به‌چپ</span></label>
      <select id="set-efont"><option value="auto">Auto</option><option value="estedad">Estedad</option><option value="mono">Monospace</option></select></div>
    <div class="row"><label>Editor font size</label>
      <span><input type="range" id="set-efs" min="11" max="22" step="0.5"> <b id="set-efs-v"></b></span></div>
    <div class="row"><label>Line height<span class="hint">فاصله خطوط — برای فارسی مقدار بیشتر بهتر است</span></label>
      <span><input type="range" id="set-lh" min="1.4" max="2.4" step="0.05"> <b id="set-lh-v"></b></span></div>
    <div class="row"><label>Content width</label>
      <span><input type="range" id="set-cw" min="560" max="1100" step="10"> <b id="set-cw-v"></b></span></div>
    <div class="row"><label>Autosave<span class="hint">ذخیره خودکار پس از توقف تایپ</span></label>
      <input type="checkbox" id="set-autosave"></div>
    <div class="row"><label>Spellcheck in editor</label><input type="checkbox" id="set-spell"></div>
    <div class="row"><label>Justify paragraphs<span class="hint">تراز دوطرفه در پیش‌نمایش و خروجی</span></label>
      <input type="checkbox" id="set-justify"></div>
    <div class="row"><label>Check for updates automatically<span class="hint">اطلاع از نسخه‌ی جدید هنگام باز شدن برنامه</span></label>
      <input type="checkbox" id="set-updates"></div>
    <div class="row"><label>Version<span class="hint">نسخه‌ی نصب‌شده</span></label>
      <span><span class="version" id="set-version"></span><button class="small" id="set-check">Check now</button></span></div>
    <div class="modal-foot"><button data-close>Done</button></div>
  `, (root) => {
    const bind = (id, key, fmt = (v) => v, apply = () => {}) => {
      const input = root.querySelector('#set-' + id)
      const label = root.querySelector('#set-' + id + '-v')
      input.value = s[key]
      if (label) label.textContent = fmt(s[key])
      input.addEventListener('input', () => {
        const v = input.type === 'range' ? Number(input.value) : input.value
        s[key] = v
        if (label) label.textContent = fmt(v)
        api.settings.merge({ [key]: v })
        apply(v)
      })
    }
    root.querySelector('#set-theme').value = s.theme
    root.querySelector('#set-theme').addEventListener('change', (e) => applyTheme(e.target.value))
    root.querySelector('#set-dir').value = s.direction
    root.querySelector('#set-dir').addEventListener('change', (e) => setDirection(e.target.value))
    root.querySelector('#set-efont').value = s.editorFont || 'auto'
    root.querySelector('#set-efont').addEventListener('change', (e) => {
      s.editorFont = e.target.value
      api.settings.merge({ editorFont: e.target.value })
      applyTypography()
    })
    bind('fs', 'fontSize', (v) => v + 'px', applyTypography)
    bind('efs', 'editorFontSize', (v) => v + 'px', applyTypography)
    bind('lh', 'lineHeight', (v) => Number(v).toFixed(2), applyTypography)
    bind('cw', 'contentWidth', (v) => v + 'px', applyTypography)
    const auto = root.querySelector('#set-autosave')
    auto.checked = !!s.autosave
    auto.addEventListener('change', () => { s.autosave = auto.checked; api.settings.merge({ autosave: auto.checked }) })
    const spell = root.querySelector('#set-spell')
    spell.checked = !!s.spellcheck
    spell.addEventListener('change', () => { s.spellcheck = spell.checked; api.settings.merge({ spellcheck: spell.checked }); editor.setSpellcheck(spell.checked) })
    const justify = root.querySelector('#set-justify')
    justify.checked = !!s.justify
    justify.addEventListener('change', () => setReadingOption('justify', justify.checked))
    const updates = root.querySelector('#set-updates')
    updates.checked = s.checkUpdates !== false
    updates.addEventListener('change', () => { s.checkUpdates = updates.checked; api.settings.merge({ checkUpdates: updates.checked }) })
    root.querySelector('#set-version').textContent = 'v' + (state.version || '')
    root.querySelector('#set-check').addEventListener('click', () => { closeSettings(); checkForUpdates() })
  })
}

/* ------------------------------------------------- quick reading panel */

const QUICK_DEFAULTS = { fontSize: 16, lineHeight: 1.9, contentWidth: 780, justify: false }

function setReadingOption (key, value) {
  state.settings[key] = value
  api.settings.merge({ [key]: value })
  applyTypography()
  state.lineMap = []
}

function renderQuickPanel () {
  const s = state.settings
  const dir = s.direction
  el.quickPanel.innerHTML = `
    <div class="qp-row"><span class="qp-label">Direction<small>جهت متن</small></span>
      <div class="segmented" id="qp-dir">
        ${['auto', 'rtl', 'ltr'].map((d) => `<button data-dir="${d}" class="${d === dir ? 'active' : ''}">${d === 'auto' ? 'Auto' : d.toUpperCase()}</button>`).join('')}
      </div></div>
    <div class="qp-row"><span class="qp-label">Font size<small>اندازه فونت</small></span>
      <span class="qp-step" data-key="fontSize" data-step="1" data-min="11" data-max="30" data-unit="px">
        <button data-d="-1" aria-label="Smaller">−</button><output></output><button data-d="1" aria-label="Larger">+</button></span></div>
    <div class="qp-row"><span class="qp-label">Line height<small>فاصله خطوط</small></span>
      <span class="qp-step" data-key="lineHeight" data-step="0.1" data-min="1.3" data-max="2.6" data-unit="">
        <button data-d="-1" aria-label="Tighter">−</button><output></output><button data-d="1" aria-label="Looser">+</button></span></div>
    <div class="qp-row"><span class="qp-label">Width<small>عرض متن</small></span>
      <span class="qp-step" data-key="contentWidth" data-step="40" data-min="560" data-max="1240" data-unit="px">
        <button data-d="-1" aria-label="Narrower">−</button><output></output><button data-d="1" aria-label="Wider">+</button></span></div>
    <div class="qp-row"><span class="qp-label">Justify<small>تراز دوطرفه پاراگراف‌ها</small></span>
      <input type="checkbox" class="qp-switch" id="qp-justify" ${s.justify ? 'checked' : ''}></div>
    <div class="qp-foot"><button id="qp-reset">Reset · پیش‌فرض</button><button id="qp-more">More settings…</button></div>`

  const sync = () => el.quickPanel.querySelectorAll('.qp-step').forEach((step) => {
    const v = Number(state.settings[step.dataset.key])
    step.querySelector('output').textContent = (step.dataset.key === 'lineHeight' ? v.toFixed(1) : v) + step.dataset.unit
  })
  sync()
  el.quickPanel.querySelectorAll('.qp-step button').forEach((b) => b.addEventListener('click', () => {
    const step = b.closest('.qp-step')
    const { key } = step.dataset
    const inc = Number(step.dataset.step) * Number(b.dataset.d)
    const next = Math.min(Number(step.dataset.max), Math.max(Number(step.dataset.min), Number(state.settings[key]) + inc))
    setReadingOption(key, Math.round(next * 100) / 100)
    sync()
  }))
  el.quickPanel.querySelectorAll('#qp-dir button').forEach((b) => b.addEventListener('click', () => {
    setDirection(b.dataset.dir)
    el.quickPanel.querySelectorAll('#qp-dir button').forEach((x) => x.classList.toggle('active', x === b))
  }))
  el.quickPanel.querySelector('#qp-justify').addEventListener('change', (e) => setReadingOption('justify', e.target.checked))
  el.quickPanel.querySelector('#qp-reset').addEventListener('click', () => {
    Object.assign(state.settings, QUICK_DEFAULTS)
    api.settings.merge(QUICK_DEFAULTS)
    applyTypography()
    renderQuickPanel()
  })
  el.quickPanel.querySelector('#qp-more').addEventListener('click', () => { toggleQuickPanel(false); settingsModal() })
}

function toggleQuickPanel (open = el.quickPanel.classList.contains('hidden')) {
  if (open) {
    if (state.settings.viewMode === 'editor') setViewMode('split')
    renderQuickPanel()
  }
  el.quickPanel.classList.toggle('hidden', !open)
  el.previewTools.classList.toggle('open', open)
  el.ptQuick.classList.toggle('on', open)
}

function shortcutsModal () {
  const rows = [
    ['Open file / folder', '⌘O / ⇧⌘O'], ['New file', '⌘N'], ['Save / Save as', '⌘S / ⇧⌘S'],
    ['Close tab', '⌘W'], ['Next / previous tab', '⌃Tab / ⌃⇧Tab'],
    ['Editor · Split · Preview', '⌘1 · ⌘2 · ⌘3'], ['Toggle sidebar', '⌘\\'], ['Toggle theme', '⇧⌘L'],
    ['Direction: auto / RTL / LTR', '⇧⌘A / ⇧⌘R / ⇧⌘D'],
    ['Find in document', '⌘F'], ['Bold / Italic / Link', '⌘B / ⌘I / ⌘K'],
    ['Inline code / Code block', '⇧⌘C / ⌥⌘C'], ['Heading 1–3', '⌥⌘1–3'],
    ['Bullet / numbered / task list', '⇧⌘8 / ⇧⌘7 / ⇧⌘9'], ['Quote', '⇧⌘.'],
    ['Table / Mermaid diagram', '⌥⌘T / ⌥⌘M'], ['Export PDF / HTML', '⌘P / ⇧⌘E'],
    ['Zoom in / out / reset', '⌘+ / ⌘− / ⌘0'], ['Reveal in Finder', '⌥⌘R'],
    ['Copy document as shown / as Markdown', '⌥⇧⌘C / ⌥⇧⌘M'], ['Reading settings panel', '⌥⌘,']
  ]
  openModal(`<h2>Keyboard Shortcuts</h2><table>${rows.map(([a, b]) => `<tr><td>${a}</td><td>${keys(b)}</td></tr>`).join('')}</table><div class="modal-foot"><button data-close>Close</button></div>`)
}

/* ------------------------------------------------------- menu actions */

const formatters = {
  'fmt:bold': () => editor.wrap('**'),
  'fmt:italic': () => editor.wrap('*'),
  'fmt:strike': () => editor.wrap('~~'),
  'fmt:code': () => editor.wrap('`'),
  'fmt:link': () => editor.insertLink(),
  'fmt:h1': () => editor.toggleHeading(1),
  'fmt:h2': () => editor.toggleHeading(2),
  'fmt:h3': () => editor.toggleHeading(3),
  'fmt:ul': () => editor.toggleLinePrefix('- '),
  'fmt:ol': () => editor.toggleLinePrefix('', { ordered: true }),
  'fmt:task': () => editor.toggleLinePrefix('- [ ] '),
  'fmt:quote': () => editor.toggleLinePrefix('> '),
  'fmt:codeblock': () => editor.insertBlock('```\n\n```'),
  'fmt:table': () => editor.insertBlock('| ستون ۱ | ستون ۲ |\n|---|---|\n|  |  |'),
  'fmt:mermaid': () => editor.insertBlock('```mermaid\nflowchart TD\n    A[شروع] --> B[پایان]\n```')
}

async function handleMenu ({ action }) {
  if (formatters[action]) { if (activeTab()) formatters[action](); return }
  switch (action) {
    case 'new': newTab(''); break
    case 'save': saveTab(activeTab()); break
    case 'saveAs': saveTabAs(activeTab()); break
    case 'closeTab': if (state.activeId) closeTab(state.activeId); break
    case 'find': editor.openSearch(); break
    case 'settings': settingsModal(); break
    case 'shortcuts': shortcutsModal(); break
    case 'welcome': newTab(WELCOME_DOC, 'Welcome.md'); break
    case 'reveal': { const t = activeTab(); if (t?.path) api.reveal(t.path); break }
    case 'exportPdf': doExport('pdf'); break
    case 'exportHtml': doExport('html'); break
    case 'view:editor': setViewMode('editor'); break
    case 'view:split': setViewMode('split'); break
    case 'view:preview': setViewMode('preview'); break
    case 'toggleSidebar': setSidebar(!state.settings.sidebarVisible); break
    case 'toggleTheme': applyTheme(state.dark ? 'light' : 'dark'); break
    case 'dir:auto': setDirection('auto'); break
    case 'dir:rtl': setDirection('rtl'); break
    case 'dir:ltr': setDirection('ltr'); break
    case 'tab:next': cycleTab(1); break
    case 'tab:prev': cycleTab(-1); break
    case 'zoom:in': zoom(1); break
    case 'zoom:out': zoom(-1); break
    case 'zoom:reset': zoom(0); break
    case 'copyRendered': copyPreview(); break
    case 'copyMarkdown': copyPreview({ source: true }); break
    case 'quickSettings': toggleQuickPanel(); break
    case 'checkUpdates': checkForUpdates(); break
  }
}

function zoom (delta) {
  const s = state.settings
  if (delta === 0) { s.fontSize = 16; s.editorFontSize = 14.5 }
  else {
    s.fontSize = Math.min(30, Math.max(11, s.fontSize + delta))
    s.editorFontSize = Math.min(26, Math.max(10, s.editorFontSize + delta))
  }
  applyTypography()
  api.settings.merge({ fontSize: s.fontSize, editorFontSize: s.editorFontSize })
}

/* ------------------------------------------------------------- wiring */

function wireUi () {
  $('#btn-sidebar').addEventListener('click', () => setSidebar(!state.settings.sidebarVisible))
  $('#btn-theme').addEventListener('click', () => applyTheme(state.dark ? 'light' : 'dark'))
  $('#btn-settings').addEventListener('click', settingsModal)
  $('#btn-open-folder').addEventListener('click', () => api.openFolderDialog())
  el.viewmode.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => setViewMode(b.dataset.mode)))
  el.stDir.addEventListener('click', () => {
    const order = ['auto', 'rtl', 'ltr']
    setDirection(order[(order.indexOf(state.settings.direction) + 1) % 3])
  })

  $('#es-open').addEventListener('click', () => api.openFileDialog())
  $('#es-folder').addEventListener('click', () => api.openFolderDialog())
  $('#es-new').addEventListener('click', () => newTab(''))

  document.querySelectorAll('.side-switch button').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.side-switch button').forEach((x) => x.classList.toggle('active', x === b))
      const panel = b.dataset.panel
      state.settings.sidebarTab = panel
      api.settings.merge({ sidebarTab: panel })
      el.sideFiles.classList.toggle('hidden', panel !== 'files')
      el.sideOutline.classList.toggle('hidden', panel !== 'outline')
      el.sideSearchWrap.style.display = panel === 'files' ? '' : 'none'
    })
  })

  el.sideSearch.addEventListener('input', () => { state.filter = el.sideSearch.value.trim(); renderTree() })

  // floating preview tools: copy + reading settings
  el.ptCopy.addEventListener('click', (e) => copyPreview({ source: e.shiftKey }))
  el.ptQuick.addEventListener('click', () => toggleQuickPanel())
  document.addEventListener('mousedown', (e) => {
    if (!el.quickPanel.classList.contains('hidden') && !e.target.closest('#preview-tools')) toggleQuickPanel(false)
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.quickPanel.classList.contains('hidden')) { toggleQuickPanel(false); e.preventDefault() }
  })

  // column resizing in preview tables
  el.preview.addEventListener('mousedown', (e) => {
    const handle = e.target.closest('.col-resizer')
    if (handle && e.button === 0) startColumnResize(e, handle)
  })

  // preview interactions
  el.preview.addEventListener('click', (e) => {
    if (e.target.closest('.col-resizer')) { e.preventDefault(); return }
    const copy = e.target.closest('[data-copy]')
    if (copy) {
      const code = copy.closest('.code-wrap')?.querySelector('code')
      if (code) { navigator.clipboard.writeText(code.textContent); copy.textContent = 'copied'; setTimeout(() => (copy.textContent = 'copy'), 1200) }
      return
    }
    const link = e.target.closest('a')
    if (!link) return
    const href = link.getAttribute('href') || ''
    if (link.dataset.external || /^https?:/i.test(href)) { e.preventDefault(); api.openExternal(href) }
    else if (href.startsWith('#')) {
      e.preventDefault()
      const target = el.preview.querySelector(`[id="${CSS.escape(href.slice(1))}"]`)
      if (target) el.previewScroll.scrollTo({ top: target.offsetTop - 24, behavior: 'smooth' })
    } else if (link.dataset.relative) {
      e.preventDefault()
      const tab = activeTab()
      if (!tab?.path) return
      let resolved = decodeURI(new URL(toFileUrl(dirname(tab.path), link.dataset.relative)).pathname)
      if (api.platform === 'win32') resolved = resolved.replace(/^\//, '').replace(/\//g, '\\')
      if (/\.(md|markdown|mdown|mkd|txt)$/i.test(resolved)) openFile(resolved)
      else api.openPath(resolved)
    }
  })

  // double click in preview jumps the editor to that line
  el.preview.addEventListener('dblclick', (e) => {
    const handle = e.target.closest('.col-resizer')
    if (handle) { e.preventDefault(); resetColumnWidths(handle); return }
    const node = e.target.closest('[data-line]')
    if (!node || state.settings.viewMode === 'preview') return
    editor.cursorToLine(Number(node.dataset.line))
  })

  el.previewScroll.addEventListener('scroll', () => syncEditorFromPreview(), { passive: true })

  // drag & drop
  window.addEventListener('dragover', (e) => { e.preventDefault() })
  window.addEventListener('drop', (e) => {
    e.preventDefault()
    const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f) || f.path).filter(Boolean)
    if (paths.length) api.openPaths(paths)
  })

  // sidebar + split resizers
  makeResizer($('#sidebar-resizer'), (dx, startW) => {
    const w = Math.min(460, Math.max(170, startW + dx))
    el.sidebar.style.width = w + 'px'
    state.settings.sidebarWidth = w
    return w
  }, () => el.sidebar.offsetWidth, (w) => api.settings.merge({ sidebarWidth: w }))

  makeResizer($('#pane-resizer'), (dx, startW) => {
    const total = el.panes.offsetWidth
    const w = Math.min(total - 220, Math.max(220, startW + dx))
    el.paneEditor.style.flex = `0 0 ${w}px`
    state.settings.splitRatio = w / total
    state.lineMap = []
    return state.settings.splitRatio
  }, () => el.paneEditor.offsetWidth, (r) => api.settings.merge({ splitRatio: r }))

  window.addEventListener('resize', debounce(() => { state.lineMap = [] }, 150))
  window.addEventListener('beforeunload', () => { const t = activeTab(); if (t) t.content = editor.getValue(); saveSession() })
}

function makeResizer (node, onMove, getStart, onEnd) {
  let startX = 0
  let startVal = 0
  let latest = null
  const move = (e) => { latest = onMove(e.clientX - startX, startVal) }
  const up = () => {
    node.classList.remove('dragging')
    document.removeEventListener('mousemove', move)
    document.removeEventListener('mouseup', up)
    document.body.style.cursor = ''
    if (latest !== null) onEnd?.(latest)
  }
  node.addEventListener('mousedown', (e) => {
    e.preventDefault()
    startX = e.clientX
    startVal = getStart()
    node.classList.add('dragging')
    document.body.style.cursor = 'col-resize'
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
  })
}

function wireIpc () {
  api.on('menu:action', handleMenu)
  api.on('app:openFiles', (files) => { files.forEach((f, i) => openFile(f.path, f.content)) })
  api.on('app:openFolder', ({ root, tree }) => {
    state.folder = { root, tree }
    state.expanded.clear()
    renderTree()
    setSidebar(true)
    saveSession()
  })
  api.on('file:changed', ({ path, content }) => {
    const tab = state.tabs.find((t) => t.path === path)
    if (!tab) return
    const current = tab.id === state.activeId ? editor.getValue() : tab.content
    if (current === content) return
    if (tab.dirty) { toast(`“${tab.name}” changed on disk — your unsaved copy was kept.`); return }
    tab.content = content
    tab.saved = content
    tab.dir = detectDirection(content)
    if (tab.id === state.activeId) {
      const top = editor.getScrollInfo().top
      editor.replaceAll(content)
      tab.editorState = editor.state
      requestAnimationFrame(() => editor.setScrollTop(top))
      renderPreview(true)
    }
    toast(`“${tab.name}” reloaded from disk`)
  })
  api.on('file:removed', ({ path }) => {
    const tab = state.tabs.find((t) => t.path === path)
    if (tab) { tab.dirty = true; renderTabs(); toast(`“${tab.name}” was removed or moved on disk`, 'error') }
  })
  api.on('theme:changed', (dark) => { if (state.settings.theme === 'system') setDarkClass(dark) })
}

function renderRecent (settings) {
  const files = (settings.recentFiles || []).slice(0, 6)
  if (!files.length) { el.emptyRecent.innerHTML = ''; return }
  el.emptyRecent.innerHTML = '<div class="rc-title">Recent</div>'
  for (const f of files) {
    const b = document.createElement('button')
    b.textContent = f.replace(state.home, '~')
    b.title = f
    b.addEventListener('click', () => openFile(f))
    el.emptyRecent.appendChild(b)
  }
}

/* ---------------------------------------------------------------- boot */

async function boot () {
  const { settings, queued, home, version } = await api.ready()
  state.settings = settings
  state.home = home
  state.version = version

  applyTypography()
  await applyTheme(settings.theme)
  setSidebar(settings.sidebarVisible)
  el.sidebar.style.width = (settings.sidebarWidth || 250) + 'px'
  el.app.dataset.view = settings.viewMode
  setViewMode(settings.viewMode)
  setDirection(settings.direction)
  if (settings.sidebarTab === 'outline') document.querySelector('.side-switch button[data-panel="outline"]').click()

  editor = new MarkdownEditor(el.editorHost, {
    spellcheck: settings.spellcheck,
    onChange: (value) => {
      const tab = activeTab()
      if (!tab) return
      tab.content = value
      const dirty = value !== tab.saved
      if (dirty !== tab.dirty) { tab.dirty = dirty; renderTabs() }
      tab.dir = detectDirection(value)
      if (state.settings.direction === 'auto') {
        el.app.dataset.dir = tab.dir
        el.preview.setAttribute('dir', tab.dir)
        el.stDir.textContent = `dir: auto (${tab.dir})`
      }
      scheduleRender()
      updateStatusSoon()
      autosave()
    },
    onCursor: ({ line, col, selected }) => {
      el.stCursor.textContent = `Ln ${line}, Col ${col}` + (selected ? ` · ${selected} selected` : '')
      const tab = activeTab()
      if (tab) tab.cursorLine = line
    },
    onScroll: () => syncPreviewFromEditor(),
    onSave: () => saveTab(activeTab())
  })

  requestAnimationFrame(() => {
    const total = el.panes.offsetWidth
    el.paneEditor.style.flex = `0 0 ${Math.round(total * (settings.splitRatio || 0.5))}px`
  })

  document.body.classList.toggle('platform-win', !IS_MAC)
  localiseShortcutHints()
  wireUi()
  wireIpc()
  initUpdates({ api, state, openModal, toast, renderNotes: (text) => renderMarkdown(md, text), saveAllDirty })
  renderTree()
  renderTabs()
  renderRecent(settings)
  updateStatus()

  // restore last session
  const queuedFiles = (queued || []).filter((q) => q.path)
  if (settings.lastFolder && !state.folder) {
    try {
      const res = await api.readTree(settings.lastFolder)
      if (res.tree.length) { state.folder = res; renderTree() }
    } catch { /* folder gone */ }
  }
  for (const path of settings.openTabs || []) {
    if (await api.exists(path)) await openFile(path)
  }
  if (settings.activeTab) {
    const tab = state.tabs.find((t) => t.path === settings.activeTab)
    if (tab) activateTab(tab.id, { focus: false })
  }
  for (const f of queuedFiles) await openFile(f.path, f.content)
  if (!state.tabs.length && !settings.openTabs?.length) {
    // first run: show the welcome document
    if (!settings.seenWelcome) { newTab(WELCOME_DOC, 'Welcome.md'); api.settings.merge({ seenWelcome: true }) }
  }
  renderTabs()
}

const updateStatusSoon = debounce(() => updateStatus(), 220)

// small handle for scripted checks and debugging
window.__mashdavood = window.__mdreader = { state, doExport, renderPreview, get editor () { return editor } }

boot().catch((e) => {
  document.body.innerHTML = `<pre style="padding:24px;font-family:monospace;color:#c33">Startup error:\n${e?.stack || e}</pre>`
})
