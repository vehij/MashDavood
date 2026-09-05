// usage: node cdp.mjs eval "<js>"   |   node cdp.mjs shot out.png  |  node cdp.mjs logs
const listRes = await fetch('http://127.0.0.1:9333/json/list')
const targets = await listRes.json()
const page = targets.find(t => t.type === 'page')
if (!page) { console.error('no page target'); process.exit(1) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
const logs = []
const send = (method, params = {}) => new Promise((res, rej) => {
  const mid = ++id
  pending.set(mid, res)
  ws.send(JSON.stringify({ id: mid, method, params }))
  setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error('timeout ' + method)) } }, 20000)
})
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id) }
  else if (msg.method === 'Runtime.consoleAPICalled') logs.push(msg.params.type + ': ' + msg.params.args.map(a => a.value ?? a.description ?? JSON.stringify(a.preview?.properties ?? '')).join(' '))
  else if (msg.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION: ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text))
}
await new Promise(r => ws.onopen = r)
await send('Runtime.enable'); await send('Page.enable')
const [cmd, arg] = process.argv.slice(2)
if (cmd === 'eval') {
  const r = await send('Runtime.evaluate', { expression: arg, awaitPromise: true, returnByValue: true })
  console.log(JSON.stringify(r.result?.value ?? r.result?.description ?? r, null, 2))
  if (r.exceptionDetails) console.error('ERR:', r.exceptionDetails.exception?.description)
} else if (cmd === 'shot') {
  await new Promise(r => setTimeout(r, 600))
  const r = await send('Page.captureScreenshot', { format: 'png' })
  const fs = await import('fs')
  fs.writeFileSync(arg, Buffer.from(r.data, 'base64'))
  console.log('saved ' + arg)
} else if (cmd === 'logs') {
  await new Promise(r => setTimeout(r, 1500))
}
if (logs.length) console.error('--- console ---\n' + logs.join('\n'))
ws.close()
