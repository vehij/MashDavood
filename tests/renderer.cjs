const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs/promises')
const os = require('node:os')

// آزمایش در پنجره و پوشهٔ تنظیمات جدا اجرا می‌شود.
const profile = path.join(os.tmpdir(), `mashdavood-direction-${process.pid}`)
app.setPath('userData', profile)
let server
const timeout = setTimeout(() => {
  console.error('زمان آزمایش به پایان رسید.')
  app.exit(1)
}, 60000)

app.whenReady().then(async () => {
  const { createServer } = await import('vite')
  server = await createServer({
    configFile: false,
    root: path.join(__dirname, '..'),
    server: { host: '127.0.0.1', port: 0 },
    plugins: [{
      name: 'direction-test-page',
      configureServer (vite) {
        vite.middlewares.use('/__direction-tests', (_req, res) => {
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          res.end('<!doctype html><html><head><meta charset="utf-8"></head><body><div id="fixture"></div></body></html>')
        })
      }
    }]
  })
  await server.listen()
  const window = new BrowserWindow({ width: 1400, height: 1000, show: false })
  await window.loadURL(`${server.resolvedUrls.local[0]}__direction-tests`)
  const result = await window.webContents.executeJavaScript("import('/tests/renderer.mjs').then(m => m.run())")
  console.log(JSON.stringify(result, null, 2))
  if (process.env.DIRECTION_SCREENSHOT) {
    await fs.writeFile(process.env.DIRECTION_SCREENSHOT, (await window.webContents.capturePage()).toPNG())
  }
  await server.close()
  window.destroy()
  await fs.rm(profile, { recursive: true, force: true })
  clearTimeout(timeout)
  app.exit(0)
}).catch(async (error) => {
  console.error(error)
  if (server) await server.close()
  clearTimeout(timeout)
  app.exit(1)
})
