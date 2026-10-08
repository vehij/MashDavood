/* Editing a table in place, in Live Preview.

   A click on a cell turns just that cell into a small plain-text field holding the
   cell's Markdown (no pipes to look at, no columns to keep lined up). Every keystroke
   is written straight into the cell's own span in the document, so the file, undo and
   the dirty mark stay exact; the rest of the table's text is never touched. Rows and
   columns are added, removed and aligned from the right-click menu, and Tab / Enter
   add a row at the end the way spreadsheets do. */

import { syntaxTree } from '@codemirror/language'
import { undo, redo } from '@codemirror/commands'
import { estimateDirection, markdownDirectionText, PERSIAN_DIGITS } from './direction.mjs'

const TABLE_WIDTHS = /^\s*<!--\s*mashdavood\s+widths:\s*([^>]*?)\s*-->\s*$/

/** Cell spans of one table row, as offsets into the line between its pipes. */
export function splitRow (text) {
  const cells = []
  let i = /^\s*/.exec(text)[0].length
  if (text[i] === '|') i++
  let start = i
  for (; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue }
    if (text[i] === '|') { cells.push({ from: start, to: i }); start = i + 1 }
  }
  if (text.slice(start).trim() !== '') cells.push({ from: start, to: text.length })
  return cells
}

const cellsOf = (text) => splitRow(text).map((c) => text.slice(c.from, c.to).trim())
// a | inside a cell has to be escaped in the file; the field shows it plainly
const toField = (raw) => raw.replace(/\\\|/g, '|')
const toSource = (text) => text.replace(/\s*\n\s*/g, ' ').trim().replace(/\|/g, '\\|')

/** The table whose widget starts at `pos`: its widths comment (if any) and its lines. */
function locate (state, pos) {
  const doc = state.doc
  let first = doc.lineAt(pos)
  const widthsLine = TABLE_WIDTHS.test(first.text) ? first : null
  if (widthsLine) {
    if (first.number >= doc.lines) return null
    first = doc.line(first.number + 1)
  }
  let node = null
  syntaxTree(state).iterate({
    from: first.from,
    to: first.to,
    enter (n) {
      if (node) return false
      if (n.name === 'Table') { node = { from: n.from, to: n.to }; return false }
    }
  })
  if (!node) return null
  const lines = []
  for (let n = doc.lineAt(node.from).number, end = doc.lineAt(node.to).number; n <= end; n++) lines.push(doc.line(n))
  if (lines.length < 2) return null
  return { widthsLine, lines, from: (widthsLine || lines[0]).from, to: lines[lines.length - 1].to }
}

// rendered row r is source line 0 for the header, r + 1 below the delimiter row
const lineIndex = (r) => (r === 0 ? 0 : r + 1)

const ALIGN_MARK = { left: ':---', center: ':---:', right: '---:', '': '---' }
const alignOf = (s) => {
  const l = s.startsWith(':')
  const r = s.endsWith(':')
  return l && r ? 'center' : r ? 'right' : l ? 'left' : ''
}

/** The whole table as cells, for the changes that reshape it (columns, alignment). */
function parse (loc) {
  const texts = loc.lines.map((l) => l.text)
  const widths = loc.widthsLine ? TABLE_WIDTHS.exec(loc.widthsLine.text)[1].split(',').map((w) => Number(w.trim())) : null
  return {
    indent: /^\s*/.exec(texts[0])[0],
    head: cellsOf(texts[0]),
    align: cellsOf(texts[1]).map(alignOf),
    body: texts.slice(2).map(cellsOf),
    widths: widths && widths.every((w) => w > 0) ? widths : null
  }
}

function format ({ indent, head, align, body, widths }) {
  const cols = head.length
  const row = (cells) => indent + '| ' + Array.from({ length: cols }, (_, i) => cells[i] ?? '').join(' | ') + ' |'
  const lines = [row(head), indent + '| ' + Array.from({ length: cols }, (_, i) => ALIGN_MARK[align[i] || '']).join(' | ') + ' |', ...body.map(row)]
  if (widths && widths.length === cols) lines.unshift(indent + `<!-- mashdavood widths: ${widths.map((w) => Math.round(w)).join(',')} -->`)
  return lines.join('\n')
}

