import { EditorView, keymap, dropCursor, highlightActiveLine, rectangularSelection, crosshairCursor, placeholder, Decoration, ViewPlugin } from '@codemirror/view'
import { EditorState, Compartment, EditorSelection, RangeSetBuilder } from '@codemirror/state'
import { firstStrongDirection } from './markdown.js'
import { history, defaultKeymap, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { syntaxHighlighting, HighlightStyle, bracketMatching, indentUnit } from '@codemirror/language'
import { searchKeymap, highlightSelectionMatches, openSearchPanel, search } from '@codemirror/search'
import { tags as t } from '@lezer/highlight'

const mdHighlight = HighlightStyle.define([
  { tag: t.heading1, class: 'cm-md-heading cm-md-h1' },
  { tag: t.heading2, class: 'cm-md-heading cm-md-h2' },
  { tag: t.heading3, class: 'cm-md-heading cm-md-h3' },
  { tag: [t.heading4, t.heading5, t.heading6, t.heading], class: 'cm-md-heading' },
  { tag: t.strong, class: 'cm-md-strong' },
  { tag: t.emphasis, class: 'cm-md-emphasis' },
  { tag: t.strikethrough, class: 'cm-md-strike' },
  { tag: [t.link, t.labelName], class: 'cm-md-link' },
  { tag: t.url, class: 'cm-md-url' },
  { tag: [t.monospace, t.special(t.string)], class: 'cm-md-code' },
  { tag: t.quote, class: 'cm-md-quote' },
  { tag: t.list, class: 'cm-md-list' },
  { tag: t.contentSeparator, class: 'cm-md-hr' },
  { tag: [t.processingInstruction, t.punctuation], class: 'cm-md-mark' },
  { tag: [t.meta, t.comment], class: 'cm-md-meta' },
  { tag: t.keyword, class: 'cm-md-link' },
  { tag: [t.string], class: 'cm-md-quote' },
  { tag: [t.atom, t.bool, t.number], class: 'cm-md-code' }
])

/* --------------------------------------------------------------------------
   Per-line text direction: markdown markers (-, 1., >, #, [x]) are neutral
   characters, so a Persian list item would otherwise be resolved left-to-right.
   We look past the markers, then pin the line's direction explicitly.
   -------------------------------------------------------------------------- */

const MD_PREFIX = /^(?:[\s>]*(?:[-*+]|\d+[.)])?\s*)*(?:\[[ xX]\]\s*)?(?:#{1,6}\s*)?/
const rtlLine = Decoration.line({ class: 'cm-line-rtl' })
const ltrLine = Decoration.line({ class: 'cm-line-ltr' })

const lineDirection = ViewPlugin.fromClass(class {
  constructor (view) { this.decorations = this.build(view) }
  update (u) { if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view) }
  build (view) {
    const builder = new RangeSetBuilder()
    for (const { from, to } of view.visibleRanges) {
      for (let pos = from; pos <= to;) {
        const line = view.state.doc.lineAt(pos)
        if (line.length) {
          const stripped = line.text.replace(MD_PREFIX, '')
          const probe = stripped.trim() ? stripped : line.text
          let dir = null
          for (const ch of probe) {
            if (/[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/.test(ch)) { dir = 'rtl'; break }
            if (/[A-Za-z\u00C0-\u024F]/.test(ch)) { dir = 'ltr'; break }
          }
          if (dir === 'rtl') builder.add(line.from, line.from, rtlLine)
          else if (dir === 'ltr') builder.add(line.from, line.from, ltrLine)
        }
        pos = line.to + 1
      }
    }
    return builder.finish()
  }
}, { decorations: (v) => v.decorations })

export class MarkdownEditor {
  constructor (host, { onChange, onCursor, onScroll, onSave, spellcheck = false }) {
    this.onChange = onChange
    this.onCursor = onCursor
    this.onScroll = onScroll
    this.suppress = false
    this.spellcheckComp = new Compartment()
    this.readonlyComp = new Compartment()
    this.historyComp = new Compartment()

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged && !this.suppress) this.onChange?.(update.state.doc.toString())
      if (update.selectionSet || update.docChanged) {
        const head = update.state.selection.main.head
        const line = update.state.doc.lineAt(head)
        this.onCursor?.({ line: line.number, col: head - line.from + 1, selected: update.state.selection.main.to - update.state.selection.main.from })
      }
    })

    const domHandlers = EditorView.domEventHandlers({
      scroll: () => { this.onScroll?.(); return false }
    })

    this.extensions = [
      this.historyComp.of(history()),
      dropCursor(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      bracketMatching(),
      search({ top: false }),
      EditorView.lineWrapping,
      EditorView.perLineTextDirection.of(true),
      lineDirection,
      indentUnit.of('  '),
      markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: true }),
      syntaxHighlighting(mdHighlight),
      placeholder('… شروع کنید / start typing'),
      keymap.of([
        { key: 'Mod-s', run: () => { onSave?.(); return true } },
        { key: 'Mod-f', run: openSearchPanel },
        ...searchKeymap.filter((k) => k.key !== 'Mod-f'),
        ...defaultKeymap,
        ...historyKeymap,
        indentWithTab
      ]),
      this.spellcheckComp.of(EditorView.contentAttributes.of({ spellcheck: String(spellcheck), autocorrect: 'off', autocapitalize: 'off' })),
      this.readonlyComp.of([]),
      updateListener,
      domHandlers
    ]

    this.view = new EditorView({
      parent: host,
      state: this.createState('')
    })
  }

  /** A fresh state — every tab owns one, so undo history never crosses documents. */
  createState (doc) {
    return EditorState.create({ doc, extensions: this.extensions })
  }

  setState (state) {
    this.suppress = true
    this.view.setState(state)
    this.suppress = false
  }

  get state () { return this.view.state }

  focus () { this.view.focus() }

  getValue () { return this.view.state.doc.toString() }

  /** Safe full replace that keeps all extensions, optionally resetting undo history. */
  /** Swap the whole document for a fresh state (used for external file reloads). */
  replaceAll (text) {
    this.setState(this.createState(text))
  }

  setSpellcheck (on) {
    this.view.dispatch({
      effects: this.spellcheckComp.reconfigure(
        EditorView.contentAttributes.of({ spellcheck: String(!!on), autocorrect: 'off', autocapitalize: 'off' })
      )
    })
  }

  setReadOnly (on) {
    this.view.dispatch({ effects: this.readonlyComp.reconfigure(on ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []) })
  }

  getScrollInfo () {
    const sc = this.view.scrollDOM
    return { top: sc.scrollTop, height: sc.scrollHeight, client: sc.clientHeight }
  }

  setScrollTop (top) { this.view.scrollDOM.scrollTop = top }

  /** First document line that is visible at the top of the viewport. */
  topLine () {
    const sc = this.view.scrollDOM
    const block = this.view.lineBlockAtHeight(sc.scrollTop - this.view.documentTop + 1)
    try { return this.view.state.doc.lineAt(block.from).number - 1 } catch { return 0 }
  }

  /** Fractional progress through the top visible line, for smooth sync. */
  topLineFraction () {
    const sc = this.view.scrollDOM
    const y = sc.scrollTop - this.view.documentTop
    const block = this.view.lineBlockAtHeight(y + 1)
    const frac = block.height ? Math.min(1, Math.max(0, (y - block.top) / block.height)) : 0
    return { line: this.view.state.doc.lineAt(block.from).number - 1, frac }
  }

  scrollToLine (line, { center = false } = {}) {
    const doc = this.view.state.doc
    const n = Math.min(Math.max(1, line + 1), doc.lines)
    const pos = doc.line(n).from
    this.view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: center ? 'center' : 'start', yMargin: center ? 0 : 8 }) })
  }

  cursorToLine (line) {
    const doc = this.view.state.doc
    const n = Math.min(Math.max(1, line + 1), doc.lines)
    const pos = doc.line(n).from
    this.view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) })
    this.view.focus()
  }

  openSearch () { openSearchPanel(this.view) }

  /* ------------------------------------------------------ formatting */

  wrap (before, after = before) {
    const view = this.view
    const changes = []
    const ranges = []
    for (const range of view.state.selection.ranges) {
      const text = view.state.sliceDoc(range.from, range.to)
      const already = text.startsWith(before) && text.endsWith(after) && text.length >= before.length + after.length
      if (already) {
        const inner = text.slice(before.length, text.length - after.length)
        changes.push({ from: range.from, to: range.to, insert: inner })
        ranges.push(EditorSelection.range(range.from, range.from + inner.length))
      } else {
        changes.push({ from: range.from, to: range.to, insert: before + text + after })
        ranges.push(text
          ? EditorSelection.range(range.from + before.length, range.from + before.length + text.length)
          : EditorSelection.cursor(range.from + before.length))
      }
    }
    view.dispatch({ changes, selection: EditorSelection.create(ranges, view.state.selection.mainIndex), scrollIntoView: true })
    view.focus()
  }

  toggleLinePrefix (prefix, { ordered = false } = {}) {
    const view = this.view
    const state = view.state
    const changes = []
    const seen = new Set()
    for (const range of state.selection.ranges) {
      const startLine = state.doc.lineAt(range.from).number
      const endLine = state.doc.lineAt(range.to).number
      let counter = 1
      for (let n = startLine; n <= endLine; n++) {
        if (seen.has(n)) continue
        seen.add(n)
        const line = state.doc.line(n)
        const text = line.text
        const actual = ordered ? `${counter}. ` : prefix
        const existing = ordered ? /^(\s*)\d+\.\s+/ : new RegExp('^(\\s*)' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        const m = existing.exec(text)
        if (m) {
          changes.push({ from: line.from + m[1].length, to: line.from + m[0].length, insert: '' })
        } else {
          const indent = /^\s*/.exec(text)[0]
          changes.push({ from: line.from + indent.length, insert: actual })
        }
        counter++
      }
    }
    view.dispatch({ changes, scrollIntoView: true })
    view.focus()
  }

  toggleHeading (level) {
    const view = this.view
    const state = view.state
    const changes = []
    const seen = new Set()
    for (const range of state.selection.ranges) {
      const a = state.doc.lineAt(range.from).number
      const b = state.doc.lineAt(range.to).number
      for (let n = a; n <= b; n++) {
        if (seen.has(n)) continue
        seen.add(n)
        const line = state.doc.line(n)
        const m = /^(#{1,6})\s+/.exec(line.text)
        const target = '#'.repeat(level) + ' '
        if (m && m[1].length === level) changes.push({ from: line.from, to: line.from + m[0].length, insert: '' })
        else if (m) changes.push({ from: line.from, to: line.from + m[0].length, insert: target })
        else changes.push({ from: line.from, insert: target })
      }
    }
    view.dispatch({ changes, scrollIntoView: true })
    view.focus()
  }

  insertBlock (text) {
    const view = this.view
    const range = view.state.selection.main
    const line = view.state.doc.lineAt(range.from)
    const atLineStart = range.from === line.from
    const prefix = atLineStart ? '' : '\n\n'
    const insert = prefix + text + '\n'
    view.dispatch({
      changes: { from: range.from, to: range.to, insert },
      selection: { anchor: range.from + insert.length },
      scrollIntoView: true
    })
    view.focus()
  }

  insertLink () {
    const view = this.view
    const range = view.state.selection.main
    const text = view.state.sliceDoc(range.from, range.to)
    if (/^https?:\/\//i.test(text)) {
      const insert = `[](${text})`
      view.dispatch({ changes: { from: range.from, to: range.to, insert }, selection: { anchor: range.from + 1 } })
    } else {
      const insert = `[${text}]()`
      view.dispatch({ changes: { from: range.from, to: range.to, insert }, selection: { anchor: range.from + insert.length - 1 } })
    }
    view.focus()
  }

  destroy () { this.view.destroy() }
}
