/* Update notifications. The main process (electron/updater.js) asks GitHub for the
   latest release, downloads the right installer and runs it; this module is only
   the UI: the title-bar pill, the toast, and the update dialog. */

let ui = null           // { api, state, openModal, toast, renderNotes, saveAllDirty }
let latest = null       // release info from the main process
let downloaded = null   // { file, mode } once the installer is on disk
let downloading = false
let dialog = null       // root element of the open update dialog, if any

const $ = (sel) => document.querySelector(sel)

const ACTION = {
  install: { go: 'Download & install · دانلود و نصب', ready: 'Restart & install · نصب و اجرای دوباره' },
  download: { go: 'Download · دانلود', ready: 'Show in folder · نمایش فایل' },
  page: { go: 'Open download page · صفحه‌ی دانلود', ready: 'Open download page · صفحه‌ی دانلود' }
}

export function initUpdates (ctx) {
  ui = ctx
  ui.api.on('update:available', (info) => announce(info, { quiet: false }))
  ui.api.on('update:progress', ({ received, total }) => {
    if (!dialog) return
    const pct = total ? Math.round(received / total * 100) : 0
    dialog.querySelector('.update-progress > div').style.width = pct + '%'
    status(`Downloading… ${pct}% · ${mb(received)} / ${mb(total)} MB`)
  })
  $('#btn-update').addEventListener('click', showDialog)
}

/** Menu → Check for Updates…, and the button in Settings. */
export async function checkForUpdates () {
  ui.toast('Checking for updates…')
  const res = await ui.api.updates.check()
  if (res.status === 'available') {
    announce(res.info, { quiet: true })
    showDialog()
  } else if (res.status === 'none') {
    ui.toast(`You're up to date (v${res.current}) · نسخه‌ی شما به‌روز است`)
  } else {
    ui.toast('Could not check for updates: ' + (res.message || 'network error'), 'error')
  }
}

function announce (info, { quiet }) {
  const isNew = !latest || latest.version !== info.version
  latest = info
  if (isNew) downloaded = null
  $('#btn-update').classList.remove('hidden')
  $('#btn-update-label').textContent = 'v' + info.version
  $('#btn-update').title = `MashDavood ${info.version} is available — click to update`
  if (!quiet && isNew) ui.toast(`نسخه‌ی ${info.version} منتشر شد · MashDavood ${info.version} is available`)
}

const mb = (n) => (n / 1048576).toFixed(1)
const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

function status (text, kind = '') {
  if (!dialog) return
  const node = dialog.querySelector('.update-status')
  node.textContent = text
  node.className = 'update-status ' + kind
}

function showDialog () {
  if (!latest) return
  const info = latest
  const labels = ACTION[info.mode] || ACTION.page
  const date = info.publishedAt ? new Date(info.publishedAt).toLocaleDateString() : ''
  const notes = info.notes ? ui.renderNotes(info.notes) : '<p dir="ltr">See the release page for details.</p>'
  ui.openModal(`
    <h2>MashDavood ${escape(info.version)}</h2>
    <div class="update-meta">Installed: v${escape(info.current)}${date ? ' · Released ' + escape(date) : ''}${info.asset ? ' · ' + escape(info.asset.name) + ' (' + mb(info.asset.size) + ' MB)' : ''}</div>
    <div class="update-notes markdown-body" dir="${/[\u0600-\u06FF]/.test(info.notes || '') ? 'rtl' : 'ltr'}">${notes}</div>
    <div class="update-progress" hidden><div></div></div>
    <div class="update-status"></div>
    <div class="modal-foot">
      <button id="up-skip">Skip this version</button>
      <span class="spacer"></span>
      <button data-close>Later</button>
      <button class="primary" id="up-go">${downloaded ? labels.ready : labels.go}</button>
    </div>`, (root) => {
    dialog = root
    root.querySelector('#up-skip').addEventListener('click', async () => {
      await ui.api.updates.skip(info.version)
      $('#btn-update').classList.add('hidden')
      latest = null
      root.querySelector('[data-close]').click()
      ui.toast(`Version ${info.version} skipped — you will be told about the next one.`)
    })
    root.querySelector('#up-go').addEventListener('click', () => go(root, info, labels))
    root.querySelector('.update-notes').addEventListener('click', (e) => {
      const link = e.target.closest('a')
      if (!link) return
      e.preventDefault()
      if (/^https?:/i.test(link.href)) ui.api.openExternal(link.href)
    })
    if (downloading) {
      root.querySelector('.update-progress').hidden = false
      root.querySelector('#up-go').disabled = true
    }
    if (downloaded) status(readyText(downloaded))
  })
  // the dialog DOM is replaced by the next modal; stop writing into it then
  const backdrop = $('#modal-backdrop')
  const watch = new MutationObserver(() => {
    if (backdrop.classList.contains('hidden') || !document.body.contains(dialog)) { dialog = null; watch.disconnect() }
  })
  watch.observe(backdrop, { attributes: true, childList: true, subtree: true })
}

function readyText ({ mode, file }) {
  if (mode === 'install') return 'Downloaded and verified. The app will close, update and reopen. · دانلود شد؛ برنامه بسته، به‌روز و دوباره باز می‌شود.'
  if (mode === 'download') return 'Saved: ' + file
  return ''
}

async function go (root, info, labels) {
  const button = root.querySelector('#up-go')
  if (info.mode === 'page' || !info.asset) {
    ui.api.openExternal(info.url)
    return
  }
  if (!downloaded) {
    downloading = true
    button.disabled = true
    root.querySelector('.update-progress').hidden = false
    status('Downloading…')
    try {
      downloaded = await ui.api.updates.download()
      if (dialog) {
        dialog.querySelector('.update-progress > div').style.width = '100%'
        status(readyText(downloaded))
        dialog.querySelector('#up-go').textContent = labels.ready
      }
    } catch (e) {
      status('Download failed: ' + cleanError(e), 'error')
    } finally {
      downloading = false
      if (dialog) dialog.querySelector('#up-go').disabled = false
    }
    return
  }
  if (downloaded.mode === 'download') {
    ui.api.reveal(downloaded.file)
    return
  }
  // install: the app quits, so nothing unsaved may be left behind
  if (!(await ui.saveAllDirty())) {
    status('Update postponed — a file was not saved. · فایل ذخیره‌نشده دارید.', 'error')
    return
  }
  button.disabled = true
  status('Installing… · در حال نصب')
  try {
    const res = await ui.api.updates.install()
    if (res?.manual) {
      status(res.message)
      button.disabled = false
    }
  } catch (e) {
    status('Install failed: ' + cleanError(e), 'error')
    button.disabled = false
  }
}

const cleanError = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
