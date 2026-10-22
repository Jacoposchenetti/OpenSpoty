// Drive the StemKit Mobile UI on the phone through the WebView debugger.
// node ui.mjs click "<text>" [nth] | fill "<placeholder>" "<value>" | text | eval "<js>"
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const [cmd, a, b] = process.argv.slice(2)
let js
if (cmd === 'click') {
  js = `(() => {
    const t = ${JSON.stringify(a)}
    const els = [...document.querySelectorAll('button')].filter(e => (e.innerText + ' ' + (e.getAttribute('aria-label') || '')).includes(t))
    const e = els[${Number(b ?? 0)}]
    if (!e) return 'not found: ' + t
    if (e.disabled) return 'disabled: ' + t
    e.click()
    return 'clicked: ' + e.innerText.replace(/\\s+/g, ' ').slice(0, 60)
  })()`
} else if (cmd === 'fill') {
  js = `(() => {
    const e = [...document.querySelectorAll('input')].find(i => (i.placeholder || '').includes(${JSON.stringify(a)}))
    if (!e) return 'no input'
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    set.call(e, ${JSON.stringify(b)})
    e.dispatchEvent(new Event('input', { bubbles: true }))
    return 'filled'
  })()`
} else if (cmd === 'text') {
  js = `document.body.innerText`
} else {
  js = a
}
const out = execFileSync('node', [join(here, 'cdp.mjs'), js], { encoding: 'utf8' })
console.log(cmd === 'text' ? JSON.parse(out) : out.trim())
