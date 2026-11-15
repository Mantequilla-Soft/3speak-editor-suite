// End-to-end test of the word tools in the audio editor, in a real browser
// against a real backend (like e2e/audio-editor.e2e.mjs, whose set-up this
// follows): the transcript (edit by text: Delete cuts words, undo brings them
// back, the draft keeps the words), Remove fillers, chapter suggestions, and
// the phone layout. Speech to text is a stand-in whisper-cli (it "hears" set
// words at set times), so the test needs no model; everything else is real.
//
//   node e2e/word-tools.e2e.mjs   (needs ffmpeg + ffprobe on PATH and Chromium:
//   E2E_CHROME=/path/to/chrome     defaults to Playwright's chromium-1148)
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

const S = fs.mkdtempSync(path.join(os.tmpdir(), 'word-tools-e2e-'))
const DATA = path.join(S, 'data')
const HOST_DIR = path.join(S, 'host')
for (const d of ['uploads', 'rendered', 'work']) fs.mkdirSync(path.join(DATA, d), { recursive: true })
fs.mkdirSync(HOST_DIR)
fs.copyFileSync(path.join(ROOT, 'e2e', 'host.html'), path.join(HOST_DIR, 'index.html'))
const ff = (args) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...args])
// 7.5 s: tones where the stand-in hears words
ff(['-f', 'lavfi', '-i', 'sine=f=300:d=7.5', '-ar', '16000', path.join(HOST_DIR, 'speech.wav')])
// 6 minutes of "talk" in three topics (the stand-in's words change every 2 minutes)
ff(['-f', 'lavfi', '-i', 'sine=f=300:d=360', '-ar', '16000', path.join(HOST_DIR, 'talk.wav')])

// The stand-in whisper-cli: short files get set words (one "um," and two long pauses),
// long ones a talk whose topic changes every 120 s
const FAKE = path.join(S, 'whisper-cli')
fs.writeFileSync(FAKE, `#!/usr/bin/env node
const fs = require('fs')
const a = process.argv.slice(2)
const arg = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null }
const seconds = (fs.statSync(arg('-f')).size - 44) / 32000
const words = []
const w = (text, from, to) => { if (to <= seconds + 0.01) words.push({ text: ' ' + text, offsets: { from: Math.round(from * 1000), to: Math.round(to * 1000) } }) }
if (seconds < 20) {
  w('Hello', 0.1, 0.5); w('everyone,', 0.5, 0.95); w('um,', 2.6, 2.9); w('welcome', 3.0, 3.6); w('back.', 3.7, 4.4); w('Bye.', 6.6, 7.3)
} else {
  const topics = [['hive', 'witnesses', 'voting', 'proposals', 'governance', 'stake'], ['pasta', 'tomato', 'garlic', 'sauce', 'kitchen', 'basil'], ['football', 'match', 'goal', 'team', 'players', 'season']]
  const glue = ['the', 'and', 'we', 'it', 'is', 'so', 'that', 'really', 'about']
  let s = 7
  const r = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648 }
  for (let t = 0; t + 0.3 < seconds; t += 0.4) {
    const pool = r() < 0.45 ? topics[Math.min(2, Math.floor(t / 120))] : glue
    w(pool[Math.floor(r() * pool.length)], t, t + 0.3)
  }
}
fs.writeFileSync(arg('-of') + '.json', JSON.stringify({ result: { language: 'en' }, transcription: words }))
`, { mode: 0o755 })
fs.writeFileSync(path.join(S, 'model.bin'), 'x')

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) })
const [BACKEND_PORT, HOST_PORT, EDITOR_PORT] = [await freePort(), await freePort(), await freePort()]
const BACKEND = `http://127.0.0.1:${BACKEND_PORT}`
const HOST = `http://127.0.0.1:${HOST_PORT}`
const EDITOR = `http://127.0.0.1:${EDITOR_PORT}`
const SECRET = crypto.randomBytes(24).toString('hex')
const USER = 'e2etester'

