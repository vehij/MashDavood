/**
 * Update checks against GitHub Releases, without electron-updater.
 *
 * electron-updater cannot help here: Squirrel.Mac refuses to update an unsigned app,
 * and the builds are unsigned. So the app does the three steps itself:
 *
 *   check     GET /repos/<repo>/releases/latest, compare tag_name with app.getVersion()
 *   download  the installer for this platform/arch (same names as the README permalinks),
 *             verified against the release's SHA256SUMS-<os>.txt when it lists the file
 *   install   Windows (NSIS install): run the Setup silently with --updated --force-run,
 *               which is what electron-updater itself does, then quit
 *             macOS: mount the dmg, and once this process has exited, a detached shell
 *               swaps the .app bundle in place and reopens it. If the bundle's folder is
 *               not writable (or the app runs translocated / from the dmg), the dmg is
 *               opened for a manual drag instead
 *             Windows portable / zip: saved to Downloads, the user replaces the file
 *             anything else: the release page
 *
 * Files fetched by the app (not a browser) carry no quarantine flag / Mark of the Web,
 * so the updated app does not trip Gatekeeper or SmartScreen again.
 */
const { app, net, shell } = require('electron')
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const crypto = require('crypto')
const { spawn, execFile } = require('child_process')

const REPO = 'vehij/MashDavood'
const API = `https://api.github.com/repos/${REPO}/releases/latest`
const RECHECK_MS = 6 * 60 * 60 * 1000
const FIRST_CHECK_DELAY_MS = 8000

const isMac = process.platform === 'darwin'
const isWin = process.platform === 'win32'

// Development only: MASHDAVOOD_UPDATE_TEST="win-portable@1.0.0" makes an unpackaged run
// behave like that kind of install at that version, so the flow can be exercised
// without shipping a build. Ignored in the packaged app.
const TEST = !app.isPackaged && /^([\w-]+)@(\d+\.\d+\.\d+)$/.exec(process.env.MASHDAVOOD_UPDATE_TEST || '')
const currentVersion = () => (TEST ? TEST[2] : app.getVersion())

/* ------------------------------------------------------------- versions */

const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹'
const latinDigits = (s) => String(s).replace(/[۰-۹]/g, (d) => PERSIAN_DIGITS.indexOf(d))

function parseVersion (v) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(latinDigits(v))
  return m ? m.slice(1).map(Number) : null
}

function compareVersions (a, b) {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) return 0
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]
  return 0
}

/**
 * The release body is .github/RELEASE_NOTES.md: download table, then "## تغییرات"
 * with one **x.y.z** paragraph per version. Show only the versions this user has
 * not got yet; fall back to the whole section, then the whole body.
 */
function extractNotes (body, current) {
  if (!body) return ''
  const section = /^##\s*(?:تغییرات|Changes|Changelog)[^\n]*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m.exec(body)
  const text = section ? section[1] : body
  const blocks = text.split(/^(?=\*\*[۰-۹0-9]+\.[۰-۹0-9]+\.[۰-۹0-9]+)/m)
  const newer = blocks.filter((b) => {
    const v = /^\*\*([۰-۹0-9.]+)/.exec(b)
    return v && compareVersions(v[1], current) > 0
  })
  return (newer.length ? newer.join('') : text).trim()
}

/* --------------------------------------------------------- the platform */

function installKind () {
  if (TEST) return TEST[1]
  if (!app.isPackaged) return 'page'
  if (isMac) return 'mac'
  if (isWin) {
    if (process.env.PORTABLE_EXECUTABLE_FILE) return 'win-portable'
    // the NSIS installer leaves its uninstaller next to the exe; a zip copy has none
    const dir = path.dirname(app.getPath('exe'))
    if (fs.existsSync(path.join(dir, `Uninstall ${app.getName()}.exe`))) return 'win-setup'
    return 'win-zip'
  }
  return 'page'
}

function wantedAsset (kind) {
  // an x64 build running under Rosetta should come back as the native one
  const arm = process.arch === 'arm64' || app.runningUnderARM64Translation
  switch (kind) {
    case 'mac': return { name: `MashDavood-${arm ? 'arm64' : 'x64'}.dmg`, sums: 'SHA256SUMS-macOS.txt', mode: 'install' }
    case 'win-setup': return { name: `MashDavood-${arm ? 'arm64' : 'x64'}-Setup.exe`, sums: 'SHA256SUMS-Windows.txt', mode: 'install' }
    case 'win-portable': return { name: 'MashDavood-x64-Portable.exe', sums: 'SHA256SUMS-Windows.txt', mode: 'download' }
    case 'win-zip': return { name: 'MashDavood-x64-win.zip', sums: 'SHA256SUMS-Windows.txt', mode: 'download' }
    default: return null
  }
}

