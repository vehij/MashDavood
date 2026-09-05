const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme } = require('electron')

// the app name decides the userData path, so it must be set before anything reads it
app.setName('MashDavood')

const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const os = require('os')
const store = require('./store')

const isDev = !!process.env.MDREADER_DEV
const isMac = process.platform === 'darwin'
const MD_EXT = ['md', 'markdown', 'mdown', 'mkd', 'mdx', 'txt', 'text']

let mainWindow = null
const pendingOpen = []      // files requested before the window is ready
let rendererReady = false
const watchers = new Map()

/* ------------------------------------------------------------------ window */

function themeBackground () {
  const t = store.get('theme')
  const dark = t === 'dark' || (t === 'system' && nativeTheme.shouldUseDarkColors)
  return dark ? '#15161a' : '#fbfbfa'
}

function createWindow () {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 840,
    minWidth: 680,
    minHeight: 460,
    show: false,
    backgroundColor: themeBackground(),
    ...(isMac ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 16 } } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true
    }
  })

  if (isDev) {
    mainWindow.loadURL('http://localhost:5273')
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }

  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.on('closed', () => { mainWindow = null; rendererReady = false })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
}

function send (channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
}

/* ------------------------------------------------------------------- menu */

function menuAction (action, payload) {
  return () => send('menu:action', { action, payload })
}

