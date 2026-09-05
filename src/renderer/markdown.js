import MarkdownIt from 'markdown-it'
import anchor from 'markdown-it-anchor'
import taskLists from 'markdown-it-task-lists'
import footnote from 'markdown-it-footnote'
import deflist from 'markdown-it-deflist'
import markPlugin from 'markdown-it-mark'
import sub from 'markdown-it-sub'
import sup from 'markdown-it-sup'
import hljs from 'highlight.js/lib/common'
import katex from 'katex'
import DOMPurify from 'dompurify'

/* ------------------------------------------------------------- helpers */

const RTL_CHARS = '֐-׿؀-ۿ܀-ݏݐ-ݿހ-޿ࢠ-ࣿיִ-﷿ﹰ-﻿'
const RTL_RE = new RegExp('[' + RTL_CHARS + ']')
const RTL_G = new RegExp('[' + RTL_CHARS + ']', 'g')
const LTR_RE = /[A-Za-zÀ-ɏ]/

/** Detect the dominant direction of a chunk of text. */
export function detectDirection (text) {
  if (!text) return 'ltr'
  const sample = text.length > 6000 ? text.slice(0, 6000) : text
  const rtl = (sample.match(RTL_G) || []).length
  const ltr = (sample.match(/[A-Za-z]/g) || []).length
  return rtl > 8 && rtl > ltr * 0.35 ? 'rtl' : 'ltr'
}

export function firstStrongDirection (text) {
  for (const ch of text || '') {
    if (RTL_RE.test(ch)) return 'rtl'
    if (LTR_RE.test(ch)) return 'ltr'
  }
  return 'ltr'
}

export function slugify (str) {
  return String(str)
    .trim()
    .toLowerCase()
    .replace(/[\s‌]+/g, '-')
    .replace(/[^\p{L}\p{N}\-_]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '') || 'section'
}

/** file:// URL for a local path — handles Windows drive letters and backslashes. */
export function toFileUrl (dir, rel) {
  const base = String(dir).replace(/\\/g, '/').replace(/\/$/, '')
  const joined = base + '/' + String(rel).replace(/\\/g, '/')
  const prefixed = joined.startsWith('/') ? joined : '/' + joined
  return 'file://' + encodeURI(prefixed).replace(/#/g, '%23')
}

const escapeAttr = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  .replace(/</g, '&lt;').replace(/>/g, '&gt;')

/* --------------------------------------------------------- math plugin */

function mathPlugin (md) {
  function inlineMath (state, silent) {
    const start = state.pos
    if (state.src.charCodeAt(start) !== 0x24 /* $ */) return false
    if (state.src.charCodeAt(start + 1) === 0x24) return false
    let pos = start + 1
    let found = -1
    while (pos < state.src.length) {
      const c = state.src.charCodeAt(pos)
      if (c === 0x5c) { pos += 2; continue }
      if (c === 0x24) { found = pos; break }
      if (c === 0x0a) return false
      pos++
    }
    if (found < 0 || found === start + 1) return false
    // "$5 and $6" should not become math
    const content = state.src.slice(start + 1, found)
    if (/^\s|\s$/.test(content)) return false
    if (!silent) {
      const token = state.push('math_inline', 'math', 0)
      token.markup = '$'
      token.content = content
    }
    state.pos = found + 1
    return true
  }

  function blockMath (state, startLine, endLine, silent) {
    const startPos = state.bMarks[startLine] + state.tShift[startLine]
    const max = state.eMarks[startLine]
    if (startPos + 2 > max) return false
    if (state.src.slice(startPos, startPos + 2) !== '$$') return false
    let firstLine = state.src.slice(startPos + 2, max).trim()
    let line = startLine
    let content = ''
    let closed = firstLine.endsWith('$$') && firstLine.length > 1
    if (closed) {
      content = firstLine.slice(0, -2)
    } else {
      content = firstLine ? firstLine + '\n' : ''
      while (++line < endLine) {
        const pos = state.bMarks[line] + state.tShift[line]
        const lmax = state.eMarks[line]
        const text = state.src.slice(pos, lmax)
        if (text.trim().endsWith('$$')) {
          content += text.trim().slice(0, -2)
          closed = true
          break
        }
        content += text + '\n'
      }
    }
    if (!closed) return false
    if (silent) return true
    state.line = line + 1
    const token = state.push('math_block', 'math', 0)
    token.block = true
    token.content = content
    token.markup = '$$'
    token.map = [startLine, state.line]
    return true
  }

  md.inline.ruler.before('escape', 'math_inline', inlineMath)
  md.block.ruler.before('fence', 'math_block', blockMath, { alt: ['paragraph', 'reference', 'blockquote', 'list'] })

  const render = (content, display) => {
    try {
      return katex.renderToString(content, { displayMode: display, throwOnError: false, output: 'html', strict: false })
    } catch (e) {
      return `<span class="math-error">${escapeAttr(content)}</span>`
    }
  }
  md.renderer.rules.math_inline = (tokens, idx) => render(tokens[idx].content, false)
  md.renderer.rules.math_block = (tokens, idx) => {
    const line = tokens[idx].map ? tokens[idx].map[0] : 0
    return `<div class="katex-display-wrap" data-line="${line}" dir="ltr">${render(tokens[idx].content, true)}</div>\n`
  }
}

/* ------------------------------------------------------- callout plugin */

const CALLOUTS = {
  NOTE: { cls: 'note', icon: '❖', label: 'Note' },
  INFO: { cls: 'note', icon: 'ℹ', label: 'Info' },
  TIP: { cls: 'tip', icon: '✦', label: 'Tip' },
  IMPORTANT: { cls: 'tip', icon: '✦', label: 'Important' },
  WARNING: { cls: 'warning', icon: '▲', label: 'Warning' },
  CAUTION: { cls: 'warning', icon: '▲', label: 'Caution' },
  DANGER: { cls: 'danger', icon: '⨯', label: 'Danger' }
}

function calloutPlugin (md) {
  md.core.ruler.after('block', 'callouts', (state) => {
    const tokens = state.tokens
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type !== 'blockquote_open') continue
      const inline = tokens[i + 2]
      if (!inline || inline.type !== 'inline') continue
      const m = /^\[!(\w+)\]\s*(.*)$/.exec(inline.content)
      if (!m) continue
      const spec = CALLOUTS[m[1].toUpperCase()]
      if (!spec) continue
      tokens[i].attrJoin('class', 'callout ' + spec.cls)
      const rest = inline.content.slice(m[0].length).replace(/^\n/, '')
      const title = m[2] || spec.label
      inline.content = rest
      inline.children = md.parseInline(rest, state.env)[0]?.children || []
      const titleToken = new state.Token('html_block', '', 0)
      titleToken.content = `<div class="callout-title" dir="auto"><span>${spec.icon}</span><span>${escapeAttr(title)}</span></div>\n`
      tokens.splice(i + 1, 0, titleToken)
      i++
    }
  })
}

