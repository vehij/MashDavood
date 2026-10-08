/* Live Preview: editing in the rendered view, the way Obsidian does it.

   The document stays plain Markdown in CodeMirror — nothing is converted to HTML and
   back, so the file is never rewritten behind the user's back. Decorations make it
   *look* rendered: markup characters (#, **, `, [](…), -, >) are hidden everywhere
   except where the cursor or selection is, and blocks that only make sense rendered —
   Mermaid diagrams, tables, math, images, front matter, rules — are replaced by
   widgets until the cursor goes into them. While a diagram's source is open, its
   rendering stays visible underneath and follows every keystroke.

   The app supplies the rendering through `hooks` (see app.js → liveHooks), so this
   module only decides *what* is shown where. */

import { EditorView, Decoration, WidgetType } from '@codemirror/view'
import { StateField, StateEffect } from '@codemirror/state'
import { syntaxTree, ensureSyntaxTree } from '@codemirror/language'
import { attachTableEditing } from './table-edit.js'
import { estimateDirection, markdownDirectionText } from './direction.mjs'

/** Re-render every widget (theme change, settings that affect rendering). */
export const refreshLive = StateEffect.define()

const LAYOUT_LINE = /^\s*%%\s*mashdavood\b.*$/gm
const stripLayout = (s) => s.replace(LAYOUT_LINE, '').replace(/\n{2,}$/, '\n')
const TABLE_WIDTHS = /^\s*<!--\s*mashdavood\s+widths:[^>]*-->\s*$/
const CALLOUT = /^\[!(\w+)\]/

/* ------------------------------------------------------------- widgets */

class BlockWidget extends WidgetType {
  constructor (hooks, epoch) { super(); this.hooks = hooks; this.epoch = epoch }
  get estimatedHeight () { return 120 }
  /* the widget handles its own mouse and key events (diagram toolbar, column resize,
     click-to-edit); CodeMirror must not move the cursor for them */
  ignoreEvent () { return true }
}

/** Click (or double-click for diagrams) puts the cursor into the block's source. */
function revealOnClick (dom, view, { dbl = false } = {}) {
  dom.addEventListener(dbl ? 'dblclick' : 'mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('.mmd-tools, .mmd-resize, .mmd-menu, .col-resizer, .lp-edit, a, input')) return
    e.preventDefault()
    revealBlock(view, dom)
  })
}

function revealBlock (view, dom) {
  const pos = view.posAtDOM(dom)
  const line = view.state.doc.lineAt(pos)
  // first line of the source, after the fence / opening line, is the natural place
  const target = line.number < view.state.doc.lines ? view.state.doc.line(line.number + 1).from : line.to
  view.dispatch({ selection: { anchor: target }, scrollIntoView: false })
  view.focus()
}

function editButton (view, dom, label) {
  const b = document.createElement('button')
  b.className = 'lp-edit'
  b.title = label
  b.innerHTML = '<svg viewBox="0 0 20 20" width="13" height="13"><path d="M7 6 3 10l4 4M13 6l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  b.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); revealBlock(view, dom) })
  return b
}

class MermaidWidget extends BlockWidget {
  constructor (hooks, epoch, source, key, preview) {
    super(hooks, epoch)
    this.source = source        // the fence's content, layout line included
    this.code = stripLayout(source)
    this.key = key
    this.preview = preview      // shown under the open source: no toolbar, no editing
  }

  eq (o) { return o.source === this.source && o.key === this.key && o.epoch === this.epoch && o.preview === this.preview }

  /* writing the layout line (zoom / arrange) changes the source but not the drawing:
     keep the live DOM instead of rendering the diagram again */
  updateDOM (dom) {
    if (dom._lp?.code !== this.code || dom._lp?.epoch !== this.epoch || dom._lp?.preview !== this.preview) return false
    dom.querySelector('.mermaid-block').dataset.src = this.source
    dom._lp = { code: this.code, epoch: this.epoch, preview: this.preview }
    return true
  }

  toDOM (view) {
    const host = document.createElement('div')
    host.className = 'lp-block lp-mermaid markdown-body' + (this.preview ? ' lp-preview' : '')
    host._lp = { code: this.code, epoch: this.epoch, preview: this.preview }
    const block = document.createElement('div')
    block.className = 'mermaid-block'
    block.dir = 'ltr'
    block.dataset.src = this.source
    const pre = document.createElement('pre')
    pre.className = 'mermaid-source'
    pre.textContent = this.source
    block.appendChild(pre)
    host.appendChild(block)
    if (!this.preview) {
      host.appendChild(editButton(view, host, 'Edit diagram source (or double-click the diagram)'))
      revealOnClick(host, view, { dbl: true })
    }
    this.hooks.renderMermaid(block, this.key, { preview: this.preview })
    return host
  }
}

