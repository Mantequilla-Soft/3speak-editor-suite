// PROFILE (not a test): the audio editor with a project like a real long
// show: one 18-minute browser recording cut into 269 pieces plus a music bed.
// Prints memory, DOM size and main-thread time idle and while playing.
//   node e2e/profile-audio-editor.mjs
// (Harness copied from audio-editor.e2e.mjs.)
//
// Original header of the e2e harness:
// End-to-end test of the audio editor (?mode=audio) in a real browser, against
// a real editor backend, opened the way 3Speak opens it (e2e/host.html plays the
// 3Speak side of the postMessage contract). It checks what the editor really
// saves (drafts and template on the backend), renders (an MP3) and posts back.
//
// Self-contained: it makes its own test audio (ffmpeg), starts the backend on a
// free port with throwaway folders and a throwaway token secret, builds the
// editor against it, serves editor and host page, and cleans everything up.
//
//   npm run test:e2e:audio          (needs ffmpeg + ffprobe on PATH, and Chromium:
//   E2E_CHROME=/path/to/chrome      defaults to Playwright's chromium-1148)
import { createRequire } from 'node:module'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const require = createRequire(path.join(ROOT, 'backend', 'package.json'))
const { chromium } = require('playwright-core')
const CHROME = process.env.E2E_CHROME || path.join(os.homedir(), '.cache/ms-playwright/chromium-1148/chrome-linux/chrome')

const S = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-editor-e2e-'))
const DATA = path.join(S, 'data')
const HOST_DIR = path.join(S, 'host')
for (const d of ['uploads', 'rendered', 'work']) fs.mkdirSync(path.join(DATA, d), { recursive: true })
fs.mkdirSync(HOST_DIR)
fs.copyFileSync(path.join(ROOT, 'e2e', 'host.html'), path.join(HOST_DIR, 'index.html'))
const ff = (args) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...args])
// speech-like: 1 s tone, 1.5 s silence, 2 s tone, 2 s silence, 1 s tone (7.5 s)
// two voices on their own tracks: host talks 0-2 and 6-8, guest 3-5; both quiet 2-3, 5-6, 8-10

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) })
const [BACKEND_PORT, HOST_PORT, EDITOR_PORT] = [await freePort(), await freePort(), await freePort()]
const BACKEND = `http://127.0.0.1:${BACKEND_PORT}`
const HOST = `http://127.0.0.1:${HOST_PORT}`
const EDITOR = `http://127.0.0.1:${EDITOR_PORT}`
const SECRET = crypto.randomBytes(24).toString('hex') // this run only
const USER = 'e2etester'

const children = []
const backend = spawn(process.execPath, ['src/index.js'], {
  cwd: path.join(ROOT, 'backend'),
  env: { ...process.env, PORT: String(BACKEND_PORT), EDITOR_TOKEN_SECRET: SECRET, UPLOAD_DIR: path.join(DATA, 'uploads'), UPLOADS_DIR: path.join(DATA, 'uploads'), RENDERED_DIR: path.join(DATA, 'rendered'), WORK_DIR: path.join(DATA, 'work') },
  stdio: ['ignore', 'ignore', 'inherit']
})
children.push(backend)
execFileSync('npx', ['vite', 'build', '--outDir', path.join(S, 'dist'), '--emptyOutDir', '--logLevel', 'error', ...(process.env.PROFILE_CPU ? ['--minify', 'false'] : [])], {
  cwd: ROOT, stdio: 'inherit', env: { ...process.env, VITE_BACKEND_URLS: BACKEND, VITE_GATEWAY_URL: '' }
})
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wav': 'audio/wav', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm' }
const serve = (dir, port, spa) => new Promise((resolve) => {
  const server = http.createServer((req, res) => {
    let file = path.join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname))
    if (!file.startsWith(dir)) { res.writeHead(403).end(); return }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = spa ? path.join(dir, 'index.html') : file
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end(); return }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' })
    fs.createReadStream(file).pipe(res)
  }).listen(port, '127.0.0.1', () => resolve(server))
})
const servers = [await serve(HOST_DIR, HOST_PORT, false), await serve(path.join(S, 'dist'), EDITOR_PORT, true)]

