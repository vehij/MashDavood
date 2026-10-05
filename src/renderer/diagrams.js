/* Mermaid diagrams in the preview: zoom, pan, frame height, dragging nodes (their
   edges and edge labels follow), a full-window view, and PNG / SVG export.

   The state is kept as a comment line inside the diagram's own source (app.js →
   writeDiagramLayout), or in settings.json when that is switched off, and it lives in
   the SVG itself — the viewBox, the
   node transforms, the redrawn edge paths — so a PDF/HTML export prints exactly the
   frame and layout that is on screen, at whatever width the page has. */

import { readDiagramLayout } from './markdown.js'

const PAD = 8                 // mermaid's own diagram padding
const MIN_FRAME = 90          // px, smallest frame height
const MAX_ZOOM = 12           // relative to the diagram's natural width
const MIN_ZOOM = 1 / 6
const DRAG_THRESHOLD = 3      // px before a press becomes a pan/drag

let ctx = null                // { preview, api, state, activeTab, toast, writeLayout, onLayout }
const arrangingKeys = new Set()  // arrange mode survives the re-render a layout write causes

const ICON = {
  minus: '<path d="M5 10h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  plus: '<path d="M5 10h10M10 5v10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  fit: '<path d="M4 8V4h4M16 8V4h-4M4 12v4h4M16 12v4h-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
  arrange: '<path d="M10 3v14M3 10h14M10 3 8 5M10 3l2 2M10 17l-2-2M10 17l2-2M3 10l2-2M3 10l2 2M17 10l-2-2M17 10l-2 2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
  undo: '<path d="M6 7H12a4 4 0 0 1 0 8H8M6 7l3-3M6 7l3 3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
  expand: '<path d="M11 4h5v5M9 16H4v-5M16 4l-5.5 5.5M4 16l5.5-5.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
  download: '<path d="M10 4v9M6 9.5l4 4 4-4M4.5 16h11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
  close: '<path d="M5.5 5.5l9 9M14.5 5.5l-9 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'
}
const icon = (name) => `<svg viewBox="0 0 20 20" width="14" height="14">${ICON[name]}</svg>`

/* --------------------------------------------------------------- setup */

export function initDiagrams (context) {
  ctx = context
  attachDiagramEvents(ctx.preview)
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('.mmd-menu, [data-mmd="menu"]')) closeMenus()
  })
}

/** Diagram controls work wherever diagrams are shown: the preview, Live Preview widgets. */
export function attachDiagramEvents (root) {
  root.addEventListener('mousedown', onMouseDown)
  root.addEventListener('wheel', onWheel, { passive: false })
  root.addEventListener('click', onClick)
}

/** Stable key: first line of the source (the diagram type) + its occurrence index. */
export function diagramKey (src, seen) {
  const head = (src.trim().split('\n')[0] || '').trim()
  const n = seen.get(head) || 0
  seen.set(head, n + 1)
  return head + '#' + n
}

/** Called after mermaid has put a fresh SVG into the block. */
export function decorateDiagram (block, key) {
  const svg = block.querySelector('svg')
  if (!svg) return
  // the layout written in the diagram itself wins when that is where layouts are kept
  const inFile = readDiagramLayout(block.dataset.src)
  const inSettings = storeFor(ctx.activeTab())?.[key]
  const saved = ctx.state.settings.embedLayout ? (inFile || inSettings) : (inSettings || inFile)
  block._mmd = {
    key,
    svg,
    state: { vb: Array.isArray(saved?.vb) ? saved.vb.slice() : null, nodes: { ...(saved?.nodes || {}) } },
    origVB: parseVB(svg.getAttribute('viewBox')),
    origStyle: svg.getAttribute('style') || '',
    ready: false,
    arranging: false,
    dragging: false
  }
  addChrome(block)
  prepare(block)
  if (arrangingKeys.has(key)) setArranging(block, true)
}

/** Blocks laid out while the preview was hidden get their geometry now. */
export function refreshDiagrams () {
  for (const block of ctx.preview.querySelectorAll('.mermaid-block')) {
    if (block._mmd && !block._mmd.ready) prepare(block)
  }
}

/** Markup for export/copy: the controls go, the SVG (with its layout) stays. */
export function stripDiagramChrome (root) {
  root.querySelectorAll('.mmd-tools, .mmd-resize, .mmd-menu').forEach((n) => n.remove())
  root.querySelectorAll('.mermaid-block').forEach((b) => b.classList.remove('arranging', 'panning'))
}