/* ---------------------------------------------------------------- http */

async function getJson (url) {
  const res = await net.fetch(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': `MashDavood/${currentVersion()}` },
    signal: AbortSignal.timeout(20000)
  })
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
  return res.json()
}

async function getText (url) {
  const res = await net.fetch(url, { signal: AbortSignal.timeout(20000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
}

/* ------------------------------------------------------------- updater */

function createUpdater ({ store, send, beforeQuit }) {
  let release = null      // last release info sent to the renderer
  let downloaded = null   // { file, mode, version }
  let downloading = null  // promise
  let timer = null

  async function fetchLatest () {
    const data = await getJson(API)
    const current = currentVersion()
    const version = String(data.tag_name || '').replace(/^v/i, '')
    const kind = installKind()
    const want = wantedAsset(kind)
    const assets = data.assets || []
    const asset = want && assets.find((a) => a.name === want.name)
    const sums = want && assets.find((a) => a.name === want.sums)
    return {
      version,
      current,
      newer: compareVersions(version, current) > 0,
      notes: extractNotes(data.body || '', current),
      url: data.html_url || `https://github.com/${REPO}/releases/latest`,
      publishedAt: data.published_at || null,
      mode: asset ? want.mode : 'page',
      kind,
      asset: asset ? { name: asset.name, url: asset.browser_download_url, size: asset.size } : null,
      sumsUrl: sums ? sums.browser_download_url : null,
      // the release is created before CI uploads the files; don't announce it half-built
      complete: !want || !!asset
    }
  }

  const forRenderer = (info) => {
    const { sumsUrl, kind, newer, complete, ...rest } = info
    return rest
  }

  /** Manual check (menu / settings): always answers. */
  async function check () {
    try {
      const info = await fetchLatest()
      store.set('lastUpdateCheck', Date.now())
      if (!info.newer) return { status: 'none', current: info.current }
      release = info
      return { status: 'available', info: forRenderer(info) }
    } catch (e) {
      return { status: 'error', message: e.message }
    }
  }

  /** Background check: silent unless there is something to install. */
  async function backgroundCheck () {
    if (store.get('checkUpdates') === false) return
    try {
      const info = await fetchLatest()
      store.set('lastUpdateCheck', Date.now())
      if (!info.newer || !info.complete) return
      if (store.get('skippedVersion') === info.version) return
      const known = release && release.version === info.version
      release = info
      if (!known) send('update:available', forRenderer(info))
    } catch { /* offline, rate-limited, GitHub blocked: try again later */ }
  }

  function start () {
    if (!app.isPackaged && !TEST) return
    setTimeout(backgroundCheck, FIRST_CHECK_DELAY_MS)
    timer = setInterval(backgroundCheck, RECHECK_MS)
    timer.unref?.()
  }

  async function expectedHash (info) {
    if (!info.sumsUrl) return null
    try {
      const text = await getText(info.sumsUrl)
      const line = text.split(/\r?\n/).find((l) => l.trim().endsWith('  ' + info.asset.name) || l.trim().endsWith(' ' + info.asset.name))
      return line ? line.trim().split(/\s+/)[0].toLowerCase() : null
    } catch { return null }
  }

  async function download () {
    const info = release
    if (!info?.asset) throw new Error('Nothing to download')
    if (downloaded && downloaded.version === info.version) return { file: downloaded.file, mode: downloaded.mode }
    if (downloading) return downloading
    downloading = (async () => {
      const dir = info.mode === 'download'
        ? app.getPath('downloads')
        : path.join(app.getPath('temp'), 'MashDavood-update')
      await fsp.mkdir(dir, { recursive: true })
      const target = info.mode === 'download' ? uniquePath(dir, info.asset.name) : path.join(dir, info.asset.name)
      const partial = target + '.part'

      const res = await net.fetch(info.asset.url)
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      const total = Number(res.headers.get('content-length')) || info.asset.size || 0
      const hash = crypto.createHash('sha256')
      const out = fs.createWriteStream(partial)
      const reader = res.body.getReader()
      let received = 0
      let lastSent = 0
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          hash.update(value)
          received += value.length
          if (!out.write(value)) await new Promise((resolve) => out.once('drain', resolve))
          if (Date.now() - lastSent > 120) { lastSent = Date.now(); send('update:progress', { received, total }) }
        }
        await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())))
      } catch (e) {
        out.destroy()
        await fsp.rm(partial, { force: true })
        throw e
      }
      send('update:progress', { received, total })

      if (info.asset.size && received !== info.asset.size) {
        await fsp.rm(partial, { force: true })
        throw new Error(`incomplete download (${received} of ${info.asset.size} bytes)`)
      }
      const expected = await expectedHash(info)
      const actual = hash.digest('hex')
      if (expected && expected !== actual) {
        await fsp.rm(partial, { force: true })
        throw new Error('checksum mismatch — the file was not what the release lists')
      }
      await fsp.rm(target, { force: true })
      await fsp.rename(partial, target)
      downloaded = { file: target, mode: info.mode, version: info.version }
      return { file: target, mode: info.mode }
    })()
    try { return await downloading } finally { downloading = null }
  }

  async function install () {
    if (!downloaded) throw new Error('Download the update first')
    const { file } = downloaded
    if (TEST) throw new Error(`test mode: would now install ${file}`)
    if (isWin) {
      // electron-updater's own NSIS invocation: silent, keeps the install dir, relaunches
      spawn(file, ['--updated', '/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref()
      quitSoon()
      return { ok: true }
    }
    if (isMac) return installMac(file)
    shell.openPath(file)
    return { manual: true, message: 'The installer was opened.' }
  }

  async function installMac (dmg) {
    const bundle = path.resolve(app.getPath('exe'), '..', '..', '..')
    const parent = path.dirname(bundle)
    const fallback = async (why) => {
      await shell.openPath(dmg)
      return {
        manual: true,
        message: `${why} The installer is open: quit MashDavood, drag it onto Applications and choose Replace. ` +
          '· نصب‌کننده باز شد: برنامه را ببندید، MashDavood را روی Applications بکشید و Replace را بزنید.'
      }
    }
    if (!bundle.endsWith('.app') || bundle.includes('/AppTranslocation/') || bundle.startsWith('/Volumes/')) {
      return fallback('This copy runs from a temporary location, so it cannot replace itself.')
    }
    try { await fsp.access(parent, fs.constants.W_OK) } catch {
      return fallback(`${parent} is not writable without an administrator password.`)
    }

    const mount = path.join(app.getPath('temp'), `MashDavood-dmg-${Date.now()}`)
    try {
      await fsp.mkdir(mount, { recursive: true })
      await run('hdiutil', ['attach', '-nobrowse', '-noautoopen', '-readonly', '-mountpoint', mount, dmg])
    } catch (e) {
      return fallback('The disk image could not be mounted.')
    }
    const inside = (await fsp.readdir(mount)).find((n) => n.endsWith('.app'))
    if (!inside) {
      run('hdiutil', ['detach', mount, '-quiet']).catch(() => {})
      return fallback('The disk image has no app in it.')
    }

    // Runs after this process exits. Every step that can fail leaves the old app in
    // place: the new copy is staged next to it first, and the old one is only removed
    // once the new one sits at the original path.
    const script = `
      while kill -0 "$OLD_PID" 2>/dev/null; do sleep 0.3; done
      fail () { rm -rf "$STAGE"; hdiutil detach "$MOUNT" -quiet; open "$APP"; exit 1; }
      ditto "$SRC" "$STAGE" || fail
      mv "$APP" "$BACKUP" || fail
      if mv "$STAGE" "$APP"; then rm -rf "$BACKUP"; else mv "$BACKUP" "$APP"; fail; fi
      xattr -dr com.apple.quarantine "$APP" 2>/dev/null
      hdiutil detach "$MOUNT" -quiet
      rm -f "$DMG"
      open "$APP"
    `
    const stamp = Date.now()
    spawn('/bin/bash', ['-c', script], {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        OLD_PID: String(process.pid),
        SRC: path.join(mount, inside),
        APP: bundle,
        STAGE: path.join(parent, `.${path.basename(bundle, '.app')}-update-${stamp}.app`),
        BACKUP: path.join(parent, `.${path.basename(bundle, '.app')}-old-${stamp}.app`),
        MOUNT: mount,
        DMG: dmg
      }
    }).unref()
    quitSoon()
    return { ok: true }
  }

  function quitSoon () {
    // let the IPC reply reach the renderer first
    setTimeout(() => { beforeQuit?.(); app.quit() }, 250)
  }

  function skip (version) {
    store.set('skippedVersion', version)
    if (release && release.version === version) release = null
    return true
  }

  return { start, check, download, install, skip }
}

function run (cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err, stdout) => (err ? reject(err) : resolve(stdout)))
  })
}

function uniquePath (dir, name) {
  const ext = path.extname(name)
  const base = path.basename(name, ext)
  let candidate = path.join(dir, name)
  for (let i = 1; fs.existsSync(candidate); i++) candidate = path.join(dir, `${base} (${i})${ext}`)
  return candidate
}

module.exports = { createUpdater, compareVersions, extractNotes }