const mint = () => {
  const mid = Buffer.from(JSON.stringify({ u: USER, pro: false, exp: Date.now() + 3600e3 })).toString('base64url')
  return `v1.${mid}.${crypto.createHmac('sha256', SECRET).update(mid).digest('hex')}`
}
const session = { token: mint(), user: USER, pro: false, maxProjects: 1, ttlHours: 168 }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
async function until(fn, what, ms = 30000) {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await sleep(250)
  }
}
await until(async () => { try { return (await fetch(`${BACKEND}/api/health`)).ok } catch { return false } }, 'backend up', 20000)
const projectsDir = path.join(DATA, 'uploads', '.projects', USER)
const drafts = () => (fs.existsSync(projectsDir) ? fs.readdirSync(projectsDir).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(projectsDir, f), 'utf8'))) : [])
const templateFile = path.join(DATA, 'uploads', '.templates', USER, 'audio.json')
const clipsOf = (state) => state.tracks.flatMap(t => t.clips.map(c => ({ ...c, track: t.name, music: !!t.music })))
const ffDuration = (file) => +execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim()

const results = []
const step = async (name, fn) => {
  const t0 = Date.now()
  try {
    await fn()
    results.push(['PASS', name, Date.now() - t0])
    console.log(`PASS ${name} (${Date.now() - t0} ms)`)
  } catch (err) {
    results.push(['FAIL', name, err.message])
    console.log(`FAIL ${name}: ${err.stack || err.message}`)
    throw err
  }
}

const browser = await chromium.launch({ executablePath: CHROME, args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] })
const consoleErrors = []
// tourSeen: act as a returning user (the first-visit tours are already done),
// so the tour overlay doesn't sit on top of the controls the steps click.
async function openEditor({ file = 'speech.wav', viewport = { width: 1280, height: 860 }, mode = 'audio', tourSeen = true } = {}) {
  const ctx = await browser.newContext({ viewport })
  if (browser.__probeInit) await browser.__probeInit(ctx)
  const page = await ctx.newPage()
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', e => consoleErrors.push(`pageerror: ${e.message}`))
  page.on('response', r => { if (r.status() >= 400 && !/favicon/.test(r.url())) consoleErrors.push(`HTTP ${r.status()} ${r.request().method()} ${r.url()}`) })
  await page.addInitScript((s) => { window.__session = s }, session)
  if (tourSeen) {
    await page.addInitScript((origin) => {
      if (location.href.startsWith(origin)) {
        localStorage.setItem('3speak-audio-tour-done', '1')
        localStorage.setItem('3speak-tour-done', '1')
      }
    }, EDITOR)
  }
  await page.goto(`${HOST}/index.html?editor=${encodeURIComponent(EDITOR)}${file ? `&file=${file}` : ''}&mode=${mode}`)
  const frame = await until(async () => page.frames().find(f => f.url().startsWith(EDITOR)), 'editor frame')
  await until(() => page.evaluate(() => window.__messages.some(m => m.type === 'editor-ready')), 'editor-ready')
  return { ctx, page, frame }
}


const PIECES = +(process.env.PIECES || 269)
const LONG = 'long.webm'
// speech-like: 2.5 s of tone, 1.5 s of near silence, for 18 minutes; opus in WebM like a browser recording
if (!process.env.REAL_DRAFT) execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=220:d=1080:sample_rate=48000', '-af', "volume='if(lt(mod(t,4),2.5),1,0.02)':eval=frame", '-c:a', 'libopus', '-b:a', '96k', '-ac', '2', path.join(DATA, 'uploads', LONG)])
if (!process.env.REAL_DRAFT) execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=440:d=180', '-c:a', 'libmp3lame', '-b:a', '128k', path.join(DATA, 'uploads', 'bed.mp3')])
const fileUrl = (n) => `${BACKEND}/api/upload/files/${n}`