/* ------------------------------------------------------------- storage */

function storeFor (tab, create = false) {
  if (!tab) return null
  if (!tab.path) {
    if (!tab.diagrams && create) tab.diagrams = {}
    return tab.diagrams || null
  }
  const all = ctx.state.settings.diagrams || (ctx.state.settings.diagrams = {})
  if (!all[tab.path] && create) all[tab.path] = {}
  return all[tab.path] || null
}

function save (block) {
  const m = block._mmd
  clearTimeout(m.saveTimer)
  m.saveTimer = setTimeout(() => {
    const tab = ctx.activeTab()
    if (m.ready) {
      // forget nodes that no longer exist, and keep each label current for rename matching
      for (const key of Object.keys(m.state.nodes)) {
        const n = m.nodes.get(key)
        if (!n) delete m.state.nodes[key]
        else m.state.nodes[key] = [m.state.nodes[key][0], m.state.nodes[key][1], labelOf(n)]
      }
    }
    const hasNodes = Object.keys(m.state.nodes).length > 0
    const data = m.state.vb || hasNodes ? { vb: m.state.vb && m.state.vb.map((v) => Math.round(v * 10) / 10), nodes: m.state.nodes } : null
    let store = storeFor(tab)
    if (ctx.state.settings.embedLayout && ctx.writeLayout(block, data)) {
      if (!store?.[m.key]) return
      delete store[m.key]           // the file has it now
    } else {
      store = storeFor(tab, true)
      if (!store) return
      if (data) store[m.key] = data
      else delete store[m.key]
    }
    if (tab.path) {
      const all = ctx.state.settings.diagrams
      if (!Object.keys(store).length) delete all[tab.path]
      ctx.api.settings.merge({ diagrams: all })
    }
  }, 300)
}

/* ------------------------------------------------------------ geometry */

const r3 = (n) => Math.round(n * 1000) / 1000
const labelOf = (n) => n.el.textContent.replace(/\s+/g, ' ').trim().slice(0, 40)
const parseVB = (s) => (s || '0 0 100 100').trim().split(/[\s,]+/).map(Number)
const setVB = (svg, vb) => svg.setAttribute('viewBox', vb.map(r3).join(' '))

function parseTranslate (t) {
  const m = /translate\(\s*([-\d.e]+)[\s,]*([-\d.e]*)\s*\)/.exec(t || '')
  return m ? { x: Number(m[1]), y: Number(m[2] || 0) } : { x: 0, y: 0 }
}

/** Matrix from an element's user space to the svg's viewBox space. */
function toRoot (svg, el) {
  return svg.getScreenCTM().inverse().multiply(el.getScreenCTM())
}

function clientToSvg (svg, x, y) {
  const p = svg.createSVGPoint()
  p.x = x
  p.y = y
  return p.matrixTransform(svg.getScreenCTM().inverse())
}

/** d3's curveBasis — what mermaid draws its edges with. */
function basisPath (pts) {
  if (pts.length < 2) return ''
  let d = `M${r3(pts[0].x)},${r3(pts[0].y)}`
  let x0 = NaN; let y0 = NaN; let x1 = NaN; let y1 = NaN; let n = 0
  const curve = (x, y) => {
    d += `C${r3((2 * x0 + x1) / 3)},${r3((2 * y0 + y1) / 3)},${r3((x0 + 2 * x1) / 3)},${r3((y0 + 2 * y1) / 3)},${r3((x0 + 4 * x1 + x) / 6)},${r3((y0 + 4 * y1 + y) / 6)}`
  }
  for (const { x, y } of pts) {
    if (n === 0) { n = 1 } else if (n === 1) { n = 2 } else {
      if (n === 2) { n = 3; d += `L${r3((5 * x0 + x1) / 6)},${r3((5 * y0 + y1) / 6)}` }
      curve(x, y)
    }
    x0 = x1; x1 = x; y0 = y1; y1 = y
  }
  if (n === 3) curve(x1, y1)
  d += `L${r3(x1)},${r3(y1)}`
  return d
}