const emptyRow = (indent, cols) => indent + '|' + '   |'.repeat(cols)

/* ------------------------------------------------------------- caret helpers */

function caretOffset (field) {
  const sel = getSelection()
  if (!sel.rangeCount || !field.contains(sel.anchorNode)) return field.textContent.length
  const range = document.createRange()
  range.selectNodeContents(field)
  range.setEnd(sel.anchorNode, sel.anchorOffset)
  return range.toString().length
}

function placeCaret (field, offset) {
  const range = document.createRange()
  const node = field.firstChild
  if (node && node.nodeType === Node.TEXT_NODE) range.setStart(node, Math.max(0, Math.min(offset, node.length)))
  else range.setStart(field, 0)
  range.collapse(true)
  const sel = getSelection()
  sel.removeAllRanges()
  sel.addRange(range)
}

/** Character offset of a click inside a rendered cell, or null. */
function clickOffset (cell, x, y) {
  const at = document.caretRangeFromPoint?.(x, y)
  if (!at || !cell.contains(at.startContainer)) return null
  const range = document.createRange()
  range.selectNodeContents(cell)
  range.setEnd(at.startContainer, at.startOffset)
  return range.toString().replace(/^\s+/, '').length
}

/** The cell's caret is on its first / last visual line (cells wrap). */
function onEdgeLine (field, up) {
  const sel = getSelection()
  if (!sel.rangeCount) return true
  const rects = sel.getRangeAt(0).getClientRects()
  const caret = rects[0]
  if (!caret || !caret.height) return true
  const box = field.getBoundingClientRect()
  return up ? caret.top - box.top < caret.height * 0.8 : box.bottom - caret.bottom < caret.height * 0.8
}

/** The table widget that starts at `from`, after the editor redrew it. */
function hostAt (view, from) {
  for (const el of view.contentDOM.querySelectorAll('.lp-table')) {
    try { if (view.posAtDOM(el) === from) return el } catch {}
  }
  return null
}

/* ------------------------------------------------------------------ editing */