// 269 pieces of the recording, laid end to end (what Cut silences + edits leave)
let src = 0, at = 0
const clips = []
let seed = 7
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
for (let i = 0; i < PIECES && src < 1070; i++) {
  const len = Math.min(0.1 + rnd() * 6, 1080 - src)
  clips.push({ id: `clip-${i}`, file: null, url: fileUrl(LONG), name: `Part ${i + 1} · Recording.webm`, duration: 1080, startTime: src, endTime: src + len, timelinePosition: at, audioEnabled: true, type: 'audio', libraryId: 'lib-long', groupId: null, volume: 100 })
  at += len
  src += len + 0.2 + rnd() * 1.3
}
// REAL_DRAFT=<draft .json> REAL_MEDIA=<folder with its files>: profile a real
// project instead (its media copied into this run's throwaway backend)
let state
if (process.env.REAL_DRAFT) {
  const real = JSON.parse(fs.readFileSync(process.env.REAL_DRAFT, 'utf8'))
  const media = process.env.REAL_MEDIA || path.dirname(process.env.REAL_DRAFT)
  const local = (u) => {
    const name = decodeURIComponent(String(u || '').split('?')[0].split('/').pop())
    if (!name || !fs.existsSync(path.join(media, name))) return u
    if (!fs.existsSync(path.join(DATA, 'uploads', name))) fs.copyFileSync(path.join(media, name), path.join(DATA, 'uploads', name))
    return fileUrl(name)
  }
  state = JSON.parse(JSON.stringify(real.state))
  for (const t of state.tracks) for (const c of t.clips) { c.url = local(c.url); if (c.serverUrl) c.serverUrl = local(c.serverUrl) }
  for (const i of state.library || []) i.url = local(i.url)
  clips.length = 0
  clips.push(...state.tracks.flatMap(t => t.clips))
  at = Math.max(...clips.map(c => (c.timelinePosition || 0) + c.endTime - c.startTime))
} else state = {
  version: 1, mode: 'audio', master: { loudness: false, duck: false, duckDb: -12 },
  tracks: [
    { id: 'track-voice', type: 'audio', name: 'Voice', clips },
    { id: 'track-music', type: 'audio', name: 'Music', music: true, clips: [{ id: 'clip-bed', file: null, url: fileUrl('bed.mp3'), name: 'funkorama.mp3', duration: 180, startTime: 0, endTime: 10, timelinePosition: 0, audioEnabled: true, type: 'audio', libraryId: 'lib-bed', groupId: null, volume: 50 }] }
  ],
  library: [
    { id: 'lib-long', url: fileUrl(LONG), name: 'Recording.webm', duration: 1080, type: 'audio' },
    { id: 'lib-bed', url: fileUrl('bed.mp3'), name: 'funkorama.mp3', duration: 180, type: 'audio' }
  ]
}
const put = await fetch(`${BACKEND}/api/projects/${crypto.randomUUID()}`, { method: 'PUT', headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json', Connection: 'close' }, body: JSON.stringify({ name: 'Long show', state }) })
if (!put.ok) throw new Error(`draft PUT ${put.status}`)
console.log(`project: ${clips.length} pieces, ${at.toFixed(0)} s on the timeline`)

try {
  const T0 = Date.now()
  const log = (m) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`)
  // LEAK_PROBE=1: count live event listeners per target and type in the editor
  if (process.env.LEAK_PROBE) {
    const origin = EDITOR
    browser.__probeInit = (ctx) => ctx.addInitScript((o) => {
      if (!location.href.startsWith(o)) return
      const live = new Map() // target -> Set of keys
      const all = new Set()
      const keyOf = (type, fn, opts) => `${type}|${typeof opts === 'boolean' ? opts : !!opts?.capture}`
      const add = EventTarget.prototype.addEventListener
      const rem = EventTarget.prototype.removeEventListener
      const fns = new WeakMap() // target -> Map(key -> Set(fn))
      EventTarget.prototype.addEventListener = function (type, fn, opts) {
        if (fn) {
          let m = fns.get(this); if (!m) { m = new Map(); fns.set(this, m); all.add(new WeakRef(this)) }
          const k = keyOf(type, fn, opts); let set = m.get(k); if (!set) { set = new Set(); m.set(k, set) }
          if (!(typeof opts === 'object' && opts?.once)) set.add(fn)
        }
        return add.call(this, type, fn, opts)
      }
      EventTarget.prototype.removeEventListener = function (type, fn, opts) {
        fns.get(this)?.get(keyOf(type, fn, opts))?.delete(fn)
        return rem.call(this, type, fn, opts)
      }
      window.__listenerReport = () => {
        const out = {}
        for (const ref of all) {
          const t = ref.deref(); if (!t) continue
          const m = fns.get(t); if (!m) continue
          const kind = t === window ? 'window' : t === document ? 'document' : t.nodeType === 1 ? `${t.tagName.toLowerCase()}${t.className && typeof t.className === 'string' ? '.' + t.className.split(' ')[0] : ''}${t.isConnected ? '' : '(detached)'}` : (t.constructor?.name || 'other')
          for (const [k, set] of m) if (set.size) out[`${kind} ${k.split('|')[0]}`] = (out[`${kind} ${k.split('|')[0]}`] || 0) + set.size
        }
        return out
      }
    }, origin)
  }
  const { page, frame: f } = await openEditor({ file: null })
  log('editor ready')
  await f.locator('.drafts-item').first().click({ timeout: 20000 })
  log('draft clicked')
  await until(async () => (await f.locator('.timeline-clip-v2.audio').count()) >= Math.min(clips.length, 10), 'draft open', 30000)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable')
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]))
  const dom = () => f.evaluate(() => ({
    nodes: document.getElementsByTagName('*').length,
    clipEls: document.querySelectorAll('.timeline-clip-v2').length,
    waveBars: document.querySelectorAll('.wave-bar').length,
    audioEls: document.querySelectorAll('audio').length,
    heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null
  }))
  const busy = async (label, ms, during = null) => {
    const a = await metrics()
    if (during) await during()
    await sleep(ms)
    const b = await metrics()
    const pct = (k) => (((b[k] - a[k]) * 1000) / ms * 100).toFixed(1) + '%'
    console.log(`${label.padEnd(26)} task ${pct('TaskDuration')}  script ${pct('ScriptDuration')}  layout ${pct('LayoutDuration')}  style ${pct('RecalcStyleDuration')}  heap ${(b.JSHeapUsedSize / 1048576).toFixed(0)} MB  nodes ${b.Nodes}`)
  }
  log('clips on the timeline')
  await sleep(8000) // waveforms decode, autosave settles
  if (process.env.LEAK_PROBE) {
    const report = () => f.evaluate(() => window.__listenerReport())
    const round = async (i) => {
      await f.locator('.timeline-clip-v2.audio').nth(i % 5).click({ timeout: 2000 }).catch(() => {})
      const slider = f.locator('.compact-side input[type=range]').first()
      const has = await slider.count()
      if (i === 0) console.log(`round: slider in the panel: ${has}`)
      if (has) {
        await slider.focus({ timeout: 2000 }).catch(() => {})
        for (let k = 0; k < 3; k++) await page.keyboard.press('ArrowRight')
        await slider.evaluate(el => el.blur(), null, { timeout: 2000 }).catch(() => {})
      }
      for (let k = 0; k < 3; k++) await page.keyboard.press('Control+z')
      await sleep(300)
    }
    if (process.env.LEAK_PLAYING) {
      await f.locator('.timeline-content').click({ position: { x: 3, y: 60 } }).catch(() => {})
      await page.keyboard.press(' ')
    }
    for (let i = 0; i < 3; i++) await round(i)
    await cdp.send('HeapProfiler.enable'); await cdp.send('HeapProfiler.collectGarbage')
    const a = await report()
    const na = (await metrics()).Nodes
    console.log('side panel:', (await f.locator('.compact-side').innerText().catch(() => '?')).slice(0, 120).replace(/\n/g, ' | '))
    for (let i = 0; i < 10; i++) await round(i)
    await sleep(3000) // autosave
    await cdp.send('HeapProfiler.collectGarbage')
    const b = await report()
    console.log(`DOM nodes (after GC): ${na} -> ${(await metrics()).Nodes}`)
    console.log('listeners that grew over 10 edit rounds (live, after GC):')
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const d = (b[k] || 0) - (a[k] || 0)
      if (d) console.log(`  ${String(d).padStart(5)}  ${k}  (${a[k] || 0} -> ${b[k] || 0})`)
    }
  } else
  // SOAK=<seconds>: play that long (looping) and watch what grows
  if (process.env.SOAK) {
    await cdp.send('HeapProfiler.enable')
    const rss = () => {
      // the browser's renderer processes (the editor page lives in one of them)
      try {
        const out = execFileSync('ps', ['-C', 'chrome', '-o', 'rss=,args='], { encoding: 'utf8' })
        return Math.round(out.split('\n').filter(l => /--type=renderer/.test(l)).reduce((a, l) => a + (+l.trim().split(/\s+/)[0] || 0), 0) / 1024)
      } catch { return null }
    }
    const loopBtn = f.locator('.global-preview button[title*="oop"]').first()
    if (await loopBtn.count()) await loopBtn.click().catch(() => {})
    await f.locator('.timeline-content').click({ position: { x: 3, y: 60 } }).catch(() => {})
    await page.keyboard.press(' ')
    const secs = +process.env.SOAK
    let netBytes = 0
    await cdp.send('Network.enable')
    cdp.on('Network.loadingFinished', (e) => { netBytes += e.encodedDataLength || 0 })
    cdp.on('Network.dataReceived', () => {})
    let prev = await metrics()
    console.log('   t   cpu%  script%  heap(MB,after GC)  nodes  listeners  audioEls  rendererRSS(MB)  playhead  net(MB)')
    // SOAK_EDITS=1: also edit while it plays (volume x3 on a clip, then undo x3, every 10 s)
    const editRound = async () => {
      const clip = f.locator('.timeline-clip-v2.audio').nth(Math.floor(Math.random() * 5))
      await clip.click({ timeout: 2000 }).catch(() => {})
      const slider = f.locator('.compact-side input[type=range]').first()
      if (!(await slider.count())) return
      await slider.focus().catch(() => {})
      for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight')
      await f.locator('.compact-side').click({ position: { x: 5, y: 5 } }).catch(() => {})
      await slider.evaluate(el => el.blur()).catch(() => {})
      for (let i = 0; i < 3; i++) await page.keyboard.press('Control+z')
    }
    for (let t = 30; t <= secs; t += 30) {
      if (process.env.SOAK_EDITS) {
        for (let k = 0; k < 3; k++) { await editRound(); await sleep(10000) }
      } else await sleep(30000)
      await cdp.send('HeapProfiler.collectGarbage')
      const m = await metrics()
      const d = await dom()
      const ph = await f.locator('.audio-stage-time').innerText().catch(() => '?')
      const cpu = ((m.TaskDuration - prev.TaskDuration) / 30 * 100).toFixed(1)
      const scr = ((m.ScriptDuration - prev.ScriptDuration) / 30 * 100).toFixed(1)
      console.log(`${String(t).padStart(4)}  ${cpu.padStart(5)}  ${scr.padStart(6)}  ${(m.JSHeapUsedSize / 1048576).toFixed(1).padStart(8)}  ${String(m.Nodes).padStart(9)}  ${String(m.JSEventListeners).padStart(9)}  ${String(d.audioEls).padStart(8)}  ${String(rss()).padStart(10)}  ${ph.padStart(8)}  ${(netBytes / 1048576).toFixed(1)}`)
      prev = m
    }
    await page.keyboard.press(' ')
  } else {
  console.log('after open:', JSON.stringify(await dom()))
  await busy('idle (10 s)', 10000)
  await f.locator('.timeline-content').click({ position: { x: 3, y: 60 } }).catch(() => {})
  await busy('playing (15 s)', 15000, () => page.keyboard.press(' '))
  console.log('while playing:', JSON.stringify(await dom()))
  await page.keyboard.press(' ')
  await busy('after stop (5 s)', 5000)
  await page.keyboard.press('Control+Equal'); await page.keyboard.press('Control+Equal'); await page.keyboard.press('Control+Equal')
  await sleep(1500)
  console.log('zoomed in:', JSON.stringify(await dom()))
  await busy('playing zoomed in (15 s)', 15000, () => page.keyboard.press(' '))
  await page.keyboard.press(' ')
  // PROFILE_CPU=1: where the main thread's time goes while playing (self time per function)
  if (process.env.PROFILE_CPU) {
    await sleep(1000)
    await cdp.send('Profiler.enable')
    await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
    await cdp.send('Profiler.start')
    await page.keyboard.press(' ')
    await sleep(12000)
    const { profile } = await cdp.send('Profiler.stop')
    await page.keyboard.press(' ')
    const byId = new Map(profile.nodes.map(n => [n.id, n]))
    const self = new Map()
    const dt = (profile.endTime - profile.startTime) / profile.samples.length / 1000
    for (const id of profile.samples) {
      const n = byId.get(id)
      const cf = n.callFrame
      const key = `${cf.functionName || '(anon)'} ${(cf.url || '').split('/').pop()}:${cf.lineNumber + 1}`
      self.set(key, (self.get(key) || 0) + dt)
    }
    const total = [...self.values()].reduce((a, b) => a + b, 0)
    console.log(`\nCPU profile, 12 s playing (ms self time, top 30):`)
    for (const [k, v] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`${v.toFixed(0).padStart(7)}  ${(v / total * 100).toFixed(1).padStart(5)}%  ${k}`)
    fs.writeFileSync(process.env.PROFILE_OUT || path.join(os.tmpdir(), 'audio-editor.cpuprofile'), JSON.stringify(profile))
  }
  }
} finally {
  await browser.close()
  for (const s of servers) s.close()
  for (const c of children) c.kill('SIGTERM')
  fs.rmSync(S, { recursive: true, force: true })
}