/** Pull an end point back towards its neighbour, as mermaid does for arrowheads. */
function shorten (pts, startBy, endBy) {
  const pull = (a, b, by) => {
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    if (!by || len < 1e-6) return a
    const t = Math.min(by, len * 0.9) / len
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
  }
  if (pts.length < 2) return pts
  pts[0] = pull(pts[0], pts[1], startBy)
  pts[pts.length - 1] = pull(pts[pts.length - 1], pts[pts.length - 2], endBy)
  return pts
}

function pathEnds (d) {
  const nums = (d.match(/-?\d*\.?\d+(?:e-?\d+)?/gi) || []).map(Number)
  return nums.length >= 4 ? { start: { x: nums[0], y: nums[1] }, end: { x: nums[nums.length - 2], y: nums[nums.length - 1] } } : null
}

/**
 * Index the diagram once, at mermaid's original positions: nodes with their box,
 * edges with their points and the nodes their two ends sit on, and edge labels.
 * Needs layout, so a diagram in a hidden pane waits for refreshDiagrams().
 */
function prepare (block) {
  const m = block._mmd
  const svg = m.svg
  if (!svg.isConnected || !svg.getBoundingClientRect().width || !svg.getScreenCTM()) { m.ready = false; return }

  m.nodes = new Map()
  for (const el of svg.querySelectorAll('g.node')) {
    // "mmd-x1y2z3-flowchart-A-0" → "flowchart-A": the render id and mermaid's trailing
    // counter change from one render to the next, the rest names the node
    const key = el.id.replace(/^mmd-[a-z0-9]+-/i, '').replace(/-\d+$/, '')
    if (!key || m.nodes.has(key)) continue
    const t0 = el.getAttribute('transform') || ''
    const c = parseTranslate(t0)
    const b = el.getBBox()
    const M = toRoot(svg, el)
    const box = { x: M.a * b.x + M.e, y: M.d * b.y + M.f, w: M.a * b.width, h: M.d * b.height }
    m.nodes.set(key, { el, t0, cx: c.x, cy: c.y, box })
  }
  if (!m.nodes.size) indexTimeline(m)

  const labels = new Map()
  for (const el of svg.querySelectorAll('g.edgeLabel')) {
    const id = el.querySelector('[data-id]')?.getAttribute('data-id')
    const t0 = el.getAttribute('transform')
    if (id && t0) labels.set(id, { el, t0, ...parseTranslate(t0) })
  }

  const hit = (p) => {
    let best = null
    for (const [key, n] of m.nodes) {
      const { x, y, w, h } = n.box
      if (p.x >= x - 3 && p.x <= x + w + 3 && p.y >= y - 3 && p.y <= y + h + 3) {
        if (!best || w * h < best.area) best = { key, area: w * h }
      }
    }
    return best?.key || null
  }

  m.edges = []
  for (const el of svg.querySelectorAll('path[data-edge]')) {
    let pts
    try { pts = JSON.parse(atob(el.getAttribute('data-points') || '')) } catch { continue }
    if (!Array.isArray(pts) || pts.length < 2) continue
    const d0 = el.getAttribute('d') || ''
    const M = toRoot(svg, el)
    const rootPt = (p) => ({ x: M.a * p.x + M.e, y: M.d * p.y + M.f })
    const ends = pathEnds(d0)
    const first = pts[0]
    const last = pts[pts.length - 1]
    m.edges.push({
      el,
      d0,
      pts,
      start: hit(rootPt(first)),
      end: hit(rootPt(last)),
      offS: ends ? Math.hypot(ends.start.x - first.x, ends.start.y - first.y) : 0,
      offE: ends ? Math.hypot(ends.end.x - last.x, ends.end.y - last.y) : 0,
      label: labels.get(el.getAttribute('data-id')) || null
    })
  }

  // a node renamed in the source (new id, same text) keeps its position
  for (const [key, v] of Object.entries(m.state.nodes)) {
    if (m.nodes.has(key) || !v[2]) continue
    const same = [...m.nodes].filter(([k, n]) => !m.state.nodes[k] && labelOf(n) === v[2])
    if (same.length === 1) { m.state.nodes[same[0][0]] = v; delete m.state.nodes[key] }
  }

  for (const n of m.nodes.values()) n.el.classList.add('mmd-movable')
  m.ready = true
  block.classList.toggle('can-arrange', m.nodes.size > 0)
  apply(block)
}

/**
 * Timelines have no g.node: the movable units are the period headers (g.taskWrapper)
 * and the event boxes (g.eventWrapper). A period carries its column with it — the
 * events under it follow its offset on top of their own, and so does its dashed line.
 */