function buildMenu () {
  const template = [
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: 'about', label: 'About MashDavood' },
            { type: 'separator' },
            { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: menuAction('settings') },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' }
          ]
        }]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New File', accelerator: 'CmdOrCtrl+N', click: menuAction('new') },
        { label: 'Open File…', accelerator: 'CmdOrCtrl+O', click: () => openFileDialog() },
        { label: 'Open Folder…', accelerator: 'CmdOrCtrl+Shift+O', click: () => openFolderDialog() },
        {
          label: 'Open Recent',
          submenu: buildRecentSubmenu()
        },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: menuAction('save') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: menuAction('saveAs') },
        { type: 'separator' },
        { label: 'Export as PDF…', accelerator: 'CmdOrCtrl+P', click: menuAction('exportPdf') },
        { label: 'Export as HTML…', accelerator: 'CmdOrCtrl+Shift+E', click: menuAction('exportHtml') },
        { type: 'separator' },
        { label: isMac ? 'Reveal in Finder' : 'Show in Explorer', accelerator: 'CmdOrCtrl+Alt+R', click: menuAction('reveal') },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: menuAction('closeTab') },
        ...(isMac
          ? []
          : [
              { type: 'separator' },
              { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: menuAction('settings') },
              { role: 'quit', label: 'Exit' }
            ])
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        { role: 'pasteAndMatchStyle' }, { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find…', accelerator: 'CmdOrCtrl+F', click: menuAction('find') },
        { type: 'separator' },
        {
          label: 'Format',
          submenu: [
            { label: 'Bold', accelerator: 'CmdOrCtrl+B', click: menuAction('fmt:bold') },
            { label: 'Italic', accelerator: 'CmdOrCtrl+I', click: menuAction('fmt:italic') },
            { label: 'Strikethrough', accelerator: 'CmdOrCtrl+Shift+X', click: menuAction('fmt:strike') },
            { label: 'Inline Code', accelerator: 'CmdOrCtrl+Shift+C', click: menuAction('fmt:code') },
            { label: 'Link', accelerator: 'CmdOrCtrl+K', click: menuAction('fmt:link') },
            { type: 'separator' },
            { label: 'Heading 1', accelerator: 'CmdOrCtrl+Alt+1', click: menuAction('fmt:h1') },
            { label: 'Heading 2', accelerator: 'CmdOrCtrl+Alt+2', click: menuAction('fmt:h2') },
            { label: 'Heading 3', accelerator: 'CmdOrCtrl+Alt+3', click: menuAction('fmt:h3') },
            { type: 'separator' },
            { label: 'Bullet List', accelerator: 'CmdOrCtrl+Shift+8', click: menuAction('fmt:ul') },
            { label: 'Numbered List', accelerator: 'CmdOrCtrl+Shift+7', click: menuAction('fmt:ol') },
            { label: 'Task List', accelerator: 'CmdOrCtrl+Shift+9', click: menuAction('fmt:task') },
            { label: 'Quote', accelerator: 'CmdOrCtrl+Shift+.', click: menuAction('fmt:quote') },
            { label: 'Code Block', accelerator: 'CmdOrCtrl+Alt+C', click: menuAction('fmt:codeblock') },
            { label: 'Table', accelerator: 'CmdOrCtrl+Alt+T', click: menuAction('fmt:table') },
            { label: 'Mermaid Diagram', accelerator: 'CmdOrCtrl+Alt+M', click: menuAction('fmt:mermaid') }
          ]
        }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Editor Only', accelerator: 'CmdOrCtrl+1', click: menuAction('view:editor') },
        { label: 'Split', accelerator: 'CmdOrCtrl+2', click: menuAction('view:split') },
        { label: 'Preview Only', accelerator: 'CmdOrCtrl+3', click: menuAction('view:preview') },
        { type: 'separator' },
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+\\', click: menuAction('toggleSidebar') },
        { label: 'Toggle Theme', accelerator: 'CmdOrCtrl+Shift+L', click: menuAction('toggleTheme') },
        { type: 'separator' },
        {
          label: 'Text Direction',
          submenu: [
            { label: 'Auto (detect)', accelerator: 'CmdOrCtrl+Shift+A', click: menuAction('dir:auto') },
            { label: 'Right to Left (RTL)', accelerator: 'CmdOrCtrl+Shift+R', click: menuAction('dir:rtl') },
            { label: 'Left to Right (LTR)', accelerator: 'CmdOrCtrl+Shift+D', click: menuAction('dir:ltr') }
          ]
        },
        { type: 'separator' },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: menuAction('zoom:in') },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: menuAction('zoom:out') },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: menuAction('zoom:reset') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(isDev ? [{ role: 'toggleDevTools' }, { role: 'forceReload' }] : [])
      ]
    },
    {
      label: 'Window',
      submenu: [
        { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: menuAction('tab:next') },
        { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: menuAction('tab:prev') },
        { type: 'separator' },
        { role: 'minimize' }, { role: 'zoom' }, { role: 'front' }
      ]
    },
    {
      role: 'help',
      submenu: [
        { label: 'Keyboard Shortcuts', click: menuAction('shortcuts') },
        { label: 'Open Welcome Document', click: menuAction('welcome') }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function buildRecentSubmenu () {
  const files = store.get('recentFiles') || []
  const folders = store.get('recentFolders') || []
  const items = []
  for (const f of files.slice(0, 10)) {
    items.push({ label: path.basename(f), sublabel: shorten(f), click: () => openPaths([f]) })
  }
  if (folders.length) {
    if (items.length) items.push({ type: 'separator' })
    for (const f of folders.slice(0, 5)) {
      items.push({ label: '📁 ' + path.basename(f), sublabel: shorten(f), click: () => openFolder(f) })
    }
  }
  if (!items.length) return [{ label: 'No Recent Items', enabled: false }]
  items.push({ type: 'separator' })
  items.push({ label: 'Clear Menu', click: () => { store.set('recentFiles', []); store.set('recentFolders', []); buildMenu() } })
  return items
}

function shorten (p) {
  return p.replace(os.homedir(), '~')
}

/* --------------------------------------------------------------- open flow */

function pushRecent (key, value) {
  const list = (store.get(key) || []).filter((p) => p !== value)
  list.unshift(value)
  store.set(key, list.slice(0, 15))
  if (key === 'recentFiles') app.addRecentDocument(value)
  buildMenu()
}

async function openPaths (paths) {
  const payload = []
  for (const p of paths) {
    try {
      const stat = await fsp.stat(p)
      if (stat.isDirectory()) { openFolder(p); continue }
      const content = await fsp.readFile(p, 'utf8')
      payload.push({ path: p, content })
      pushRecent('recentFiles', p)
    } catch (e) {
      dialog.showErrorBox('Could not open file', `${p}\n\n${e.message}`)
    }
  }
  if (!payload.length) return
  if (!rendererReady) { pendingOpen.push(...payload); return }
  send('app:openFiles', payload)
}

async function openFolder (root) {
  try {
    const tree = await readTree(root)
    store.set('lastFolder', root)
    pushRecent('recentFolders', root)
    if (!rendererReady) { pendingOpen.push({ folder: root, tree }); return }
    send('app:openFolder', { root, tree })
  } catch (e) {
    dialog.showErrorBox('Could not open folder', `${root}\n\n${e.message}`)
  }
}

async function openFileDialog () {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Markdown', extensions: MD_EXT }, { name: 'All Files', extensions: ['*'] }]
  })
  if (!res.canceled) openPaths(res.filePaths)
}

async function openFolderDialog () {
  const res = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] })
  if (!res.canceled && res.filePaths[0]) openFolder(res.filePaths[0])
}

const IGNORED_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', 'dist', 'build', '.next', '.cache', '.venv', '__pycache__', 'Pods', '.DS_Store'])