const children = []
const backend = spawn(process.execPath, ['src/index.js'], {
  cwd: path.join(ROOT, 'backend'),
  env: { ...process.env, PORT: String(BACKEND_PORT), EDITOR_TOKEN_SECRET: SECRET, UPLOAD_DIR: path.join(DATA, 'uploads'), UPLOADS_DIR: path.join(DATA, 'uploads'), RENDERED_DIR: path.join(DATA, 'rendered'), WORK_DIR: path.join(DATA, 'work'), CHROMIUM_PATH: CHROME, TRANSCRIPT_CHUNK_SECONDS: '600', WHISPER_BIN: FAKE, WHISPER_MODEL: path.join(S, 'model.bin') },
  stdio: ['ignore', 'pipe', 'pipe']
})
let backendLog = '' // what the backend logs (the audiogram says when it burnt captions in)
backend.stdout.on('data', d => { backendLog = (backendLog + d).slice(-20000) })
backend.stderr.on('data', d => { backendLog = (backendLog + d).slice(-20000); process.stderr.write(d) })
children.push(backend)
execFileSync('npx', ['vite', 'build', '--outDir', path.join(S, 'dist'), '--emptyOutDir', '--logLevel', 'error'], {
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
  const mid = Buffer.from(JSON.stringify({ u: USER, pro: true, exp: Date.now() + 3600e3 })).toString('base64url')
  return `v1.${mid}.${crypto.createHmac('sha256', SECRET).update(mid).digest('hex')}`
}
const session = { token: mint(), user: USER, pro: true, maxProjects: 3, ttlHours: 720 }
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
const clipsOf = (state) => state.tracks.flatMap(t => t.clips.map(c => ({ ...c, track: t.name, music: !!t.music })))
const kept = (state) => clipsOf(state).filter(c => !c.music).reduce((s, c) => s + (c.endTime - c.startTime), 0)

const results = []
const step = async (name, fn) => {
  const t0 = Date.now()
  try {
    await fn()
    results.push(['PASS', name])
    console.log(`PASS ${name} (${Date.now() - t0} ms)`)
  } catch (err) {
    results.push(['FAIL', name, err.message])
    console.log(`FAIL ${name}: ${err.stack || err.message}`)
    throw err
  }
}

const browser = await chromium.launch({ executablePath: CHROME, args: ['--autoplay-policy=no-user-gesture-required'] })
const consoleErrors = []
async function openEditor({ file, viewport = { width: 1280, height: 860 }, mode = 'audio' }) {
  const ctx = await browser.newContext({ viewport })
  const page = await ctx.newPage()
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', e => consoleErrors.push(`pageerror: ${e.message}`))
  await page.addInitScript((s) => { window.__session = s }, session)
  await page.addInitScript((origin) => {
    if (location.href.startsWith(origin)) {
      localStorage.setItem('3speak-audio-tour-done', '1')
      localStorage.setItem('3speak-tour-done', '1')
      localStorage.setItem('3speak-audiogram-tour-done', '1')
      localStorage.setItem('3speak-audiogram-pick-tour-done', '1')
    }
  }, EDITOR)
  await page.goto(`${HOST}/index.html?editor=${encodeURIComponent(EDITOR)}${file ? `&file=${file}` : ''}&mode=${mode}`)
  const frame = await until(async () => page.frames().find(f => f.url().startsWith(EDITOR)), 'editor frame')
  await until(() => page.evaluate(() => window.__messages.some(m => m.type === 'editor-ready')), 'editor-ready')
  if (file) await until(async () => (await frame.locator('.timeline-clip-v2.audio').count()) >= 1, 'the recording on the timeline')
  return { ctx, page, frame }
}
const wordsIn = (frame) => frame.locator('.transcript-word').allInnerTexts()

try {
  const { frame } = await openEditor({ file: 'speech.wav' })
  await until(() => drafts().find(p => clipsOf(p.state).some(c => /\/api\/upload\/files\//.test(c.url))), 'uploaded and saved', 45000)

  await step('Transcript: the words of the recording come in, by speaker, the draft keeps them', async () => {
    await frame.getByRole('button', { name: 'Transcript' }).click()
    await frame.locator('.transcript-panel').waitFor()
    await frame.getByRole('button', { name: /Transcribe \(/ }).click()
    await until(async () => (await wordsIn(frame)).length === 6, 'six words', 30000)
    assert.deepEqual(await wordsIn(frame), ['Hello', 'everyone,', 'um,', 'welcome', 'back.', 'Bye.'])
    assert.equal(await frame.locator('.transcript-para-head .transcript-speaker').first().innerText(), 'Voice')
    const d = await until(() => drafts().find(p => p.state.transcript), 'draft with the transcript', 20000)
    assert.equal(Object.values(d.state.transcript.sources)[0].w.length, 6)
  })

  await step('click a word and Delete: it is cut out of the recording; Undo brings it back', async () => {
    await frame.locator('.transcript-word', { hasText: 'um,' }).click()
    assert.match(await frame.locator('.transcript-actions .transcript-count').innerText(), /1 word/)
    await frame.locator('.transcript-scroll').press('Delete')
    await until(async () => !(await wordsIn(frame)).includes('um,'), 'the word gone')
    await until(async () => (await frame.locator('.timeline-clip-v2.audio').count()) === 2, 'the recording split in two')
    const d = await until(() => drafts().find(p => clipsOf(p.state).length === 2), 'draft with the cut', 20000)
    const total = kept(d.state)
    assert.ok(total > 7.0 && total < 7.2, `kept ${total.toFixed(2)} s (cut about 0.4 s)`)
    assert.match(await frame.locator('.audio-template-notice').innerText(), /Cut 1 word/)
    await frame.locator('.transcript-scroll').press('Control+z')
    await until(async () => (await wordsIn(frame)).includes('um,'), 'the word back')
    assert.equal(await frame.locator('.timeline-clip-v2.audio').count(), 1)
  })

  await step('Remove fillers: the um and the long pauses in a review list, cut in one go (pauses shortened)', async () => {
    await frame.getByRole('button', { name: 'Remove fillers' }).click()
    const dialog = frame.getByRole('dialog', { name: 'Remove fillers and pauses' })
    await dialog.waitFor()
    await until(async () => (await dialog.locator('.filler-item').count()) === 3, 'one filler and two pauses')
    assert.match(await dialog.locator('.filler-item').nth(1).innerText(), /um,/)
    // untick the first pause: it stays as it is
    await dialog.locator('.filler-item').first().locator('input[type=checkbox]').uncheck()
    assert.match(await dialog.locator('.silence-cut-summary').innerText(), /1 filler, 1 pause ticked/)
    await dialog.getByRole('button', { name: /^Cut 2/ }).click()
    await until(async () => !(await wordsIn(frame)).includes('um,'), 'the filler gone')
    const d = await until(() => drafts().find(p => clipsOf(p.state).length >= 2 && kept(p.state) < 6), 'draft with the fillers cut', 20000)
    const total = kept(d.state)
    // the um with the 0.1 s after it (the 1.65 s pause before it stays: unticked) and the 2.2 s pause shortened to 0.5 s
    assert.ok(total > 5.2 && total < 5.6, `kept ${total.toFixed(2)} s`)
    assert.deepEqual(await wordsIn(frame), ['Hello', 'everyone,', 'welcome', 'back.', 'Bye.'])
  })

  await step('Video podcast: the transcript\'s words go along as its captions (no listening again)', async () => {
    const page = frame.page()
    await frame.getByRole('button', { name: /^Export$/ }).click()
    await frame.getByRole('button', { name: 'Use this audio' }).first().waitFor({ timeout: 90000 })
    await frame.getByRole('button', { name: 'Video podcast' }).click()
    const dialog = frame.getByRole('dialog', { name: 'Video podcast' })
    await dialog.waitFor()
    assert.match(await dialog.innerText(), /The words of your transcript/)
    const req = page.waitForRequest(r => r.method() === 'POST' && new URL(r.url()).pathname === '/api/video-podcast')
    await dialog.getByRole('button', { name: 'Make video podcast' }).click()
    const body = (await req).postDataJSON()
    assert.equal(body.captions.on, true)
    assert.deepEqual(body.captions.words.map(w => w.text), ['Hello', 'everyone,', 'welcome', 'back.', 'Bye.'])
    await until(() => /\[video-podcast\] \S+: .* 5 words/.test(backendLog), 'the video podcast made with those 5 words', 120000)
    await dialog.getByRole('button', { name: 'Close' }).first().click().catch(() => {})
  })

  await step('phone layout: the transcript fits, no sideways scrolling', async () => {
    const p = await openEditor({ file: 'speech.wav', viewport: { width: 390, height: 844 } })
    await p.frame.getByRole('button', { name: 'Transcript' }).click()
    await p.frame.locator('.transcript-panel').waitFor()
    const over = await p.frame.evaluate(() => document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth)
    assert.ok(over <= 1, `page ${over}px wider than the screen`)
    await p.ctx.close()
  })

  await step('Audiograms: captions on, the piece\'s words are fetched, shown in their box, and burnt into the video', async () => {
    const a = await openEditor({ file: 'speech.wav' })
    const f = a.frame
    await until(() => drafts().length >= 1, 'saved')
    await f.getByRole('button', { name: /^Export$/ }).click()
    await f.getByRole('button', { name: 'Use this audio' }).first().waitFor({ timeout: 90000 })
    await f.getByRole('button', { name: 'Use this audio' }).first().click()
    await f.locator('.video-preview-send').click()
    await f.getByRole('button', { name: 'Make audiograms' }).click()
    const ag = f.getByRole('dialog', { name: 'Audiograms' })
    await ag.getByRole('button', { name: 'Choose on the timeline' }).click()
    await f.locator('.range-pick-bar').waitFor()
    const rp = await f.locator('.timeline-ruler').boundingBox()
    await a.page.mouse.click(rp.x + 3, rp.y + rp.height / 2)
    await a.page.mouse.click(rp.x + Math.min(rp.width, (await f.locator('.timeline-content').boundingBox()).width) * 0.6, rp.y + rp.height / 2)
    await f.getByRole('button', { name: 'Use this piece' }).click()
    await ag.getByTestId('audiogram-captions').waitFor({ timeout: 20000 })
    await ag.getByLabel('Show what is said, word by word').check()
    await until(async () => /words in this piece/.test(await ag.getByTestId('audiogram-captions').innerText()), 'the piece\'s words', 30000)
    const box = ag.locator('.audiogram-box[data-layer="captions"]')
    await box.waitFor()
    assert.match(await box.innerText(), /HELLO|EVERYONE|UM|WELCOME|BACK/)
    await ag.getByRole('radio', { name: 'Pop' }).click()
    await ag.getByRole('button', { name: 'Make audiogram' }).click()
    await ag.getByTestId('audiogram-item').first().waitFor({ timeout: 120000 })
    await until(() => /with captions -> audiogram-/.test(backendLog), 'the backend burnt the captions in', 5000)
    const tpl = JSON.parse(await until(() => { const p = path.join(DATA, 'uploads', '.templates', USER, 'audiogram.json'); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null }, 'audiogram template'))
    assert.equal(tpl.captions.on, true)
    assert.equal(tpl.captions.preset, 'pop')
    await a.ctx.close()
  })

  await step('Chapters: Suggest finds the topic changes of a 6-minute talk, titled by their words; Add all', async () => {
    const t = await openEditor({ file: 'talk.wav' })
    await t.frame.getByRole('button', { name: 'Transcript' }).click()
    await t.frame.getByRole('button', { name: /Transcribe \(/ }).click({ timeout: 60000 })
    await until(async () => +((await t.frame.locator('.transcript-hint').innerText().catch(() => '')).match(/^([\d,]+) words/)?.[1] || '0').replace(/,/g, '') > 800, 'the talk transcribed', 60000)
    await t.frame.getByRole('button', { name: 'Chapters', exact: true }).click()
    await t.frame.getByRole('button', { name: 'Suggest chapters' }).click()
    const rows = t.frame.locator('.chapter-suggest-list li')
    await until(async () => (await rows.count()) >= 3, 'suggestions', 20000).catch(async (err) => { console.log('CHAPTERS:', await t.frame.locator('.audio-chapters').innerText()); throw err })
    const list = await rows.evaluateAll(lis => lis.map(li => [li.querySelector('.audio-chapters-time').innerText.trim(), li.querySelector('input').value]))
    assert.equal(list[0][1], 'Intro')
    const at = (s) => s.split(':').reduce((a, b) => a * 60 + +b, 0)
    const second = list.find(([time]) => Math.abs(at(time) - 120) < 30)
    const third = list.find(([time]) => Math.abs(at(time) - 240) < 30)
    assert.ok(second && /pasta|tomato|garlic|sauce|kitchen|basil/i.test(second[1]), `a chapter near 2:00 about cooking in ${JSON.stringify(list)}`)
    assert.ok(third && /football|match|goal|team|players|season/i.test(third[1]), `a chapter near 4:00 about football in ${JSON.stringify(list)}`)
    const n = list.length
    await t.frame.getByRole('button', { name: new RegExp(`Add all ${n}`) }).click()
    await until(async () => (await t.frame.locator('.audio-chapters-list:not(.chapter-suggest-list) li').count()) === n, 'the chapters added')
    await t.ctx.close()
  })

  await step('the Shorts editor has the transcript too (the Transcript button next to Captions)', async () => {
    const v = await openEditor({ file: null, mode: 'video' })
    await v.frame.getByText('Shorts Editor').first().waitFor()
    await v.frame.getByRole('button', { name: 'Transcript' }).click()
    await v.frame.locator('.transcript-panel').waitFor()
    assert.match(await v.frame.locator('.transcript-panel').innerText(), /Add a recording with speech first/)
    // Captions and the transcript take turns in the same place
    await v.frame.getByRole('button', { name: 'Captions' }).click()
    await v.frame.locator('.captions-panel').waitFor()
    assert.equal(await v.frame.locator('.transcript-panel').count(), 0)
    await v.ctx.close()
  })
} finally {
  await browser.close()
  for (const s of servers) s.close()
  for (const c of children) c.kill('SIGTERM')
  fs.rmSync(S, { recursive: true, force: true })
  const relevant = consoleErrors.filter(e => !/favicon|ERR_ABORTED|net::ERR_BLOCKED|by-hash|status of (404|409)/.test(e))
  console.log(`\nconsole errors: ${relevant.length}`)
  for (const e of relevant.slice(0, 15)) console.log('  ' + e.slice(0, 300))
  console.log(`\n${results.filter(r => r[0] === 'PASS').length}/${results.length} steps passed`)
  if (relevant.length || results.some(r => r[0] === 'FAIL')) process.exitCode = 1
}