function indexTimeline (m) {
  const svg = m.svg
  const tasks = svg.querySelectorAll(':scope > g.taskWrapper')
  if (!tasks.length) return
  const seen = new Map()
  const keyOf = (kind, el) => {
    const k = kind + ':' + el.textContent.replace(/\s+/g, ' ').trim().slice(0, 40)
    const n = seen.get(k) || 0
    seen.set(k, n + 1)
    return n ? `${k}#${n}` : k
  }
  const unit = (el) => {
    const t0 = el.getAttribute('transform') || ''
    const c = parseTranslate(t0)
    const b = el.getBBox()
    const M = toRoot(svg, el)
    return { el, t0, cx: c.x, cy: c.y, box: { x: M.a * b.x + M.e, y: M.d * b.y + M.f, w: M.a * b.width, h: M.d * b.height } }
  }
  const columns = []
  for (const el of tasks) {
    const key = keyOf('period', el)
    const n = unit(el)
    n.lines = []
    m.nodes.set(key, n)
    columns.push([key, n])
  }
  const columnAt = (x) => columns.find(([, n]) => Math.abs(n.box.x + n.box.w / 2 - x) < 2)?.[0] || null
  for (const el of svg.querySelectorAll(':scope > g.eventWrapper')) {
    const n = unit(el)
    n.parent = columnAt(n.box.x + n.box.w / 2)
    m.nodes.set(keyOf('event', el), n)
  }
  for (const line of svg.querySelectorAll(':scope > g.lineWrapper > line')) {
    const owner = columnAt(Number(line.getAttribute('x1')))
    if (owner) m.nodes.get(owner).lines.push({ el: line, t0: line.getAttribute('transform') || '' })
  }
}

/** Put the saved state on the SVG. Idempotent: always starts from the originals. */
function apply (block) {
  const m = block._mmd
  if (!m?.ready) return
  const svg = m.svg
  const off = (k) => (k && m.state.nodes[k]) || null
  let moved = false

  for (const [key, n] of m.nodes) {
    const own = off(key)
    const parent = n.parent && off(n.parent)   // a timeline event moves with its period too
    const o = own || parent ? [(own?.[0] || 0) + (parent?.[0] || 0), (own?.[1] || 0) + (parent?.[1] || 0)] : null
    if (own) moved = true
    n.el.setAttribute('transform', o ? `translate(${r3(n.cx + o[0])}, ${r3(n.cy + o[1])})` : n.t0)
    for (const line of n.lines || []) line.el.setAttribute('transform', own ? `translate(${r3(own[0])}, ${r3(own[1])})` : line.t0)
  }

  for (const e of m.edges) {
    const a = off(e.start) || [0, 0]
    const b = off(e.end) || [0, 0]
    if (!a[0] && !a[1] && !b[0] && !b[1]) {
      e.el.setAttribute('d', e.d0)
      if (e.label) e.label.el.setAttribute('transform', e.label.t0)
      continue
    }
    const last = e.pts.length - 1
    const pts = e.pts.map((p, i) => {
      const t = last ? i / last : 0
      return { x: p.x + a[0] + (b[0] - a[0]) * t, y: p.y + a[1] + (b[1] - a[1]) * t }
    })
    e.el.setAttribute('d', basisPath(shorten(pts, e.offS, e.offE)))
    if (e.label) e.label.el.setAttribute('transform', `translate(${r3(e.label.x + (a[0] + b[0]) / 2)}, ${r3(e.label.y + (a[1] + b[1]) / 2)})`)
  }

  block.classList.toggle('custom-view', !!m.state.vb)
  block.classList.toggle('has-layout', moved)
  if (m.state.vb) {
    setVB(svg, m.state.vb)
    svg.setAttribute('style', 'max-width: none; width: 100%; height: auto;')
  } else if (moved && !m.dragging) {
    // nodes moved out of the original frame: grow the frame to the content
    const bb = svg.getBBox()
    const vb = [bb.x - PAD, bb.y - PAD, bb.width + 2 * PAD, bb.height + 2 * PAD]
    setVB(svg, vb)
    svg.setAttribute('style', `max-width: ${r3(vb[2])}px;`)
  } else if (!moved) {
    setVB(svg, m.origVB)
    svg.setAttribute('style', m.origStyle)
  }
  updateZoomLabel(block)
  ctx.onLayout?.()
}

