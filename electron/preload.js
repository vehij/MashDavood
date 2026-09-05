const { contextBridge, ipcRenderer, webUtils } = require('electron')

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload)

contextBridge.exposeInMainWorld('api', {
  ready: () => invoke('app:ready'),

  settings: {
    all: () => invoke('settings:all'),
    merge: (obj) => invoke('settings:merge', obj)
  },

  openFileDialog: () => invoke('dialog:openFile'),
  openFolderDialog: () => invoke('dialog:openFolder'),
  openPaths: (paths) => invoke('app:openPaths', paths),

  read: (p) => invoke('fs:read', p),
  write: (p, content) => invoke('fs:write', { path: p, content }),
  exists: (p) => invoke('fs:exists', p),
  saveAs: (defaultPath, content) => invoke('fs:saveAs', { defaultPath, content }),
  newFileIn: (dir) => invoke('fs:newFileIn', dir),
  readTree: (root) => invoke('fs:readTree', root),
  watch: (p) => invoke('fs:watch', p),
  unwatch: (p) => invoke('fs:unwatch', p),

  reveal: (p) => invoke('shell:reveal', p),
  openExternal: (url) => invoke('shell:openExternal', url),
  openPath: (p) => invoke('shell:openPath', p),

  confirmClose: (name) => invoke('dialog:confirmClose', name),

  setTheme: (t) => invoke('theme:set', t),
  isDark: () => invoke('theme:isDark'),

  exportHtml: (opts) => invoke('export:html', opts),
  exportPdf: (opts) => invoke('export:pdf', opts),

  on: (channel, cb) => {
    const allowed = ['menu:action', 'app:openFiles', 'app:openFolder', 'file:changed', 'file:removed', 'theme:changed']
    if (!allowed.includes(channel)) return () => {}
    const handler = (_e, payload) => cb(payload)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  },

  pathForFile: (file) => { try { return webUtils.getPathForFile(file) } catch { return null } },

  platform: process.platform,
  pathSep: '/'
})