class TableWidget extends BlockWidget {
  constructor (hooks, epoch, source) {
    super(hooks, epoch)
    this.source = source        // the widths comment (if any) + the table
    this.table = source.split('\n').filter((l) => !TABLE_WIDTHS.test(l)).join('\n')
  }

  eq (o) { return o.source === this.source && o.epoch === this.epoch }

  /* keep the DOM when it already shows the new text: a widths comment written by
     dragging a column, or a cell typed into right here */
  updateDOM (dom) {
    if (!dom._lp || dom._lp.epoch !== this.epoch) return false
    if (dom._lp.table !== this.table && dom._lp.expect !== this.table) return false
    Object.assign(dom._lp, { table: this.table, source: this.source, expect: null })
    return true
  }

  toDOM (view) {
    const host = document.createElement('div')
    host.className = 'lp-block lp-table markdown-body'
    host._lp = { table: this.table, source: this.source, epoch: this.epoch, expect: null }
    host.innerHTML = this.hooks.renderTable(this.source)
    this.hooks.decorateTable(host)
    const rtl = host.querySelector('table')?.getAttribute('dir') === 'rtl'
    const button = editButton(view, host, 'Edit the table as Markdown (right-click a cell for rows and columns)')
    if (!rtl) button.classList.add('lp-edit-right')
    host.appendChild(button)
    attachTableEditing(host, view, this.hooks, () => revealBlock(view, host))
    return host
  }
}

class MathWidget extends WidgetType {
  constructor (hooks, tex, display) { super(); this.hooks = hooks; this.tex = tex; this.display = display }
  eq (o) { return o.tex === this.tex && o.display === this.display }
  ignoreEvent () { return false }
  toDOM () {
    const el = document.createElement(this.display ? 'div' : 'span')
    el.className = this.display ? 'lp-math-block markdown-body' : 'lp-math'
    el.dir = 'ltr'
    el.innerHTML = this.hooks.renderMath(this.tex, this.display)
    return el
  }
}

class FrontMatterWidget extends BlockWidget {
  constructor (hooks, epoch, text) { super(hooks, epoch); this.text = text }
  eq (o) { return o.text === this.text && o.epoch === this.epoch }
  toDOM (view) {
    const host = document.createElement('div')
    host.className = 'lp-block lp-frontmatter markdown-body'
    host.innerHTML = this.hooks.renderFrontMatter(this.text)
    revealOnClick(host, view)
    return host
  }
}

class ImageWidget extends WidgetType {
  constructor (hooks, src, alt) { super(); this.hooks = hooks; this.src = src; this.alt = alt }
  eq (o) { return o.src === this.src && o.alt === this.alt }
  ignoreEvent () { return false }
  toDOM () {
    const img = document.createElement('img')
    img.className = 'lp-image'
    img.src = this.hooks.resolveImage(this.src)
    img.alt = this.alt
    img.loading = 'lazy'
    return img
  }
}

class HrWidget extends WidgetType {
  eq () { return true }
  ignoreEvent () { return false }
  toDOM () { const hr = document.createElement('span'); hr.className = 'lp-hr'; return hr }
}

class BulletWidget extends WidgetType {
  eq () { return true }
  ignoreEvent () { return false }
  toDOM () { const s = document.createElement('span'); s.className = 'lp-bullet'; s.textContent = '•'; return s }
}

class CheckboxWidget extends WidgetType {
  constructor (checked, pos) { super(); this.checked = checked; this.pos = pos }
  eq (o) { return o.checked === this.checked && o.pos === this.pos }
  ignoreEvent () { return true }
  toDOM (view) {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'lp-task'
    box.checked = this.checked
    box.addEventListener('mousedown', (e) => {
      e.preventDefault()
      // "[ ]" ↔ "[x]": the character between the brackets
      view.dispatch({ changes: { from: this.pos + 1, to: this.pos + 2, insert: this.checked ? ' ' : 'x' } })
    })
    return box
  }
}

class CalloutLabel extends WidgetType {
  constructor (type) { super(); this.type = type }
  eq (o) { return o.type === this.type }
  ignoreEvent () { return false }
  toDOM () {
    const s = document.createElement('span')
    s.className = 'lp-callout-label'
    s.textContent = this.type.charAt(0) + this.type.slice(1).toLowerCase()
    return s
  }
}