/* ---------------------------------------------------------- view state */

const contentWidth = (block) => {
  const cs = getComputedStyle(block)
  return block.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
}

/** The viewBox on screen; entering the custom view keeps the picture exactly where it is. */
function ensureCustom (block) {
  const m = block._mmd
  if (m.state.vb) return m.state.vb
  const vb = parseVB(m.svg.getAttribute('viewBox'))
  const shown = m.svg.getBoundingClientRect().width || 1
  const full = contentWidth(block) || shown
  const w = vb[2] * full / shown
  m.state.vb = [vb[0] - (w - vb[2]) / 2, vb[1], w, vb[3]]
  return m.state.vb
}

function zoomPercent (block) {
  const m = block._mmd
  const vb = parseVB(m.svg.getAttribute('viewBox'))
  const shown = m.svg.getBoundingClientRect().width
  if (!shown) return 100
  const fit = Math.min(1, contentWidth(block) / m.origVB[2])
  return Math.round((shown / vb[2]) / fit * 100)
}

function updateZoomLabel (block) {
  const label = block.querySelector('[data-mmd="pct"]')
  if (label) label.textContent = zoomPercent(block) + '%'
}

function zoomBy (block, factor, clientX, clientY) {
  const m = block._mmd
  if (!m?.ready) return
  const vb = ensureCustom(block)
  apply(block)
  const r = m.svg.getBoundingClientRect()
  const p = clientToSvg(m.svg, clientX ?? r.left + r.width / 2, clientY ?? r.top + r.height / 2)
  const w = Math.min(m.origVB[2] / MIN_ZOOM, Math.max(m.origVB[2] / MAX_ZOOM, vb[2] / factor))
  const f = vb[2] / w
  m.state.vb = [p.x - (p.x - vb[0]) / f, p.y - (p.y - vb[1]) / f, w, vb[3] / f]
  apply(block)
  save(block)
}

function resetView (block) {
  block._mmd.state.vb = null
  apply(block)
  save(block)
}

function resetLayout (block) {
  block._mmd.state.nodes = {}
  apply(block)
  save(block)
}

function setArranging (block, on) {
  block._mmd.arranging = on
  if (on) arrangingKeys.add(block._mmd.key); else arrangingKeys.delete(block._mmd.key)
  block.classList.toggle('arranging', on)
  block.querySelector('[data-mmd="arrange"]')?.classList.toggle('on', on)
}

/* ------------------------------------------------------------ controls */

function addChrome (block) {
  // built after the app translated its static shortcut hints, so name the key here
  const mod = ctx.api.platform === 'darwin' ? '⌘' : 'Ctrl'
  const tools = document.createElement('div')
  tools.className = 'mmd-tools'
  tools.innerHTML =
    `<button data-mmd="out" title="Zoom out (${mod} + scroll)">${icon('minus')}</button>` +
    '<button data-mmd="pct" class="mmd-pct" title="Fit (reset zoom, pan and height)">100%</button>' +
    `<button data-mmd="in" title="Zoom in (${mod} + scroll / pinch)">${icon('plus')}</button>` +
    `<button data-mmd="fit" title="Fit — reset zoom, pan and frame height">${icon('fit')}</button>` +
    '<span class="mmd-arrange-group"><span class="mmd-sep"></span>' +
    `<button data-mmd="arrange" title="Arrange: drag nodes to move them (edges follow)">${icon('arrange')}</button>` +
    `<button data-mmd="relayout" class="mmd-relayout" title="Reset node positions">${icon('undo')}</button></span>` +
    '<span class="mmd-sep"></span>' +
    `<button data-mmd="full" title="Full window">${icon('expand')}</button>` +
    `<button data-mmd="menu" title="Save or copy as image">${icon('download')}</button>`
  const resize = document.createElement('div')
  resize.className = 'mmd-resize'
  resize.title = 'Drag to change the frame height'
  block.append(tools, resize)
}

function closeMenus () {
  document.querySelectorAll('.mmd-menu').forEach((n) => n.remove())
}

function openMenu (block, button) {
  closeMenus()
  const menu = document.createElement('div')
  menu.className = 'mmd-menu'
  menu.innerHTML =
    '<button data-mmd="png">Save as PNG…</button>' +
    '<button data-mmd="svg">Save as SVG…</button>' +
    '<button data-mmd="copy">Copy as image</button>'
  block.appendChild(menu)
  const tb = button.getBoundingClientRect()
  const bb = block.getBoundingClientRect()
  menu.style.top = (tb.bottom - bb.top + 4) + 'px'
  menu.style.right = (bb.right - tb.right) + 'px'
}

