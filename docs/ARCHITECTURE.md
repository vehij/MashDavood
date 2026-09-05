# Architecture — MashDavood

Electron app, no framework in the renderer (plain ES modules + Vite). Everything the renderer
needs is bundled by Vite, so the packaged app ships **no** `node_modules` — only `electron/`,
`dist/` and `package.json` go into the asar.

```
main process (electron/main.js)
   │  ipcMain handlers ── fs, dialogs, watchers, exports, theme, settings
   │  native menu ─────── sends { action } over "menu:action"
   │  open-file / argv ── queued until the renderer says it is ready
   ▼
preload.js  →  window.api   (contextBridge, contextIsolation on, no node in renderer)
   ▼
renderer (src/renderer/app.js)
   ├── editor.js     CodeMirror 6 view, one EditorState per tab
   ├── markdown.js   markdown-it pipeline → sanitized HTML
   └── DOM           tabs · sidebar (files/outline) · preview · status bar
```

## Key decisions

**One `EditorState` per tab.** `MarkdownEditor.createState(doc)` builds a state from a shared
extension array; `activateTab` stores the outgoing tab's `editor.state` and installs the incoming
one. This is what keeps undo history, selection and search state per document — an earlier version
reused a single state and `undo` could pull another tab's text into the current file.

**Direction is resolved per block, not per document.**
- Preview: a core rule in `markdown.js` (`metaPlugin`) walks the token stream, finds the first
  inline token of every block and sets an explicit `dir="rtl"|"ltr"` on `p`, `h1..h6`, `li`, `ul`,
  `ol`, `td`, `th`, `blockquote`, `dt`, `dd`, `table`. Explicit (rather than `dir="auto"`) so CSS
  can react to it — e.g. `ol[dir='rtl'] { list-style-type: persian }`.
- Editor: the `lineDirection` ViewPlugin in `editor.js` adds a `cm-line-rtl` / `cm-line-ltr`
  decoration to every visible line. It strips markdown markers (`-`, `1.`, `>`, `#`, `[x]`) before
  looking for the first strong character, otherwise a Persian list item resolves LTR because `[x]`
  starts with a Latin letter. `EditorView.perLineTextDirection` is enabled so CodeMirror measures
  each line with its own direction.
- The app-level `data-dir` attribute (auto/rtl/ltr) only drives the container direction and the
  "auto → estedad font" rule.

**Native selection, not `drawSelection()`.** CodeMirror's drawn selection layer computes its
rectangles from its own bidi model and drifts on mixed RTL/LTR lines (the highlight lands a few
characters away from the glyphs). Dropping the extension lets the browser paint the selection with
the real layout, which is pixel-accurate. Cost: only the primary selection is painted (multiple
cursors still work, they just aren't drawn).

**Fonts.** Two `@font-face` declarations over the same Estedad variable file:
- `Estedad` — full range, used for UI and preview.
- `Estedad Code` — restricted `unicode-range` (Arabic script only) and listed *first* in
  `--font-mono`, so code keeps monospace metrics for Latin while Persian gets real letterforms.
`--editor-font` (auto/estedad/mono) switches the editor to the proportional face for RTL documents.

**Scroll sync.** Every block in the rendered HTML carries `data-line` (source line). `buildLineMap`
turns those into `{line, top, height}` pairs; editor→preview interpolates between two entries using
the top visible line plus its fraction, preview→editor does the inverse. A short `syncSource` lock
prevents feedback loops.

**Mermaid source transport.** The fence renderer emits `<pre class="mermaid-source">` with escaped
text rather than a `data-src` attribute — DOMPurify strips `src`-like attributes. `renderMermaid`
reads the text once, caches the SVG per `source|theme`, and stamps `data-rendered` so a re-render
is skipped. Exports temporarily re-render diagrams with the light theme.

**Exports.** The renderer hands `body` (preview innerHTML) + `css` (all stylesheets, minus
`@font-face`, minus dark-theme rules, minus `.cm-*`, with relative `url()`s absolutised) to the
main process. `standaloneHtml()` prepends the Estedad data-URI font faces and a small override
block (the app stylesheet fixes `html,body` height, which would otherwise clip the PDF to one page).
PDF goes through an offscreen `BrowserWindow` + `printToPDF`. Both handlers accept an optional
`outPath` so they can be driven from a script without a save dialog.

**Sanitising.** `renderMarkdown` runs DOMPurify with data attributes allowed, `input[type=checkbox]`
forced to `disabled`, and script/iframe/object/embed/form forbidden. Local images are rewritten to
absolute `file://` URLs based on the document's directory.

## Settings / session

`electron/store.js` writes `~/Library/Application Support/MashDavood/settings.json` (debounced).
It also holds `openTabs`, `activeTab`, `lastFolder`, `recentFiles`, `recentFolders`, so a restart
restores the workspace. `app.setName('MashDavood')` runs before the store is required — the name
decides the userData path.

## Testing without a UI harness

The dev app is driven over the Chrome DevTools protocol:

```bash
npx electron . --remote-debugging-port=9333
node scripts/cdp.mjs eval "<javascript>"     # evaluate in the renderer
node scripts/cdp.mjs shot out.png            # screenshot
```

`window.__mashdavood` exposes `{ state, editor, doExport, renderPreview }`. For screenshots that
need focus (selection highlights), enable `Emulation.setFocusEmulationEnabled` first.
