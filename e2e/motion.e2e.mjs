// End-to-end check of speed, freeze frames, keyframes and punch-ins in the
// Shorts editor, in a real browser against a real backend (like
// audio-editor.e2e.mjs: own test media, throwaway folders and token secret).
// It drives the clip settings, checks the timeline and the preview's video
// element, renders, and reads back what the render shows when.
//
//   node e2e/motion.e2e.mjs        (ffmpeg + ffprobe on PATH, Chromium as for the audio e2e)
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

const S = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-e2e-'))
const DATA = path.join(S, 'data')
const HOST_DIR = path.join(S, 'host')
for (const d of ['uploads', 'rendered', 'work']) fs.mkdirSync(path.join(DATA, d), { recursive: true })
fs.mkdirSync(HOST_DIR)
fs.copyFileSync(path.join(ROOT, 'e2e', 'host.html'), path.join(HOST_DIR, 'index.html'))
const ff = (args) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...args])
// 6 s, 360x640: brightness = 40 x media second (so a frame says where in the
// media it is from), with "speech": tone bursts and pauses
ff(['-f', 'lavfi', '-i', "nullsrc=s=360x640:r=30:d=6,format=gray,geq=lum='min(255,T*40)'",
  '-f', 'lavfi', '-i', "aevalsrc='0.5*sin(2*PI*300*t)*(lt(mod(t,2),1.2))':s=44100:d=6",
  // WebM: Playwright's Chromium plays no H.264
  '-c:v', 'libvpx-vp9', '-b:v', '300k', '-deadline', 'realtime', '-g', '15', '-pix_fmt', 'yuv420p', '-c:a', 'libopus', '-shortest', path.join(HOST_DIR, 'take.webm')])

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) })
const [BACKEND_PORT, HOST_PORT, EDITOR_PORT] = [await freePort(), await freePort(), await freePort()]
const BACKEND = `http://127.0.0.1:${BACKEND_PORT}`
const HOST = `http://127.0.0.1:${HOST_PORT}`
const EDITOR = `http://127.0.0.1:${EDITOR_PORT}`
const SECRET = crypto.randomBytes(24).toString('hex')
const USER = 'badadib'

