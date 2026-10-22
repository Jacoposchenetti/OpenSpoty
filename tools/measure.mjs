// node measure.mjs "<title substring>" : taps the song in "Tutti i brani" and measures
// how long until the native engine reports playing (and with which source).
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const title = process.argv[2]
const js = `(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms))
  document.querySelector('.player .icon-btn')?.click()
  await wait(200)
  document.querySelectorAll('.tabs button')[0].click(); await wait(200)
  document.querySelector('.list-top .back')?.click(); await wait(200)
  document.querySelector('.lib-row').click(); await wait(400)
  const row = [...document.querySelectorAll('.song-row')].find(r => r.innerText.includes(${JSON.stringify(title)}))
  if (!row) return 'song not found'
  let t0, playingAt = null, firstSource = null
  const h = await Capacitor.Plugins.StemPlayer.addListener('player', e => {
    if (e.type === 'state' && e.playing && playingAt === null) { playingAt = performance.now(); firstSource = e.source }
  })
  t0 = performance.now()
  row.querySelector('.song-main').click()
  for (let i = 0; i < 100 && playingAt === null; i++) await wait(50)
  await wait(1500)
  const st = await Capacitor.Plugins.StemPlayer.state()
  h.remove()
  return { song: ${JSON.stringify(title)}, startMs: playingAt === null ? 'non partita' : Math.round(playingAt - t0), source: firstSource, posAfter1_5s: +st.pos.toFixed(2), error: st.error ?? null }
})()`
console.log(execFileSync('node', [join(here, 'cdp.mjs'), js], { encoding: 'utf8' }).trim())