export function attachTableEditing (host, view, hooks, showSource) {
  const table = host.querySelector('table')
  if (!table) return
  const rtl = table.getAttribute('dir') === 'rtl'
  let active = null      // { cell, field, r, c }
  let menu = null

  const start = () => view.posAtDOM(host)
  const current = () => {
    const loc = locate(view.state, start())
    // the rendering and the source must agree row for row, or a cell could land in the wrong place
    return loc && loc.lines.length - 1 === table.rows.length ? loc : null
  }

  function edit (cell, where = 'end') {
    if (active?.cell === cell) return
    finish()
    const loc = current()
    if (!loc) { showSource(); return }
    const r = cell.parentElement.rowIndex
    const c = cell.cellIndex
    const line = loc.lines[lineIndex(r)]
    const span = splitRow(line.text)[c]
    const text = toField(span ? line.text.slice(span.from, span.to).trim() : '')
    let offset = where === 'start' ? 0 : typeof where === 'number' ? where : text.length
    // a click keeps its place when the cell has no markup that would shift the text
    if (where && typeof where === 'object') {
      const at = clickOffset(cell, where.x, where.y)
      offset = at !== null && text === cell.textContent.trim() ? at : text.length
    }
    const field = document.createElement('span')
    field.className = 'lp-cell-field'
    field.contentEditable = 'plaintext-only'
    field.spellcheck = false
    field.textContent = text
    const directionText = markdownDirectionText(text)
    field.dir = estimateDirection(directionText, PERSIAN_DIGITS.test(directionText) ? 'rtl' : (cell.dir || table.dir || 'ltr'))
    for (const n of [...cell.childNodes]) if (!n.classList?.contains('col-resizer')) n.remove()
    cell.prepend(field)
    cell.classList.add('lp-editing')
    active = { cell, field, r, c }
    field.addEventListener('input', (e) => { if (!e.isComposing) commit() })
    field.addEventListener('compositionend', () => commit())
    field.addEventListener('keydown', onKey)
    field.addEventListener('paste', (e) => {
      e.preventDefault()
      document.execCommand('insertText', false, (e.clipboardData.getData('text/plain') || '').replace(/\s*\n\s*/g, ' '))
    })
    field.addEventListener('blur', () => {
      // switching to another window keeps the cell open; clicking elsewhere closes it
      if (document.hasFocus() && active?.field === field) finish()
    })
    field.focus({ preventScroll: true })
    placeCaret(field, offset)
  }

  /** Write the field into its cell's span in the document. */
  function commit () {
    if (!active) return
    const { r, c, field } = active
    const directionText = markdownDirectionText(field.textContent)
    field.dir = estimateDirection(directionText, PERSIAN_DIGITS.test(directionText) ? 'rtl' : (table.rows[r].cells[c].dir || table.dir || 'ltr'))
    const loc = current()
    if (!loc) return
    const index = lineIndex(r)
    const line = loc.lines[index]
    const cells = splitRow(line.text)
    const value = toSource(field.textContent)
    let from, to, insert
    if (c < cells.length) {
      const inner = line.text.slice(cells[c].from, cells[c].to)
      if (!inner.trim()) {
        from = cells[c].from; to = cells[c].to; insert = value ? ` ${value} ` : inner
      } else {
        from = cells[c].from + /^\s*/.exec(inner)[0].length
        to = cells[c].to - /\s*$/.exec(inner)[0].length
        insert = value
      }
    } else {
      // a short row: add the missing cells up to this one
      const end = line.text.replace(/\s+$/, '')
      insert = /(^|[^\\])\|$/.test(end) ? '' : ' |'
      for (let k = cells.length; k <= c; k++) insert += ` ${k === c ? value : ''} |`
      from = end.length; to = line.text.length
    }
    if (line.text.slice(from, to) === insert) return
    const texts = loc.lines.map((l) => l.text)
    texts[index] = line.text.slice(0, from) + insert + line.text.slice(to)
    // the widget keeps this very DOM (and the caret in it) when the new text is what we expect
    host._lp.expect = texts.join('\n')
    const caret = caretOffset(field)
    const tr = view.state.update({ changes: { from: line.from + from, to: line.from + to, insert }, userEvent: 'input.type' })
    view.dispatch(tr)
    if (!host.isConnected) hostAt(view, tr.changes.mapPos(loc.from))?._tableEdit?.edit(r, c, caret)
    view.requestMeasure()
  }

  /** Close the field and show the cell rendered again. */
  function finish () {
    if (!active) return
    const { cell, r, c, field } = active
    active = null
    // the caret must not stay behind inside the widget: the editor would read it as a click there
    if (field.contains(getSelection().anchorNode)) getSelection().removeAllRanges()
    const tmp = document.createElement('div')
    tmp.innerHTML = hooks.renderTable(host._lp.source)
    const fresh = tmp.querySelector('table')?.rows[r]?.cells[c]
    const resizer = cell.querySelector(':scope > .col-resizer')
    cell.replaceChildren()
    if (fresh) {
      for (const { name, value } of fresh.attributes) cell.setAttribute(name, value)
      cell.append(...fresh.childNodes)
    }
    if (resizer) cell.append(resizer)
    cell.classList.remove('lp-editing')
    view.requestMeasure()
  }

  function go (r, c, where) {
    const cell = table.rows[r]?.cells[c]
    if (cell) edit(cell, where)
  }

  function move (dir) {
    const { r, c } = active
    const rows = table.rows
    const last = rows.length - 1
    if (dir === 'next') {
      if (c + 1 < rows[r].cells.length) go(r, c + 1, 'end')
      else if (r < last) go(r + 1, 0, 'end')
      else addRow(r, true, 0)
    } else if (dir === 'prev') {
      if (c > 0) go(r, c - 1, 'end')
      else if (r > 0) go(r - 1, rows[r - 1].cells.length - 1, 'end')
      else leave('before')
    } else if (dir === 'down') {
      if (r < last) go(r + 1, Math.min(c, rows[r + 1].cells.length - 1), 'end')
      else leave('after')
    } else if (dir === 'up') {
      if (r > 0) go(r - 1, Math.min(c, rows[r - 1].cells.length - 1), 'end')
      else leave('before')
    } else if (dir === 'enter') {
      if (r < last) go(r + 1, Math.min(c, rows[r + 1].cells.length - 1), 'end')
      else addRow(r, true, c)
    }
  }

  /** Back to the text, on the line just above or below the table. */
  function leave (side) {
    const loc = locate(view.state, start())
    finish()
    if (!loc) return
    const doc = view.state.doc
    view.focus()
    if (side === 'before') {
      if (loc.from > 0) view.dispatch({ selection: { anchor: loc.from - 1 }, scrollIntoView: true })
      else view.dispatch({ changes: { from: 0, insert: '\n' }, selection: { anchor: 0 }, scrollIntoView: true })
    } else {
      if (loc.to < doc.length) view.dispatch({ selection: { anchor: loc.to + 1 }, scrollIntoView: true })
      else view.dispatch({ changes: { from: loc.to, insert: '\n' }, selection: { anchor: loc.to + 1 }, scrollIntoView: true })
    }
  }

  function onKey (e) {
    const mod = e.metaKey || e.ctrlKey
    if (mod && !e.altKey && /^[zy]$/i.test(e.key)) {
      // the document's own undo, not the field's
      e.preventDefault()
      const back = e.key.toLowerCase() === 'z' && !e.shiftKey
      finish()
      view.focus()
      ;(back ? undo : redo)(view)
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      move(e.shiftKey ? 'prev' : 'next')
    } else if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault()
      document.execCommand('insertText', false, '<br>')
    } else if (e.key === 'Enter' && !mod) {
      e.preventDefault()
      move('enter')
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      leave('after')
    } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !mod && onEdgeLine(active.field, e.key === 'ArrowUp')) {
      e.preventDefault()
      move(e.key === 'ArrowUp' ? 'up' : 'down')
    }
  }

  /* --------------------------------------------------------- reshaping */

  /** Rewrite the table through its cells, then open cell (r, c) of the new one. */
  function reshape (change, r, c) {
    const loc = current()
    if (!loc) return
    finish()
    const t = parse(loc)
    change(t)
    view.dispatch({ changes: { from: loc.from, to: loc.to, insert: format(t) }, userEvent: 'input.table' })
    if (r != null) hostAt(view, loc.from)?._tableEdit?.edit(r, c, 'end')
  }

  /** A new row below (or above) row r, leaving every other line as it was. */
  function addRow (r, below, focusCol = 0) {
    const loc = current()
    if (!loc) return
    finish()
    const cols = table.rows[0].cells.length
    const text = emptyRow(/^\s*/.exec(loc.lines[0].text)[0], cols)
    // below the header means below the delimiter row
    const at = below ? loc.lines[r === 0 ? 1 : lineIndex(r)].to : loc.lines[lineIndex(r)].from
    view.dispatch({ changes: below ? { from: at, insert: '\n' + text } : { from: at, insert: text + '\n' }, userEvent: 'input.table' })
    hostAt(view, loc.from)?._tableEdit?.edit(below ? r + 1 : Math.max(r, 1), focusCol, 'end')
  }

  function deleteRow (r) {
    const loc = current()
    if (!loc || r === 0) return
    finish()
    const line = loc.lines[lineIndex(r)]
    view.dispatch({ changes: { from: line.from - 1, to: line.to }, userEvent: 'delete.table' })
  }

  const insertColumn = (at) => reshape((t) => {
    for (const row of [t.head, ...t.body]) { while (row.length < at) row.push(''); row.splice(at, 0, '') }
    t.align.splice(at, 0, '')
    if (t.widths) t.widths.splice(at, 0, t.widths.reduce((a, b) => a + b, 0) / t.widths.length)
  }, 0, at)

  const deleteColumn = (c) => reshape((t) => {
    for (const row of [t.head, ...t.body]) row.splice(c, 1)
    t.align.splice(c, 1)
    if (t.widths) t.widths.splice(c, 1)
  })

  const alignColumn = (c, how) => reshape((t) => {
    while (t.align.length < t.head.length) t.align.push('')
    t.align[c] = how
  })

  /* -------------------------------------------------------------- menu */

  function closeMenu () {
    menu?.remove()
    menu = null
    document.removeEventListener('mousedown', outside, true)
    document.removeEventListener('keydown', escape, true)
  }
  const outside = (e) => { if (!menu?.contains(e.target)) closeMenu() }
  const escape = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu() } }

  function openMenu (cell, x, y) {
    closeMenu()
    const r = cell.parentElement.rowIndex
    const c = cell.cellIndex
    const cols = table.rows[0].cells.length
    const loc = current()
    const align = loc ? alignOf(cellsOf(loc.lines[1].text)[c] || '') : ''
    // visual words: in a right-to-left table the column "before" is on the right
    const left = rtl ? c + 1 : c
    const right = rtl ? c : c + 1
    const items = [
      ['Insert row above · ردیف بالا', () => addRow(r, false, c), r > 0],
      ['Insert row below · ردیف پایین', () => addRow(r, true, c), true],
      ['Delete row · حذف ردیف', () => deleteRow(r), r > 0],
      null,
      ['Insert column left · ستون چپ', () => insertColumn(left), true],
      ['Insert column right · ستون راست', () => insertColumn(right), true],
      ['Delete column · حذف ستون', () => deleteColumn(c), cols > 1],
      null,
      [(align === 'left' ? '✓ ' : '') + 'Align left · چپ‌چین', () => alignColumn(c, align === 'left' ? '' : 'left'), true],
      [(align === 'center' ? '✓ ' : '') + 'Align center · وسط‌چین', () => alignColumn(c, align === 'center' ? '' : 'center'), true],
      [(align === 'right' ? '✓ ' : '') + 'Align right · راست‌چین', () => alignColumn(c, align === 'right' ? '' : 'right'), true],
      null,
      ['Edit as Markdown · متن مارک‌داون', () => showSource(), true]
    ]
    menu = document.createElement('div')
    menu.className = 'mmd-menu lp-table-menu'
    for (const item of items) {
      if (!item) { const sep = document.createElement('div'); sep.className = 'lp-menu-sep'; menu.appendChild(sep); continue }
      const [label, run, enabled] = item
      const b = document.createElement('button')
      b.textContent = label
      b.disabled = !enabled
      b.addEventListener('mousedown', (e) => e.preventDefault())
      b.addEventListener('click', () => { closeMenu(); run() })
      menu.appendChild(b)
    }
    host.appendChild(menu)
    const box = host.getBoundingClientRect()
    const w = menu.offsetWidth
    const h = menu.offsetHeight
    menu.style.left = Math.max(0, Math.min(x - box.left, box.width - w)) + 'px'
    menu.style.top = (y - box.top + h > window.innerHeight - box.top ? y - box.top - h : y - box.top) + 'px'
    document.addEventListener('mousedown', outside, true)
    document.addEventListener('keydown', escape, true)
  }

  /* ------------------------------------------------------------ wiring */

  host.addEventListener('mousedown', (e) => {
    if (e.target.closest('.col-resizer, .lp-edit, .lp-cell-field, .lp-table-menu')) return
    const cell = e.target.closest('td, th')
    if (!cell || !table.contains(cell)) return
    // a right-click would otherwise drop the caret into the table and open its source
    if (e.button !== 0) { e.preventDefault(); return }
    const link = e.target.closest('a')
    e.preventDefault()
    if (link && (e.metaKey || e.ctrlKey)) { hooks.openLink(link.getAttribute('href')); return }
    edit(cell, { x: e.clientX, y: e.clientY })
  })
  host.addEventListener('contextmenu', (e) => {
    const cell = e.target.closest('td, th')
    if (!cell || !table.contains(cell)) return
    e.preventDefault()
    openMenu(cell, e.clientX, e.clientY)
  })

  host._tableEdit = { edit: go }
}