/* --------------------------------------------------------- decorations */

const hide = Decoration.replace({})
const mark = (cls) => Decoration.mark({ class: cls })
const line = (cls) => Decoration.line({ class: cls })

function build (state, hooks, epoch) {
  const doc = state.doc
  const tree = ensureSyntaxTree(state, doc.length, 250) || syntaxTree(state)
  const ranges = state.selection.ranges
  const touches = (from, to) => ranges.some((r) => r.from <= to && r.to >= from)
  const linesOf = (from, to) => [doc.lineAt(from).from, doc.lineAt(to).to]
  const lineTouched = (from, to) => touches(...linesOf(from, to))
  const out = []
  const add = (from, to, deco) => { if (from <= to) out.push(deco.range(from, to)) }
  // block decorations must cover whole lines (a fence may be indented inside a list item)
  const block = (from, to, widget) => add(doc.lineAt(from).from, doc.lineAt(to).to, Decoration.replace({ widget, block: true }))
  const lineDeco = (from, to, cls) => {
    for (let n = doc.lineAt(from).number, end = doc.lineAt(to).number; n <= end; n++) add(doc.line(n).from, doc.line(n).from, line(cls))
  }
  const skip = []                       // ranges handled as a whole (front matter, math blocks)
  const skipped = (from, to = from) => skip.some(([a, b]) => from >= a && to <= b)

  /* front matter: --- … --- at the very top */
  const fm = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(doc.sliceString(0, Math.min(doc.length, 20000)))
  if (fm) {
    const end = fm[0].replace(/\r?\n$/, '').length
    skip.push([0, end])
    if (!touches(0, end)) block(0, end, new FrontMatterWidget(hooks, epoch, fm[1]))
    else lineDeco(0, end, 'lp-code-line')
  }

  /* code ranges, so math is not looked for inside code */
  const code = []
  const tables = new Set()             // first line of every table
  tree.iterate({
    enter (n) {
      if (n.name === 'FencedCode' || n.name === 'CodeBlock' || n.name === 'InlineCode') code.push([n.from, n.to])
      else if (n.name === 'Table') tables.add(doc.lineAt(n.from).from)
    }
  })
  const inCode = (pos) => code.some(([a, b]) => pos >= a && pos < b)
  const tableAt = (lineStart) => tables.has(lineStart)

  /* $$ … $$ blocks */
  for (let n = 1; n <= doc.lines; n++) {
    const l = doc.line(n)
    if (!/^\s*\$\$/.test(l.text) || inCode(l.from) || skipped(l.from)) continue
    let endLine = null
    const rest = l.text.trim().slice(2)
    if (rest.trim().endsWith('$$') && rest.trim().length > 2) endLine = l
    else for (let k = n + 1; k <= doc.lines; k++) if (/\$\$\s*$/.test(doc.line(k).text)) { endLine = doc.line(k); break }
    if (!endLine) continue
    const tex = doc.sliceString(l.from, endLine.to).trim().replace(/^\$\$/, '').replace(/\$\$$/, '').trim()
    skip.push([l.from, endLine.to])
    if (!touches(l.from, endLine.to)) block(l.from, endLine.to, new MathWidget(hooks, tex, true))
    else lineDeco(l.from, endLine.to, 'lp-code-line')
    n = endLine.number
  }

  const diagramSeen = new Map()

  tree.iterate({
    enter (node) {
      if (skipped(node.from, node.to)) return false
      const name = node.name

      if (/^ATXHeading[1-6]$/.test(name)) {
        lineDeco(node.from, node.from, 'lp-h lp-h' + name.slice(-1))
        if (!lineTouched(node.from, node.to)) {
          const m = node.node.getChild('HeaderMark')
          if (m && m.from === node.from) {
            const after = doc.sliceString(m.to, m.to + 1) === ' ' ? m.to + 1 : m.to
            add(m.from, after, hide)
          }
          // closing #s
          const marks = node.node.getChildren('HeaderMark')
          if (marks.length > 1) { const last = marks[marks.length - 1]; add(last.from, last.to, hide) }
        }
        return
      }
      if (name === 'SetextHeading1' || name === 'SetextHeading2') {
        lineDeco(node.from, node.from, 'lp-h lp-h' + name.slice(-1))
        return
      }

      if (name === 'StrongEmphasis' || name === 'Emphasis' || name === 'Strikethrough' || name === 'InlineCode') {
        const cls = { StrongEmphasis: 'lp-strong', Emphasis: 'lp-em', Strikethrough: 'lp-strike', InlineCode: 'lp-code' }[name]
        add(node.from, node.to, mark(cls))
        if (!touches(node.from, node.to)) {
          const markName = { StrongEmphasis: 'EmphasisMark', Emphasis: 'EmphasisMark', Strikethrough: 'StrikethroughMark', InlineCode: 'CodeMark' }[name]
          for (const m of node.node.getChildren(markName)) add(m.from, m.to, hide)
        }
        return name === 'InlineCode' ? false : undefined
      }

      if (name === 'Link') {
        const url = node.node.getChild('URL')
        const marks = node.node.getChildren('LinkMark')
        if (marks.length >= 2) {
          const textFrom = marks[0].to
          const textTo = marks[1].from
          add(textFrom, textTo, Decoration.mark({ class: 'lp-link', attributes: { 'data-href': url ? doc.sliceString(url.from, url.to) : '' } }))
          if (!touches(node.from, node.to)) {
            add(marks[0].from, marks[0].to, hide)
            add(marks[1].from, node.to, hide)       // "](url "title")"
          }
        }
        return false
      }
      if (name === 'URL' || name === 'Autolink') {
        const href = doc.sliceString(node.from, node.to).replace(/^<|>$/g, '')
        add(node.from, node.to, Decoration.mark({ class: 'lp-link', attributes: { 'data-href': href } }))
        return false
      }

      if (name === 'Image') {
        const url = node.node.getChild('URL')
        const marks = node.node.getChildren('LinkMark')
        if (url && marks.length >= 2 && !lineTouched(node.from, node.to)) {
          const alt = doc.sliceString(marks[0].to, marks[1].from)
          add(node.from, node.to, Decoration.replace({ widget: new ImageWidget(hooks, doc.sliceString(url.from, url.to), alt) }))
        }
        return false
      }

      if (name === 'ListMark') {
        const parent = node.node.parent
        const task = parent?.getChild('Task')
        const isBullet = /^[-*+]$/.test(doc.sliceString(node.from, node.to))
        if (task && !lineTouched(node.from, node.to)) {
          // "- [ ] " becomes just the checkbox
          add(node.from, task.from, hide)
        } else if (isBullet && !lineTouched(node.from, node.to)) {
          add(node.from, node.to, Decoration.replace({ widget: new BulletWidget() }))
        } else {
          add(node.from, node.to, mark('lp-listmark'))
        }
        return
      }
      if (name === 'TaskMarker') {
        const checked = /x/i.test(doc.sliceString(node.from, node.to))
        if (!lineTouched(node.from, node.to)) {
          const after = doc.sliceString(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to
          add(node.from, after, Decoration.replace({ widget: new CheckboxWidget(checked, node.from) }))
        }
        if (checked) lineDeco(node.from, node.from, 'lp-task-done')
        return
      }

      if (name === 'Blockquote') {
        const first = doc.sliceString(node.from, Math.min(node.to, node.from + 40)).replace(/^\s*>\s*/, '')
        const callout = CALLOUT.exec(first)
        lineDeco(node.from, node.to, 'lp-quote' + (callout ? ' lp-callout lp-callout-' + calloutClass(callout[1]) : ''))
        if (callout) {
          // the title line ("[!NOTE]", Latin) takes the direction of the callout's text
          const body = doc.sliceString(doc.lineAt(node.from).to, node.to)
          add(node.from, node.from, line(estimateDirection(markdownDirectionText(body)) === 'rtl' ? 'lp-dir-rtl' : 'lp-dir-ltr'))
        }
        if (callout && !lineTouched(node.from, node.from)) {
          const at = doc.sliceString(node.from, node.to).indexOf(callout[0])
          if (at >= 0) add(node.from + at, node.from + at + callout[0].length, Decoration.replace({ widget: new CalloutLabel(callout[1].toUpperCase()) }))
        }
        return
      }
      if (name === 'QuoteMark') {
        if (!lineTouched(node.from, node.to)) {
          const after = doc.sliceString(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to
          add(node.from, after, hide)
        }
        return
      }

      if (name === 'HorizontalRule') {
        if (!lineTouched(node.from, node.to)) add(node.from, node.to, Decoration.replace({ widget: new HrWidget() }))
        return
      }

      if (name === 'FencedCode') {
        const info = node.node.getChild('CodeInfo')
        const lang = info ? doc.sliceString(info.from, info.to).trim().split(/\s+/)[0].toLowerCase() : ''
        const text = node.node.getChild('CodeText')
        const source = text ? doc.sliceString(text.from, text.to) + '\n' : ''
        if (lang === 'mermaid') {
          const head = (stripLayout(source).trim().split('\n')[0] || '').trim()
          const n = diagramSeen.get(head) || 0
          diagramSeen.set(head, n + 1)
          const key = head + '#' + n
          if (!lineTouched(node.from, node.to)) {
            block(node.from, node.to, new MermaidWidget(hooks, epoch, source, key, false))
          } else {
            lineDeco(node.from, node.to, 'lp-code-line')
            const end = doc.lineAt(node.to).to
            add(end, end, Decoration.widget({ widget: new MermaidWidget(hooks, epoch, source, key, true), block: true, side: 1 }))
          }
          return false
        }
        if (lang === 'math' || lang === 'katex') {
          if (!lineTouched(node.from, node.to)) {
            block(node.from, node.to, new MathWidget(hooks, source, true))
            return false
          }
        }
        lineDeco(node.from, node.to, 'lp-code-line')
        const lines = [doc.lineAt(node.from), doc.lineAt(node.to)]
        if (!lineTouched(node.from, node.to)) for (const l of lines) add(l.from, l.from, line('lp-fence'))
        return false
      }

      if (name === 'Table') {
        // the widths comment right above belongs to the table
        let from = node.from
        const prev = doc.lineAt(node.from).number > 1 ? doc.line(doc.lineAt(node.from).number - 1) : null
        if (prev && TABLE_WIDTHS.test(prev.text)) from = prev.from
        if (!lineTouched(from, node.to)) {
          block(from, node.to, new TableWidget(hooks, epoch, doc.sliceString(doc.lineAt(from).from, doc.lineAt(node.to).to)))
        } else {
          lineDeco(from, node.to, 'lp-table-line')
        }
        return false
      }

      if (name === 'CommentBlock' || name === 'HTMLBlock') {
        const text = doc.sliceString(node.from, node.to)
        // a widths comment right above a table is part of the table's widget
        const next = doc.lineAt(node.to).number < doc.lines ? doc.line(doc.lineAt(node.to).number + 1) : null
        if (TABLE_WIDTHS.test(text) && next && tableAt(next.from)) return false
        if (/^\s*<!--\s*mashdavood\b/.test(text) && !lineTouched(node.from, node.to)) {
          add(doc.lineAt(node.from).from, doc.lineAt(node.to).to, Decoration.replace({ block: true }))
        }
        return false
      }
    }
  })

  /* inline $math$ outside code */
  for (const { from, to } of [{ from: 0, to: doc.length }]) {
    const text = doc.sliceString(from, to)
    const re = /(^|[^\\$])\$([^\s$](?:[^$\n]*?[^\s\\$])?)\$(?![\d$])/g
    let m
    while ((m = re.exec(text))) {
      const start = from + m.index + m[1].length
      const end = start + m[2].length + 2
      if (inCode(start) || skipped(start)) continue
      if (!touches(start, end)) add(start, end, Decoration.replace({ widget: new MathWidget(hooks, m[2], false) }))
      else add(start, end, mark('lp-code'))
    }
  }

  return Decoration.set(out, true)
}

const calloutClass = (t) => ({ NOTE: 'note', INFO: 'note', TIP: 'tip', IMPORTANT: 'tip', WARNING: 'warning', CAUTION: 'warning', DANGER: 'danger' }[t.toUpperCase()] || 'note')

/* ---------------------------------------------------------------- setup */

export function livePreview (hooks) {
  let epoch = 0
  const field = StateField.define({
    create: (state) => build(state, hooks, epoch),
    update (deco, tr) {
      if (tr.effects.some((e) => e.is(refreshLive))) { epoch++; return build(tr.state, hooks, epoch) }
      if (tr.docChanged || tr.selection || syntaxTree(tr.state) !== syntaxTree(tr.startState)) return build(tr.state, hooks, epoch)
      return deco
    },
    provide: (f) => EditorView.decorations.from(f)
  })

  // ⌘/Ctrl-click opens a link; a plain click edits it, as everywhere else in the text
  const links = EditorView.domEventHandlers({
    mousedown (e) {
      const link = e.target.closest?.('.lp-link')
      if (!link || !(e.metaKey || e.ctrlKey)) return false
      e.preventDefault()
      hooks.openLink(link.dataset.href || link.textContent)
      return true
    }
  })

  return [field, links, EditorView.editorAttributes.of({ class: 'cm-live' })]
}
