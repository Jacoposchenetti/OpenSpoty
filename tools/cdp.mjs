// Evaluate JS inside the StemKit Mobile WebView on the phone (debug builds).
// usage: node cdp.mjs "<expression>"   (needs: adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>)
const expr = process.argv[2]
const pages = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = pages.find((p) => p.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r))
let id = 0
const call = (method, params) =>
  new Promise((resolve) => {
    const my = ++id
    const onMsg = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id === my) {
        ws.removeEventListener('message', onMsg)
        resolve(msg)
      }
    }
    ws.addEventListener('message', onMsg)
    ws.send(JSON.stringify({ id: my, method, params }))
  })
const res = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 600000 })
if (res.result?.exceptionDetails) console.log('EXCEPTION', JSON.stringify(res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails))
else console.log(JSON.stringify(res.result?.result?.value ?? res.result?.result, null, 1))
ws.close()
process.exit(0)