/* ------------------------------------------------ line + direction pass */

const DIR_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'li', 'td', 'th', 'dt', 'dd', 'table', 'summary'])
const LINE_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'table', 'hr', 'dl', 'pre'])

function metaPlugin (md) {
  md.core.ruler.push('mdreader_meta', (state) => {
    const tokens = state.tokens
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]
      if (token.type.endsWith('_open') && (DIR_TAGS.has(token.tag) || token.tag === 'ul' || token.tag === 'ol')) {
        // resolve the direction from the first strong character of the block's own text,
        // which is what dir="auto" would do — but explicit, so CSS can react to it
        let dir = null
        for (let j = i + 1; j < tokens.length && j < i + 40; j++) {
          if (tokens[j].type === 'inline' && tokens[j].content.trim()) { dir = firstStrongDirection(tokens[j].content); break }
        }
        token.attrSet('dir', dir || 'auto')
      }
      if (token.map && (LINE_TAGS.has(token.tag) || token.type === 'fence' || token.type === 'hr')) {
        if (!token.attrGet('data-line')) token.attrSet('data-line', String(token.map[0]))
      }
    }
  })
}

/* -------------------------------------------------------------- factory */

export function createRenderer () {
  const md = new MarkdownIt({
    html: true,
    linkify: true,
    breaks: true,
    typographer: false,
    highlight (code, lang) {
      const language = (lang || '').split(/[\s{]/)[0].toLowerCase()
      if (language && hljs.getLanguage(language)) {
        try {
          return hljs.highlight(code, { language, ignoreIllegals: true }).value
        } catch { /* fall through */ }
      }
      try { return hljs.highlightAuto(code).value } catch { return md.utils.escapeHtml(code) }
    }
  })

  md.use(footnote)
    .use(deflist)
    .use(markPlugin)
    .use(sub)
    .use(sup)
    .use(taskLists, { enabled: true, label: true, labelAfter: false })
    .use(mathPlugin)
    .use(calloutPlugin)
    .use(anchor, { slugify, tabIndex: false, permalink: false })
    .use(metaPlugin)

  /* fenced blocks: mermaid gets its own container, code gets a wrapper */
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx]
    const info = (token.info || '').trim()
    const lang = info.split(/\s+/)[0].toLowerCase()
    const line = token.map ? token.map[0] : 0

    if (lang === 'mermaid') {
      // the source travels as text content: sanitizers strip unknown src-like attributes
      return `<div class="mermaid-block" data-line="${line}" dir="ltr"><pre class="mermaid-source">${md.utils.escapeHtml(token.content)}</pre></div>\n`
    }
    if (lang === 'math' || lang === 'katex') {
      let out
      try { out = katex.renderToString(token.content, { displayMode: true, throwOnError: false, strict: false }) } catch { out = escapeAttr(token.content) }
      return `<div class="katex-display-wrap" data-line="${line}" dir="ltr">${out}</div>\n`
    }

    const highlighted = options.highlight
      ? options.highlight(token.content, lang, '') || md.utils.escapeHtml(token.content)
      : md.utils.escapeHtml(token.content)

    return `<div class="code-wrap" data-line="${line}">` +
      `<pre class="hljs"><code class="language-${escapeAttr(lang || 'text')}">${highlighted}</code></pre>` +
      (lang ? `<span class="code-lang">${escapeAttr(lang)}</span>` : '') +
      `<button class="copy-btn" data-copy>copy</button>` +
      `</div>\n`
  }

  /* headings get a quiet anchor link */
  const defaultHeadingClose = md.renderer.rules.heading_close ||
    ((tokens, idx, opts, env, self) => self.renderToken(tokens, idx, opts))
  md.renderer.rules.heading_close = (tokens, idx, opts, env, self) => {
    const open = tokens[idx - 2]
    const id = open && open.attrGet && open.attrGet('id')
    const anchorHtml = id ? `<a class="heading-anchor" href="#${escapeAttr(id)}" aria-hidden="true">#</a>` : ''
    return anchorHtml + defaultHeadingClose(tokens, idx, opts, env, self)
  }

  /* images and links: resolve relative paths, open http(s) externally */
  const defaultImage = md.renderer.rules.image
  md.renderer.rules.image = (tokens, idx, opts, env, self) => {
    const token = tokens[idx]
    const src = token.attrGet('src') || ''
    if (env && env.baseDir && !/^(https?:|data:|file:|\/|[a-zA-Z]:[\\/])/.test(src)) {
      token.attrSet('src', toFileUrl(env.baseDir, src))
    }
    token.attrSet('loading', 'lazy')
    return defaultImage(tokens, idx, opts, env, self)
  }

  const defaultLinkOpen = md.renderer.rules.link_open ||
    ((tokens, idx, opts, env, self) => self.renderToken(tokens, idx, opts))
  md.renderer.rules.link_open = (tokens, idx, opts, env, self) => {
    const href = tokens[idx].attrGet('href') || ''
    if (/^https?:/i.test(href)) tokens[idx].attrSet('data-external', '1')
    else if (!href.startsWith('#') && env && env.baseDir && !/^(mailto:|file:|\/)/i.test(href)) {
      tokens[idx].attrSet('data-relative', href)
    }
    return defaultLinkOpen(tokens, idx, opts, env, self)
  }

  return md
}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