const children = []
const backend = spawn(process.execPath, ['src/index.js'], {
  cwd: path.join(ROOT, 'backend'),
  env: { ...process.env, PORT: String(BACKEND_PORT), EDITOR_TOKEN_SECRET: SECRET, UPLOAD_DIR: path.join(DATA, 'uploads'), UPLOADS_DIR: path.join(DATA, 'uploads'), RENDERED_DIR: path.join(DATA, 'rendered'), WORK_DIR: path.join(DATA, 'work'), CHROMIUM_PATH: CHROME },
  stdio: ['ignore', 'ignore', 'inherit']
})
children.push(backend)
execFileSync('npx', ['vite', 'build', '--outDir', path.join(S, 'dist'), '--emptyOutDir', '--logLevel', 'error'], {
  cwd: ROOT, stdio: 'inherit', env: { ...process.env, VITE_BACKEND_URLS: BACKEND, VITE_GATEWAY_URL: '' }
})
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.mp4': 'video/mp4', '.webm': 'video/webm', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm' }
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
const mint = (u = USER) => {
  const mid = Buffer.from(JSON.stringify({ u, pro: false, exp: Date.now() + 3600e3 })).toString('base64url')
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

const results = []
const step = async (name, fn) => {
  const t0 = Date.now()
  try {
    await fn()
    results.push(['PASS', name])
    console.log(`PASS ${name} (${Date.now() - t0} ms)`)
  } catch (err) {
    results.push(['FAIL', name])
    if (process.env.E2E_SHOTS && globalThis.__page) await globalThis.__page.screenshot({ path: path.join(process.env.E2E_SHOTS, 'motion-fail.png') }).catch(() => {})
    console.log(`FAIL ${name}: ${err.stack || err.message}`)
    throw err
  }
}
const W = 1080, H = 1920
const brightnessAt = (file, t) => {
  const buf = execFileSync('ffmpeg', ['-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', 'scale=108:192', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'])
  let sum = 0
  for (let y = 86; y < 106; y++) for (let x = 44; x < 64; x++) sum += buf[y * 108 + x]
  return sum / 400
}
const ffDuration = (file) => +execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim()

const browser = await chromium.launch({ executablePath: CHROME, args: ['--autoplay-policy=no-user-gesture-required'] })
const consoleErrors = []
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await ctx.newPage()
  globalThis.__page = page
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', e => consoleErrors.push(`pageerror: ${e.message}`))
  await page.addInitScript((s) => { window.__session = s }, session)
  await page.addInitScript((origin) => { if (location.href.startsWith(origin)) localStorage.setItem('3speak-tour-done', '1') }, EDITOR)
  await page.goto(`${HOST}/index.html?editor=${encodeURIComponent(EDITOR)}&mode=video`)
  const frame = await until(async () => page.frames().find(f => f.url().startsWith(EDITOR)), 'editor frame')
  await until(() => page.evaluate(() => window.__messages.some(m => m.type === 'editor-ready')), 'editor-ready')
  await page.evaluate(async () => {
    const blob = await (await fetch('take.webm')).blob()
    window.__send({ type: 'load-media', file: new File([blob], 'take.webm', { type: 'video/webm' }), name: 'take.webm', mediaType: 'video' })
  })
  const clipBox = () => frame.locator('.timeline-clip-v2:not(.audio)').first()
  const width = async (loc) => (await loc.boundingBox()).width
  const setRange = (loc, v) => loc.evaluate((el, value) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    set.call(el, String(value))
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, v)
  let fullWidth

  await step('the video lands on the timeline with its sound, and its settings show Speed and Keyframes', async () => {
    await until(async () => (await frame.locator('.timeline-clip-v2:not(.audio)').count()) === 1 && (await frame.locator('.timeline-clip-v2.audio').count()) === 1, 'video + audio clip', 30000)
    await clipBox().locator('.clip-content').click()
    await frame.locator('.prop-group-label', { hasText: 'Speed' }).waitFor({ timeout: 10000 })
    await frame.locator('.prop-group-label', { hasText: 'Keyframes' }).waitFor()
    fullWidth = await width(clipBox())
  })

  await step('2x: video and its sound half as long, badge, preview plays at 2x', async () => {
    await frame.getByRole('radio', { name: '2x' }).click()
    await until(async () => Math.abs(await width(clipBox()) - fullWidth / 2) < 3, 'clip half as wide', 5000)
    assert.ok(Math.abs(await width(frame.locator('.timeline-clip-v2.audio').first()) - fullWidth / 2) < 3, 'sound too')
    assert.equal(await clipBox().locator('.clip-speed-badge').innerText(), '2x')
    await frame.locator('.global-preview-controls button[title="Play"]').first().click()
    const rate = await until(() => frame.evaluate(() => {
      const v = [...document.querySelectorAll('.preview-layer-container video')].find(e => !e.paused)
      return v ? v.playbackRate : null
    }), 'a playing video', 10000)
    assert.equal(rate, 2)
    const audioRate = await frame.evaluate(() => [...document.querySelectorAll('audio')].find(e => !e.paused)?.playbackRate ?? null)
    assert.equal(audioRate, 2)
    await frame.locator('.global-preview-controls button[title="Pause"]').first().click()
  })

  await step('undo brings back normal speed', async () => {
    await frame.locator('body').press('Control+z')
    await until(async () => Math.abs(await width(clipBox()) - fullWidth) < 3, 'clip full width again', 5000)
    assert.equal(await clipBox().locator('.clip-speed-badge').count(), 0)
  })

  await step('a speed ramp, then a freeze frame at the playhead', async () => {
    await frame.getByRole('radio', { name: 'Slow down' }).click()
    await until(async () => (await clipBox().locator('.clip-speed-badge').innerText()) === 'Ramp', 'ramp badge', 5000)
    await frame.getByRole('radio', { name: 'Off' }).click()
    await until(async () => (await clipBox().locator('.clip-speed-badge').count()) === 0, 'ramp off', 5000)
    // playhead to 2 s, freeze 1 s
    const reset = frame.locator('.global-preview-controls button[title="Reset"]').first()
    if (await reset.isEnabled()) await reset.click() // (disabled at 0:00)
    await frame.locator('body').press('Shift+ArrowRight')
    await frame.locator('body').press('Shift+ArrowRight')
    await frame.getByRole('radio', { name: '1 s' }).click()
    await frame.getByRole('button', { name: 'Freeze at playhead' }).click()
    await until(async () => (await frame.locator('.timeline-clip-v2:not(.audio)').count()) === 3, 'split + still', 5000)
    assert.equal(await frame.locator('.clip-speed-badge', { hasText: 'Still' }).count(), 1)
    assert.equal(await frame.locator('.timeline-clip-v2.audio').count(), 2, 'the sound split too, no sound for the still')
  })

  await step('keyframes: diamond at the playhead, a second one later, marks on the clip', async () => {
    // the first part of the clip (0..2 s): playhead back to 0.5
    const reset = frame.locator('.global-preview-controls button[title="Reset"]').first()
    if (await reset.isEnabled()) await reset.click() // (disabled at 0:00)
    await frame.locator('.timeline-clip-v2:not(.audio)').first().locator('.clip-content').click({ position: { x: 20, y: 12 } })
    for (let i = 0; i < 5; i++) await frame.locator('body').press('ArrowRight')
    await frame.getByRole('button', { name: 'Add Scale keyframe' }).click({ timeout: 5000 })
    for (let i = 0; i < 10; i++) await frame.locator('body').press('ArrowRight')
    await frame.getByRole('button', { name: 'Add Scale keyframe' }).click()
    await setRange(frame.getByRole('slider', { name: 'Scale' }), 150)
    await until(async () => (await frame.locator('.clip-keyframe-diamond').count()) === 2, 'two diamonds', 5000)
    // the preview layer is scaled by the keyframes at the playhead
    const tf = await frame.evaluate(() => document.querySelector('.preview-layer-container video[data-kf-id]')?.style.transform || '')
    assert.match(tf, /scale\(1\.5\)/, tf)
    if (process.env.E2E_SHOTS) {
      await frame.locator('.prop-group-label', { hasText: 'Speed' }).scrollIntoViewIfNeeded()
      await page.screenshot({ path: path.join(process.env.E2E_SHOTS, 'motion-speed.png') })
      await frame.locator('.prop-group', { has: frame.locator('.prop-group-label', { hasText: 'Keyframes' }) }).screenshot({ path: path.join(process.env.E2E_SHOTS, 'motion-keyframes.png') })
    }
  })

  await step('auto punch-ins from the sound, then Remove punch-ins', async () => {
    await frame.getByRole('button', { name: 'Auto punch-ins' }).click()
    const note = await frame.locator('[role="status"]', { hasText: /punch-in|No sentence|could not/ }).first()
    await note.waitFor({ timeout: 30000 })
    const text = await note.innerText()
    console.log('    ' + text)
    if (/added/.test(text)) {
      await frame.getByRole('button', { name: 'Remove punch-ins' }).click()
      await until(async () => (await frame.getByRole('button', { name: 'Remove punch-ins' }).count()) === 0, 'punch-ins removed', 5000)
    }
    assert.equal(await frame.locator('.clip-keyframe-diamond').count(), 2, 'the hand-made keyframes stay')
  })

  let out
  await step('render: the still and the keyframes come out as the preview shows them', async () => {
    await frame.getByRole('button', { name: /Render/ }).first().click()
    const done = await until(() => page.evaluate(() => window.__messages.find(m => m.type === 'render-complete' || m.type === 'render-failed')), 'render finished', 180000)
    assert.equal(done.type, 'render-complete', JSON.stringify(done))
    out = path.join(DATA, 'rendered', path.basename(new URL(done.outputUrl || done.url).pathname))
    // 6 s of video + a 1 s still
    assert.ok(Math.abs(ffDuration(out) - 7) < 0.2, `length ${ffDuration(out)}`)
    // 2.5 s into the timeline = the still of media second 2 (brightness 80)
    assert.ok(Math.abs(brightnessAt(out, 2.5) - 80) < 8, `still ${brightnessAt(out, 2.5)}`)
    // 4 s in = media second 3 (after the still)
    assert.ok(Math.abs(brightnessAt(out, 4) - 120) < 10, `after the still ${brightnessAt(out, 4)}`)
  })
  if (process.env.E2E_SHOTS) {
    // Phone: the clip settings are tabs; Speed and Keyframes are two of them
    const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true })
    const p = await pctx.newPage()
    // another user: badadib's draft from above would open the drafts prompt
    await p.addInitScript((s) => { window.__session = s }, { ...session, user: 'fan', token: mint('fan') })
    await p.addInitScript((origin) => { if (location.href.startsWith(origin)) localStorage.setItem('3speak-tour-done', '1') }, EDITOR)
    await p.goto(`${HOST}/index.html?editor=${encodeURIComponent(EDITOR)}&mode=video`)
    const pf = await until(async () => p.frames().find(f => f.url().startsWith(EDITOR)), 'phone editor frame')
    await until(() => p.evaluate(() => window.__messages.some(m => m.type === 'editor-ready')), 'phone editor-ready')
    await p.evaluate(async () => {
      const blob = await (await fetch('take.webm')).blob()
      window.__send({ type: 'load-media', file: new File([blob], 'take.webm', { type: 'video/webm' }), name: 'take.webm', mediaType: 'video' })
    })
    await until(async () => (await pf.locator('.timeline-clip-v2:not(.audio)').count()) === 1, 'phone clip', 30000)
    await pf.locator('.timeline-clip-v2:not(.audio) .clip-content').first().tap({ position: { x: 30, y: 12 } })
    await pf.locator('.clip-settings-btn').first().tap().catch(() => {})
    await sleep(500)
    for (const tab of ['Speed', 'Keyframes']) {
      const t = pf.getByRole('tab', { name: tab })
      if (await t.count()) {
        await t.tap()
        await sleep(300)
        await p.screenshot({ path: path.join(process.env.E2E_SHOTS, `motion-phone-${tab}.png`) })
      }
    }
    await p.screenshot({ path: path.join(process.env.E2E_SHOTS, 'motion-phone-0.png') })
    await pctx.close()
  }
} finally {
  await browser.close()
  for (const s of servers) s.close()
  for (const c of children) c.kill('SIGTERM')
  if (!process.env.KEEP_E2E) fs.rmSync(S, { recursive: true, force: true })
  else console.log(`kept ${S}`)
  const relevant = consoleErrors.filter(e => !/favicon|ERR_ABORTED|net::ERR_BLOCKED|by-hash|PUT \S+\/api\/projects\/|status of (404|409)/.test(e))
  console.log(`\nconsole errors: ${relevant.length}`)
  for (const e of relevant.slice(0, 15)) console.log('  ' + e.slice(0, 300))
  console.log(`\n${results.filter(r => r[0] === 'PASS').length}/${results.length} steps passed`)
  if (relevant.length || results.some(r => r[0] === 'FAIL')) process.exitCode = 1
}