function onClick (e) {
  const button = e.target.closest('[data-mmd]')
  if (!button) return
  const block = button.closest('.mermaid-block')
  if (!block?._mmd) return
  e.preventDefault()
  e.stopPropagation()
  const action = button.dataset.mmd
  if (action !== 'menu') closeMenus()
  switch (action) {
    case 'in': zoomBy(block, 1.25); break
    case 'out': zoomBy(block, 0.8); break
    case 'pct':
    case 'fit': resetView(block); break
    case 'arrange': setArranging(block, !block._mmd.arranging); break
    case 'relayout': resetLayout(block); break
    case 'full': openFullWindow(block); break
    case 'menu': openMenu(block, button); break
    case 'png': exportImage(block, 'png'); break
    case 'svg': exportImage(block, 'svg'); break
    case 'copy': exportImage(block, 'copy'); break
  }
}

function onWheel (e) {
  if (!(e.ctrlKey || e.metaKey)) return
  const block = e.target.closest('.mermaid-block')
  if (!block?._mmd?.ready) return
  e.preventDefault()
  zoomBy(block, Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0025)), e.clientX, e.clientY)
}

function onMouseDown (e) {
  if (e.button !== 0) return
  const block = e.target.closest('.mermaid-block')
  const m = block?._mmd
  if (!m?.ready || e.target.closest('.mmd-tools, .mmd-menu')) return

  if (e.target.closest('.mmd-resize')) return startResize(e, block)

  const nodeKey = m.arranging ? [...m.nodes].find(([, n]) => n.el.contains(e.target))?.[0] : null
  e.preventDefault()
  const startX = e.clientX
  const startY = e.clientY
  let active = false
  let base = null

  const move = (ev) => {
    const dx = ev.clientX - startX
    const dy = ev.clientY - startY
    if (!active) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return
      active = true
      if (nodeKey) {
        m.dragging = true
        base = (m.state.nodes[nodeKey] || [0, 0]).slice()
      } else {
        base = ensureCustom(block).slice()
        apply(block)
        block.classList.add('panning')
      }
    }
    const scale = m.svg.getScreenCTM().a || 1   // screen px per svg unit
    if (nodeKey) {
      m.state.nodes[nodeKey] = [Math.round((base[0] + dx / scale) * 10) / 10, Math.round((base[1] + dy / scale) * 10) / 10]
    } else {
      m.state.vb = [base[0] - dx / scale, base[1] - dy / scale, base[2], base[3]]
    }
    apply(block)
  }
  const up = () => {
    document.removeEventListener('mousemove', move)
    document.removeEventListener('mouseup', up)
    block.classList.remove('panning')
    if (!active) return
    m.dragging = false
    apply(block)
    save(block)
  }
  document.addEventListener('mousemove', move)
  document.addEventListener('mouseup', up)
}

function startResize (e, block) {
  e.preventDefault()
  const m = block._mmd
  const vb = ensureCustom(block).slice()
  apply(block)
  const r = m.svg.getBoundingClientRect()
  const startY = e.clientY
  block.classList.add('resizing')
  const move = (ev) => {
    const h = Math.max(MIN_FRAME, r.height + ev.clientY - startY)
    m.state.vb = [vb[0], vb[1], vb[2], vb[2] * h / r.width]
    apply(block)
  }
  const up = () => {
    document.removeEventListener('mousemove', move)
    document.removeEventListener('mouseup', up)
    block.classList.remove('resizing')
    save(block)
  }
  document.addEventListener('mousemove', move)
  document.addEventListener('mouseup', up)
}

/* --------------------------------------------------------- full window */

