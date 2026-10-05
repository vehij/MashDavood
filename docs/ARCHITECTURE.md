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
  "auto → estedad font" rule. The preview root gets the document's *effective* direction, never
  `dir="auto"`: auto skips children that carry their own `dir` (every block does), so it always
  resolved LTR.
- Tables and the front-matter card take the direction of the *majority* of their letters
  (`dominantDirection`), so one English header cannot flip a Persian table. Cells keep their own
  `dir` for text order, but `text-align` follows the table, so a column lines up on one side.
- Persian/Arabic-Indic digits are weak characters and never decide a direction. A block with no
  letters at all (`**۱.۲.۰**`, a price cell) gets `data-weak`: `unicode-bidi: plaintext` would
  fall back to LTR there, so it is swapped for `isolate` and the block inherits (or is RTL when it
  has Persian digits).
- `overflow-wrap: break-word`, never `anywhere`, on the preview: `anywhere` also lowers the
  min-content width, and auto-sized table columns then split Persian words (اطمینا|ن).
- Inline `code` and KaTeX are `unicode-bidi: isolate`, so they never reorder the Persian around them.

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

**Tables.** The `table_open` rule wraps every table in `<div class="table-wrap" dir>` (it scrolls;
the table keeps real table layout). After each render `decorateTables` adds a `.col-resizer` to
every header cell and re-applies saved widths. Widths are a *view* setting stored in
`settings.json` → `tableWidths[filePath][tableKey]` (untitled tabs keep them on the tab); the
`.md` is never touched. `tableKey` = header text joined + occurrence index among tables with the
same header, so edits elsewhere in the file keep them. They are applied as a percentage
`<colgroup>` plus `--table-w` (the dragged total) with `width: min(100%, var(--table-w))` and
*auto* layout: proportions are honoured, but no column goes below its longest word — a narrow
pane or the PDF page scales the table or scrolls it, it never splits words. While dragging, each
column's floor is its min-content width (measured once by laying the table out at `width: 1px`);
a column wider than the room takes space from its neighbours, nearest first. Exports keep the
colgroup and drop the handles (`exportBody`).

**Mermaid diagrams (`diagrams.js`).** After mermaid puts an SVG in a block, `decorateDiagram`
adds the controls and indexes the SVG once, at mermaid's own positions: `g.node` (key = id without
the render id and mermaid's trailing counter, e.g. `flowchart-A`), every `path[data-edge]` with its
`data-points` and the nodes its two ends sit on (geometric hit test in viewBox space), and
`g.edgeLabel`s by `data-id`. That needs layout, so a hidden pane waits for `refreshDiagrams()`, and
exports lay a hidden preview out off-screen (`.export-layout`). The saved state is
`{ vb, nodes: { key: [dx, dy] } }` in `settings.json → diagrams[file][type-line#n]`:
- zoom / pan / frame height are the SVG's `viewBox` (width 100%, height from the aspect), so the
  frame scales to any page width and the PDF shows exactly that frame. Entering the custom view
  keeps the picture where it is (the viewBox is widened to the block's full width first).
- a moved node gets `translate(cx+dx, cy+dy)`; each edge touching it is redrawn with d3's
  `curveBasis` through its points, shifted by a blend of the two ends' offsets, with the end pulled
  back by the same arrowhead offset mermaid used (measured from the original `d`). Edge labels move
  by the mean offset. Without a custom view the viewBox grows to the content.
Table widths and diagram state are keyed by file path; `carryViewSettings` copies them to the new
path on Save As, and moves an untitled tab's in-memory copy into `settings.json` on its first save.
`apply()` always starts from the originals, so it is idempotent across re-renders and theme changes.
PNG/SVG: the renderer serialises the SVG (with a page-colour background); the main process embeds
Estedad and, for PNG, renders it in an offscreen window at 2x and `capturePage`s it.

**Copying the document.** `copyPreview` clones the preview, drops the app's controls, swaps KaTeX
for its TeX source (`data-tex`, emitted by the math renderers) and writes one `ClipboardItem` with
`text/html` (minimal inline styles so Word/Docs keep table borders, wrapped in the document's `dir`)
and `text/plain` (`innerText` of an off-screen copy, so table cells become tab-separated). This uses
the renderer's `navigator.clipboard`: Electron 44's main-process `clipboard` is now the async W3C
API and `clipboard.write({text, html})` silently writes nothing.

**Reading panel / export typography.** The floating `Aa` panel edits the same settings as the
Settings modal (`fontSize`, `lineHeight`, `contentWidth`, `justify`, direction). Exports receive
`typography` and `standaloneHtml` emits a `:root` override, so the PDF uses the size and spacing
on screen (the stylesheet alone only carries the defaults).

**Updates (`electron/updater.js`).** No electron-updater: Squirrel.Mac refuses unsigned apps.
Background check 8 s after start and every 6 h (setting `checkUpdates`, `skippedVersion`):
`GET /repos/vehij/MashDavood/releases/latest`, compare `tag_name`. The installer name is picked
like the README permalinks (`MashDavood-<arch>.dmg`, `-<arch>-Setup.exe`, `-x64-Portable.exe`,
`-x64-win.zip`; Rosetta/ARM-emulated x64 builds pick arm64). A release is only announced once its
asset exists (CI creates the release before uploading). Download via `net.fetch` with progress,
size check, and SHA-256 against `SHA256SUMS-<os>.txt` when listed. Install:
- Windows NSIS install (detected by `Uninstall MashDavood.exe` next to the exe): run the Setup with
  `--updated /S --force-run` (electron-updater's own flags) and quit.
- macOS: mount the dmg; a detached bash waits for this PID to exit, `ditto`s the new bundle next to
  the old one, swaps them with two `mv`s (rolling back if the second fails), strips quarantine and
  reopens. Read-only parent / translocated / running from the dmg → the dmg is opened for a manual
  drag instead.
- Portable / zip → saved to Downloads; Linux / unpackaged → release page.
**macOS signing.** `mac.identity: "-"` ad-hoc signs the build: no Apple certificate, but a valid
signature, so a browser download gets the "unidentified developer" prompt with *Open Anyway* in
Privacy & Security. An *unsigned* arm64 app (≤ 1.1.0) is reported as "damaged" with no way to approve
it except `xattr`. `hardenedRuntime` is off because, with an ad-hoc identity, library validation
rejects the pre-signed Electron frameworks (different Team ID). CI checks every `.app` with
`codesign --verify --deep --strict`.

Files fetched by the app carry no quarantine flag / Mark of the Web, so the update does not trip
Gatekeeper or SmartScreen again. The release notes shown are the `**x.y.z**` blocks of
`## تغییرات` newer than the installed version.

Testing without shipping a build: `MASHDAVOOD_UPDATE_TEST=win-setup@1.0.0 npx electron .` makes an
unpackaged run behave like that install kind at that version (kinds: `mac`, `win-setup`,
`win-portable`, `win-zip`). It downloads and verifies for real and stops just before installing.
In a sandbox whose HTTPS proxy re-signs TLS, Chromium needs that CA in `~/.pki/nssdb`.

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

`window.__mashdavood` exposes `{ state, editor, doExport, renderPreview }`. On Linux without a
display: `xvfb-run -a npx electron . --no-sandbox --remote-debugging-port=9333`. For screenshots that
need focus (selection highlights), enable `Emulation.setFocusEmulationEnabled` first.