async function readTree (dir, depth = 0) {
  if (depth > 6) return []
  let entries = []
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch { return [] }
  const out = []
  for (const e of entries) {
    if (e.name.startsWith('.') || IGNORED_DIRS.has(e.name)) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      const children = await readTree(full, depth + 1)
      if (children.length) out.push({ type: 'dir', name: e.name, path: full, children })
    } else {
      const ext = path.extname(e.name).slice(1).toLowerCase()
      if (MD_EXT.includes(ext)) out.push({ type: 'file', name: e.name, path: full })
    }
  }
  out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
  return out
}

/* ------------------------------------------------------------------- watch */

function watchFile (filePath) {
  if (watchers.has(filePath)) return
  try {
    const w = fs.watch(filePath, { persistent: false }, (event) => {
      clearTimeout(w._t)
      w._t = setTimeout(async () => {
        try {
          const content = await fsp.readFile(filePath, 'utf8')
          send('file:changed', { path: filePath, content })
        } catch { send('file:removed', { path: filePath }) }
      }, 120)
    })
    watchers.set(filePath, w)
  } catch { /* ignore */ }
}

function unwatchFile (filePath) {
  const w = watchers.get(filePath)
  if (w) { try { w.close() } catch {} watchers.delete(filePath) }
}

/* --------------------------------------------------------------------- ipc */

ipcMain.handle('app:ready', () => {
  rendererReady = true
  const queued = pendingOpen.splice(0)
  return { settings: store.all(), queued, isDev, home: os.homedir() }
})

ipcMain.handle('settings:merge', (_e, obj) => { store.merge(obj); return true })
ipcMain.handle('settings:all', () => store.all())

ipcMain.handle('dialog:openFile', () => openFileDialog())
ipcMain.handle('dialog:openFolder', () => openFolderDialog())
ipcMain.handle('app:openPaths', (_e, paths) => openPaths(paths))
ipcMain.handle('fs:readTree', async (_e, root) => ({ root, tree: await readTree(root) }))

ipcMain.handle('fs:read', async (_e, p) => {
  const content = await fsp.readFile(p, 'utf8')
  pushRecent('recentFiles', p)
  return content
})

ipcMain.handle('fs:write', async (_e, { path: p, content }) => {
  unwatchFile(p)
  await fsp.writeFile(p, content, 'utf8')
  setTimeout(() => watchFile(p), 300)
  return true
})

ipcMain.handle('fs:exists', async (_e, p) => { try { await fsp.access(p); return true } catch { return false } })

ipcMain.handle('fs:saveAs', async (_e, { defaultPath, content }) => {
  const res = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultPath || path.join(app.getPath('documents'), 'Untitled.md'),
    filters: [{ name: 'Markdown', extensions: ['md'] }]
  })
  if (res.canceled || !res.filePath) return null
  await fsp.writeFile(res.filePath, content, 'utf8')
  pushRecent('recentFiles', res.filePath)
  return res.filePath
})

ipcMain.handle('fs:newFileIn', async (_e, dir) => {
  const res = await dialog.showSaveDialog(mainWindow, {
    defaultPath: path.join(dir || app.getPath('documents'), 'Untitled.md'),
    filters: [{ name: 'Markdown', extensions: ['md'] }]
  })
  if (res.canceled || !res.filePath) return null
  await fsp.writeFile(res.filePath, '', 'utf8')
  return res.filePath
})

ipcMain.handle('fs:watch', (_e, p) => { watchFile(p); return true })
ipcMain.handle('fs:unwatch', (_e, p) => { unwatchFile(p); return true })

ipcMain.handle('shell:reveal', (_e, p) => { if (p) shell.showItemInFolder(p) })
ipcMain.handle('shell:openExternal', (_e, url) => { if (/^https?:|^mailto:/.test(url)) shell.openExternal(url) })
ipcMain.handle('shell:openPath', (_e, p) => shell.openPath(p))

ipcMain.handle('dialog:confirmClose', async (_e, name) => {
  const res = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Save', "Don't Save", 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    message: `Do you want to save the changes you made to “${name}”?`,
    detail: "Your changes will be lost if you don't save them."
  })
  return ['save', 'discard', 'cancel'][res.response]
})

ipcMain.handle('theme:set', (_e, theme) => {
  store.set('theme', theme)
  nativeTheme.themeSource = theme === 'system' ? 'system' : theme
  if (mainWindow) mainWindow.setBackgroundColor(themeBackground())
  return nativeTheme.shouldUseDarkColors
})

ipcMain.handle('theme:isDark', () => nativeTheme.shouldUseDarkColors)