export function splitFrontMatter (source) {
  const m = FRONT_MATTER.exec(source)
  if (!m) return { frontMatter: null, body: source, offset: 0 }
  return {
    frontMatter: m[1],
    body: source.slice(m[0].length),
    offset: m[0].split('\n').length - 1
  }
}

const purifyConfig = {
  ADD_ATTR: ['dir', 'target', 'align', 'data-line', 'data-src', 'data-copy', 'data-external', 'data-relative', 'colspan', 'rowspan', 'start', 'checked', 'disabled', 'type'],
  ADD_TAGS: ['math', 'semantics', 'annotation', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub', 'mfrac', 'msqrt', 'mstyle', 'mtext', 'munderover', 'mover', 'munder'],
  FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input'],
  ALLOW_DATA_ATTR: true
}
// task-list checkboxes are the one input we do want
DOMPurify.addHook('uponSanitizeElement', (node, data) => {
  if (data.tagName === 'input' && node.getAttribute && node.getAttribute('type') === 'checkbox') {
    node.setAttribute('disabled', 'disabled')
  }
})

export function renderMarkdown (md, source, { baseDir = null, sanitize = true } = {}) {
  const { frontMatter, body, offset } = splitFrontMatter(source)
  const env = { baseDir }
  let html = md.render(body, env)
  if (offset) {
    // shift data-line values back so scroll sync matches the real file
    html = html.replace(/data-line="(\d+)"/g, (_m, n) => `data-line="${Number(n) + offset}"`)
  }
  if (frontMatter) {
    html = `<div class="front-matter" dir="ltr" data-line="0">${escapeAttr(frontMatter)}</div>` + html
  }
  if (sanitize) {
    html = DOMPurify.sanitize(html, { ...purifyConfig, FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form'] })
  }
  return html
}

/** Extract the heading outline straight from the source (cheap, no DOM). */
export function extractOutline (source) {
  const { body, offset } = splitFrontMatter(source)
  const lines = body.split('\n')
  const out = []
  let inFence = false
  let fenceMark = ''
  lines.forEach((raw, i) => {
    const line = raw.trimEnd()
    const fence = /^(\s*)(`{3,}|~{3,})/.exec(line)
    if (fence) {
      if (!inFence) { inFence = true; fenceMark = fence[2][0] }
      else if (fence[2][0] === fenceMark) inFence = false
      return
    }
    if (inFence) return
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (!m) return
    const text = m[2].replace(/`/g, '').replace(/\*\*|__|\*|_|~~/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    out.push({ level: m[1].length, text, line: i + offset, id: slugify(text) })
  })
  return out
}

export function documentStats (source) {
  const { body } = splitFrontMatter(source)
  const text = body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!?\[[^\]]*\]\([^)]*\)/g, ' ')
  const words = (text.match(/[\p{L}\p{N}'’‌]+/gu) || []).length
  const chars = body.length
  const minutes = Math.max(1, Math.round(words / 200))
  return { words, chars, minutes, lines: body.split('\n').length }
}