function openFullWindow (block) {
  const m = block._mmd
  const overlay = document.createElement('div')
  overlay.className = 'mmd-overlay'
  overlay.innerHTML =
    '<div class="mmd-ov-bar">' +
    `<button data-ov="out" title="Zoom out">${icon('minus')}</button>` +
    '<button data-ov="fit" class="mmd-pct" title="Fit">Fit</button>' +
    `<button data-ov="in" title="Zoom in">${icon('plus')}</button>` +
    '<span class="mmd-ov-hint">scroll to zoom · drag to move · Esc to close</span>' +
    `<button data-ov="close" title="Close (Esc)">${icon('close')}</button>` +
    '</div><div class="mmd-ov-stage"></div>'
  const stage = overlay.querySelector('.mmd-ov-stage')
  const svg = m.svg.cloneNode(true)
  svg.removeAttribute('style')
  svg.setAttribute('width', '100%')
  svg.setAttribute('height', '100%')
  stage.appendChild(svg)
  document.body.appendChild(overlay)

  // open on the whole diagram (with its arranged layout), not on the page's zoomed frame
  const bb = m.svg.getBBox()
  const fitVB = bb.width ? [bb.x - PAD, bb.y - PAD, bb.width + 2 * PAD, bb.height + 2 * PAD] : parseVB(svg.getAttribute('viewBox'))
  let vb = fitVB.slice()
  setVB(svg, vb)
  const set = () => setVB(svg, vb)
  const zoom = (factor, x, y) => {
    const r = stage.getBoundingClientRect()
    const p = clientToSvg(svg, x ?? r.left + r.width / 2, y ?? r.top + r.height / 2)
    const w = Math.min(fitVB[2] * 4, Math.max(fitVB[2] / 20, vb[2] / factor))
    const f = vb[2] / w
    vb = [p.x - (p.x - vb[0]) / f, p.y - (p.y - vb[1]) / f, w, vb[3] / f]
    set()
  }
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey, true) }
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close() } else if (e.key === '+' || e.key === '=') zoom(1.25)
    else if (e.key === '-') zoom(0.8)
    else if (e.key === '0') { vb = fitVB.slice(); set() }
  }
  document.addEventListener('keydown', onKey, true)
  overlay.addEventListener('click', (e) => {
    const b = e.target.closest('[data-ov]')
    if (!b) return
    if (b.dataset.ov === 'close') close()
    if (b.dataset.ov === 'in') zoom(1.25)
    if (b.dataset.ov === 'out') zoom(0.8)
    if (b.dataset.ov === 'fit') { vb = fitVB.slice(); set() }
  })
  stage.addEventListener('wheel', (e) => {
    e.preventDefault()
    zoom(Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0025)), e.clientX, e.clientY)
  }, { passive: false })
  stage.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    const sx = e.clientX
    const sy = e.clientY
    const base = vb.slice()
    stage.classList.add('panning')
    const move = (ev) => {
      const s = svg.getScreenCTM().a || 1
      vb = [base[0] - (ev.clientX - sx) / s, base[1] - (ev.clientY - sy) / s, base[2], base[3]]
      set()
    }
    const up = () => {
      stage.classList.remove('panning')
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
  })
}

/* --------------------------------------------------------------- images */

/** The diagram as a standalone SVG document: the frame on screen, on the page colour. */
function serialize (block) {
  const m = block._mmd
  const svg = m.svg.cloneNode(true)
  const vb = parseVB(svg.getAttribute('viewBox'))
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  svg.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink')
  svg.setAttribute('width', r3(vb[2]))
  svg.setAttribute('height', r3(vb[3]))
  svg.removeAttribute('style')
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
  bg.setAttribute('x', vb[0]); bg.setAttribute('y', vb[1])
  bg.setAttribute('width', vb[2]); bg.setAttribute('height', vb[3])
  bg.setAttribute('fill', getComputedStyle(block).backgroundColor || '#ffffff')
  svg.insertBefore(bg, svg.firstChild)
  return { svg: new XMLSerializer().serializeToString(svg), width: vb[2], height: vb[3] }
}

async function exportImage (block, kind) {
  const { svg, width, height } = serialize(block)
  const tab = ctx.activeTab()
  const name = (tab?.name || 'diagram').replace(/\.[^.]+$/, '') + '-diagram'
  try {
    if (kind === 'copy') {
      const png = await ctx.api.diagramImage({ svg, width, height, format: 'png', copy: true })
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })])
      ctx.toast('Diagram copied as image')
      return
    }
    const dir = tab?.path ? tab.path.replace(/[\\/][^\\/]*$/, '') : null
    const out = await ctx.api.diagramImage({ svg, width, height, format: kind, name, dir })
    if (out) ctx.toast('Saved → ' + out.split(/[\\/]/).pop())
  } catch (e) {
    ctx.toast('Could not export the diagram: ' + String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error')
  }
}