nativeTheme.on('updated', () => {
  if (mainWindow) mainWindow.setBackgroundColor(themeBackground())
  send('theme:changed', nativeTheme.shouldUseDarkColors)
})

/* ------------------------------------------------------------------ export */

function fontDataUri () {
  const p = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar', 'dist', 'fonts', 'Estedad-VF.woff2')
    : path.join(__dirname, '..', 'assets', 'fonts', 'Estedad-VF.woff2')
  try {
    return 'data:font/woff2;base64,' + fs.readFileSync(p).toString('base64')
  } catch { return '' }
}

function standaloneHtml ({ title, body, css, dir }) {
  const font = fontDataUri()
  return `<!doctype html>
<html lang="fa" dir="${dir || 'auto'}">
<head>
<meta charset="utf-8">
<title>${(title || 'Document').replace(/[<>&]/g, '')}</title>
<style>
@font-face{font-family:'Estedad';src:url('${font}') format('woff2-variations');font-weight:100 900;font-display:swap;}
@font-face{font-family:'Estedad Code';src:url('${font}') format('woff2-variations');font-weight:100 900;font-display:swap;
  unicode-range:U+0600-06FF,U+0750-077F,U+08A0-08FF,U+FB50-FDFF,U+FE70-FEFF,U+200C-200F,U+2010-2011,U+061B-061F,U+0640,U+FDFD;}
${css}
/* --- export overrides: the app stylesheet is built for a fixed-height window --- */
html, body { height: auto !important; overflow: visible !important; margin: 0 !important; }
body.export-body { display: block !important; padding: 0 !important; }
.markdown-body { max-width: 100% !important; margin: 0 auto !important; padding: 0 !important; }
.markdown-body .copy-btn, .markdown-body .heading-anchor, .markdown-body .code-lang { display: none !important; }
.markdown-body .mermaid-source { display: none !important; }
</style>
</head>
<body class="export-body"><article class="markdown-body" dir="${dir || 'auto'}">${body}</article></body>
</html>`
}

ipcMain.handle('export:html', async (_e, { title, body, css, dir, defaultPath, outPath }) => {
  let target = outPath
  if (!target) {
    const res = await dialog.showSaveDialog(mainWindow, {
      defaultPath: defaultPath || path.join(app.getPath('documents'), `${title || 'document'}.html`),
      filters: [{ name: 'HTML', extensions: ['html'] }]
    })
    if (res.canceled || !res.filePath) return null
    target = res.filePath
  }
  await fsp.writeFile(target, standaloneHtml({ title, body, css, dir }), 'utf8')
  return target
})

ipcMain.handle('export:pdf', async (_e, { title, body, css, dir, defaultPath, outPath }) => {
  let target = outPath
  if (!target) {
    const res = await dialog.showSaveDialog(mainWindow, {
      defaultPath: defaultPath || path.join(app.getPath('documents'), `${title || 'document'}.pdf`),
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    })
    if (res.canceled || !res.filePath) return null
    target = res.filePath
  }

  const tmp = path.join(os.tmpdir(), `mashdavood-export-${Date.now()}.html`)
  await fsp.writeFile(tmp, standaloneHtml({ title, body, css, dir }), 'utf8')

  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true, javascript: false } })
  try {
    await win.loadFile(tmp)
    await new Promise((r) => setTimeout(r, 400))
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 },
      preferCSSPageSize: false
    })
    await fsp.writeFile(target, pdf)
    return target
  } finally {
    win.destroy()
    fsp.unlink(tmp).catch(() => {})
  }
})

/* ------------------------------------------------------------- app life */

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
    const files = argv.filter((a) => !a.startsWith('-') && MD_EXT.includes(path.extname(a).slice(1).toLowerCase()))
    if (files.length) openPaths(files)
  })
}

app.on('open-file', (event, filePath) => {
  event.preventDefault()
  if (app.isReady()) openPaths([filePath])
  else pendingOpen.push({ deferredPath: filePath })
})

app.whenReady().then(async () => {
  const theme = store.get('theme')
  nativeTheme.themeSource = theme === 'system' ? 'system' : theme
  buildMenu()
  createWindow()

  // any paths passed on the command line
  const argPaths = process.argv.slice(isDev ? 2 : 1).filter((a) => !a.startsWith('-') && MD_EXT.includes(path.extname(a).slice(1).toLowerCase()))
  const deferred = pendingOpen.filter((x) => x.deferredPath).map((x) => x.deferredPath)
  pendingOpen.length = 0
  const all = [...deferred, ...argPaths]
  if (all.length) openPaths(all)

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => { store.flush(); if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', () => store.flush())
