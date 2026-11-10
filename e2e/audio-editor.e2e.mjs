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
ff(['-f', 'lavfi', '-i', 'sine=f=300:d=1', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=1.5', '-f', 'lavfi', '-i', 'sine=f=350:d=2',
  '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=2', '-f', 'lavfi', '-i', 'sine=f=400:d=1',
  '-filter_complex', '[0:a][1:a][2:a][3:a][4:a]concat=n=5:v=0:a=1,volume=6dB', '-ar', '44100', path.join(HOST_DIR, 'speech.wav')])
ff(['-f', 'lavfi', '-i', 'sine=f=800:d=2', '-ar', '44100', path.join(HOST_DIR, 'intro.wav')])
ff(['-f', 'lavfi', '-i', 'sine=f=600:d=1.5', '-ar', '44100', path.join(HOST_DIR, 'outro.wav')])
ff(['-f', 'lavfi', '-i', 'anoisesrc=d=5:c=pink:a=0.3', '-ar', '44100', path.join(HOST_DIR, 'bed.wav')])
// two voices on their own tracks: host talks 0-2 and 6-8, guest 3-5; both quiet 2-3, 5-6, 8-10
ff(['-f', 'lavfi', '-i', 'sine=f=300:d=2', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=4', '-f', 'lavfi', '-i', 'sine=f=320:d=2', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=2',
  '-filter_complex', '[0:a][1:a][2:a][3:a]concat=n=4:v=0:a=1,volume=6dB', '-ar', '44100', path.join(HOST_DIR, 'host.wav')])
ff(['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=3', '-f', 'lavfi', '-i', 'sine=f=500:d=2', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=5',
  '-filter_complex', '[0:a][1:a][2:a]concat=n=3:v=0:a=1,volume=6dB', '-ar', '44100', path.join(HOST_DIR, 'guest.wav')])

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
  env: { ...process.env, PORT: String(BACKEND_PORT), EDITOR_TOKEN_SECRET: SECRET, UPLOAD_DIR: path.join(DATA, 'uploads'), UPLOADS_DIR: path.join(DATA, 'uploads'), RENDERED_DIR: path.join(DATA, 'rendered'), WORK_DIR: path.join(DATA, 'work'), CHROMIUM_PATH: CHROME },
  stdio: ['ignore', 'ignore', 'inherit']
})
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

try {
  let first
  await step('editor-ready announces the audio editor (mode, canEditAudio, canLoadFile, canSaveDrafts)', async () => {
    first = await openEditor()
    const ready = await first.page.evaluate(() => window.__messages.find(m => m.type === 'editor-ready'))
    assert.deepEqual({ mode: ready.mode, canEditAudio: ready.canEditAudio, canLoadFile: ready.canLoadFile, canSaveDrafts: ready.canSaveDrafts }, { mode: 'audio', canEditAudio: true, canLoadFile: true, canSaveDrafts: true })
  })

  const { page, frame } = first
  await step('first visit: the audio tour walks through the tools, is remembered, and the ? button shows it again', async () => {
    const t = await openEditor({ file: null, tourSeen: false })
    const tip = t.frame.locator('.tour-tooltip')
    await tip.waitFor({ timeout: 15000 })
    assert.match(await tip.locator('.tour-tooltip-title').innerText(), /Welcome to the Audio Editor/)
    const titles = []
    for (let i = 0; i < 20; i++) {
      titles.push(await tip.locator('.tour-tooltip-title').innerText())
      const next = tip.locator('.tour-next-btn')
      const last = /Got it/.test(await next.innerText())
      await next.click()
      if (last) break
    }
    for (const want of ['Cut silences', 'Your template', 'Normalize', 'Chapters', 'Export']) assert.ok(titles.includes(want), `tour step ${want} in ${titles.join(', ')}`)
    await until(async () => (await t.frame.locator('.tour-overlay').count()) === 0, 'tour closed')
    assert.equal(await t.frame.evaluate(() => localStorage.getItem('3speak-audio-tour-done')), '1')
    // the shorts editor's tour is a separate flag: seeing this one doesn't skip it
    assert.equal(await t.frame.evaluate(() => localStorage.getItem('3speak-tour-done')), null)
    await t.frame.locator('.branding-help-btn').click()
    await tip.waitFor({ timeout: 5000 })
    await tip.locator('.tour-skip-btn').click()
    await until(async () => (await t.frame.locator('.tour-overlay').count()) === 0, 'tour skipped')
    await t.ctx.close()
  })

  await step('audio layout: Audio Editor branding, Voice + Music tracks, no video tools', async () => {
    await frame.getByText('Audio Editor').first().waitFor()
    assert.ok(await frame.getByRole('button', { name: /Cut silences/ }).isVisible())
    assert.ok(await frame.getByRole('button', { name: /Template/ }).isVisible())
    assert.equal(await frame.getByRole('button', { name: 'Normalize loudness' }).getAttribute('aria-pressed'), 'true')
    assert.match(await frame.getByRole('button', { name: 'Normalize loudness' }).innerText(), /Normalize: on/)
    assert.equal(await frame.getByRole('button', { name: 'Duck music' }).count(), 0, 'no Duck in the top bar')
    // tracks numbered on the left
    assert.deepEqual(await frame.locator('.track-label .track-number').allInnerTexts(), ['1', '2'])
    const labels = await frame.locator('.track-label').evaluateAll(els => els.map(e => e.getAttribute('aria-label')))
    assert.deepEqual(labels, ['Voice', 'Music'])
    assert.equal(await frame.locator('.track-label:not(.audio)').count(), 0, 'no video track')
    await frame.locator('.audio-stage-lane-name').first().waitFor()
    assert.deepEqual(await frame.locator('.audio-stage-lane-name').allInnerTexts(), ['Voice', 'Music'])
  })

  await step('the loaded recording lands on the Voice track, uploads, and autosaves as an audio draft', async () => {
    await until(async () => (await frame.locator('.timeline-clip-v2.audio').count()) === 1, 'one clip on the timeline')
    await frame.locator('.audio-stage canvas').waitFor()
    const d = await until(() => drafts().find(p => clipsOf(p.state).some(c => /\/api\/upload\/files\//.test(c.url))), 'draft with uploaded clip', 45000)
    assert.equal(d.mode, 'audio')
    assert.equal(d.state.mode, 'audio')
    assert.deepEqual(d.state.master, { loudness: true, duck: false, duckDb: -12 })
    const clips = clipsOf(d.state)
    assert.equal(clips.length, 1)
    assert.equal(clips[0].track, 'Voice')
    assert.ok(Math.abs((clips[0].endTime - clips[0].startTime) - 7.5) < 0.1, `length ${clips[0].endTime - clips[0].startTime}`)
  })

  await step('Cut silences cuts the pauses out and closes the gaps (7.5 s -> about 4.6 s)', async () => {
    await frame.getByRole('button', { name: /Cut silences/ }).click()
    await frame.getByRole('dialog', { name: 'Cut silences' }).waitFor()
    await until(async () => /cuts/.test(await frame.locator('.silence-cut-summary').innerText().catch(() => '')), 'cut plan summary')
    await frame.getByRole('button', { name: /Edit for me|This clip only/ }).click()
    await until(async () => (await frame.locator('.timeline-clip-v2.audio').count()) === 3, 'three speech parts')
    const d = await until(() => drafts().find(p => clipsOf(p.state).length === 3), 'draft with 3 parts')
    const clips = clipsOf(d.state).sort((a, b) => a.timelinePosition - b.timelinePosition)
    const total = clips.reduce((s, c) => s + (c.endTime - c.startTime), 0)
    assert.ok(total > 4.2 && total < 5.2, `kept ${total.toFixed(2)} s`)
    // packed back to back
    for (let i = 1; i < clips.length; i++) {
      const prevEnd = clips[i - 1].timelinePosition + (clips[i - 1].endTime - clips[i - 1].startTime)
      assert.ok(Math.abs(clips[i].timelinePosition - prevEnd) < 0.01, 'no gap between parts')
    }
  })

  await step('Template: intro, outro and music bed saved for good, applied around the recording', async () => {
    await frame.getByRole('button', { name: /Template/ }).click()
    const dialog = frame.getByRole('dialog', { name: 'Your template' })
    await dialog.waitFor()
    for (const [role, file] of [['intro', 'intro.wav'], ['outro', 'outro.wav'], ['bed', 'bed.wav']]) {
      await dialog.locator(`.audio-template-slot[data-role="${role}"] input[type=file]`).setInputFiles(path.join(HOST_DIR, file))
      await until(async () => !/None/.test(await dialog.locator(`.audio-template-slot[data-role="${role}"] .audio-template-file`).innerText()), `${role} uploaded`)
    }
    await dialog.getByLabel('Music bed volume').fill('15')
    await dialog.getByText('Cut the silences out of every new recording').click()
    await dialog.getByRole('button', { name: /Save and apply/ }).click()
    await frame.getByText(/Template applied: intro, outro, music bed/).waitFor()
    const tpl = JSON.parse(fs.readFileSync(templateFile, 'utf8'))
    assert.deepEqual(Object.keys(tpl.slots).sort(), ['bed', 'intro', 'outro'])
    assert.equal(tpl.expiresAt, undefined, 'kept for good')
    assert.equal(tpl.slots.bed.volume, 15)
    assert.equal(tpl.silence.enabled, true)
    assert.equal(tpl.files.length, 3)
    const d = await until(() => drafts().find(p => clipsOf(p.state).some(c => c.templateRole === 'outro')), 'draft with template parts')
    const clips = clipsOf(d.state)
    const intro = clips.find(c => c.templateRole === 'intro')
    const outro = clips.find(c => c.templateRole === 'outro')
    const content = clips.filter(c => !c.templateRole).sort((a, b) => a.timelinePosition - b.timelinePosition)
    const contentEnd = content.at(-1).timelinePosition + (content.at(-1).endTime - content.at(-1).startTime)
    assert.equal(intro.timelinePosition, 0)
    assert.ok(Math.abs(content[0].timelinePosition - 2) < 0.02, 'content moved right by the 2 s intro')
    assert.ok(Math.abs(outro.timelinePosition - contentEnd) < 0.02, 'outro right after the content')
    const bed = clips.filter(c => c.templateRole === 'bed')
    assert.ok(bed.length >= 1 && bed.every(c => c.music && c.volume === 15), 'bed on a music track at 15%')
  })

  let posted
  await step('Export renders an MP3 (levelled) and "Use this audio" posts it back to 3Speak', async () => {
    await frame.getByRole('button', { name: /^Export$/ }).click()
    await frame.getByRole('button', { name: 'Use this audio' }).first().waitFor({ timeout: 90000 })
    await frame.getByRole('button', { name: 'Use this audio' }).first().click()
    await frame.locator('.audio-preview-player').waitFor()
    await frame.locator('.video-preview-send').click()
    // no audiograms for this audio: it asks first, once
    await frame.getByText('Make audiograms for Shorts?').waitFor()
    await frame.getByRole('button', { name: 'No, use the audio' }).click()
    posted = await until(() => page.evaluate(() => window.__messages.find(m => m.type === 'post-to-3speak')), 'post-to-3speak')
    assert.equal(posted.mediaType, 'audio')
    assert.ok(posted.outputUrl.startsWith(`${BACKEND}/rendered/`) && posted.outputUrl.endsWith('.mp3'), posted.outputUrl)
    assert.equal(posted.fileName, 'speech.mp3')
    const mp3 = path.join(DATA, 'rendered', path.basename(new URL(posted.outputUrl).pathname))
    const dur = ffDuration(mp3)
    assert.ok(Math.abs(dur - posted.durationSec) < 0.15, `mp3 ${dur} s vs reported ${posted.durationSec} s`)
    assert.ok(Math.abs(dur - (2 + 4.6 + 1.5)) < 0.8, `intro + speech + outro, got ${dur}`)
    // the MP3 is fetchable cross-origin, as the 3Speak page fetches it
    const r = await page.evaluate(async (u) => { const res = await fetch(u); return { ok: res.ok, type: res.headers.get('content-type'), size: (await res.arrayBuffer()).byteLength } }, posted.outputUrl)
    assert.ok(r.ok && /audio\/mpeg/.test(r.type) && r.size > 10000, JSON.stringify(r))
  })

  await step('sending keeps the draft (the upload on 3Speak can still be cancelled)', async () => {
    await sleep(3500) // past an autosave
    const kept = drafts()
    assert.equal(kept.length, 1, 'the draft is still there')
    assert.ok(clipsOf(kept[0].state).some(c => c.templateRole === 'outro'), 'with the project as it was sent')
  })
  await first.ctx.close()

  await step('a new recording gets the template by itself: silences cut, intro/outro/bed placed', async () => {
    const second = await openEditor()
    const f = second.frame
    await f.getByText(/Template applied: intro, outro, music bed/).waitFor({ timeout: 30000 })
    // the kept draft holds the free tier's one slot: the new project asks to replace it
    await f.getByText('Replace your saved draft?').waitFor({ timeout: 30000 })
    await f.locator('.drafts-item').first().click()
    const d = await until(() => drafts().find(p => clipsOf(p.state).some(c => c.templateRole === 'bed') && clipsOf(p.state).filter(c => !c.templateRole && !c.music).length === 3), 'auto-applied draft', 45000)
    const clips = clipsOf(d.state)
    assert.equal(clips.filter(c => c.templateRole === 'intro').length, 1)
    assert.equal(clips.filter(c => c.templateRole === 'outro').length, 1)
    // "Take it off" restores the plain recording in one click
    await f.getByRole('button', { name: 'Take it off' }).click()
    await until(() => drafts().find(p => !clipsOf(p.state).some(c => c.templateRole) && clipsOf(p.state).every(c => !c.templateRole)), 'template taken off')
    const after = drafts()[0]
    const content = clipsOf(after.state).sort((a, b) => a.timelinePosition - b.timelinePosition)
    assert.equal(content[0].timelinePosition, 0, 'content back at 0:00')
    await second.ctx.close()
  })

  await step('reopening offers the audio draft and restores it', async () => {
    const third = await openEditor({ file: null })
    const f = third.frame
    await f.getByText(/Continue/i).first().waitFor({ timeout: 20000 })
    await f.locator('.drafts-item').first().click()
    await until(async () => (await f.locator('.timeline-clip-v2.audio').count()) === 3, 'draft restored with 3 parts')
    await third.ctx.close()
  })

  await step('phone layout: tools collapse to icons, no horizontal overflow', async () => {
    const phone = await openEditor({ viewport: { width: 390, height: 844 } })
    const f = phone.frame
    await f.getByRole('button', { name: 'Cut silences' }).waitFor()
    assert.equal(await f.locator('.compact-tool-btn span').first().isVisible(), false, 'labels hidden on phones')
    const overflow = await f.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    assert.ok(overflow <= 1, `page overflows by ${overflow}px`)
    await phone.ctx.close()
  })
  await step('two voices grouped: silences cut only where both are quiet, the same cut on both tracks, in sync', async () => {
    // a clean start: no template (it would apply by itself), no drafts (the free limit)
    fs.rmSync(path.join(DATA, 'uploads', '.templates'), { recursive: true, force: true })
    fs.rmSync(projectsDir, { recursive: true, force: true })
    const g = await openEditor({ file: null })
    const f = g.frame
    await f.locator('.audio-stage-empty input[type=file]').setInputFiles(path.join(HOST_DIR, 'host.wav'))
    await until(async () => (await f.locator('.timeline-clip-v2.audio').count()) === 1, 'host on the Voice track')
    // a second voice track for the guest
    await f.locator('.add-menu-btn').click()
    await f.getByRole('button', { name: /Audio Track/ }).click()
    const guestTrack = f.locator('.track-label.audio').first()
    assert.equal(await guestTrack.getAttribute('aria-label'), 'Voice 2')
    await guestTrack.locator('input[type=file]').setInputFiles(path.join(HOST_DIR, 'guest.wav'))
    await until(async () => (await f.locator('.timeline-clip-v2.audio').count()) === 2, 'guest on its own track')
    // group them from the clip menu
    await f.locator('.timeline-clip-v2.audio').first().click()
    await f.getByTitle('More clip actions').click()
    await f.getByRole('button', { name: 'Group with other voices' }).click()
    await f.getByText(/2 voices grouped/).waitFor()
    // Cut silences on the group
    await f.getByRole('button', { name: 'Cut silences' }).click()
    await f.getByRole('dialog', { name: 'Cut silences: 2 voices together' }).waitFor()
    await until(async () => /cuts/.test(await f.locator('.silence-cut-summary').innerText().catch(() => '')), 'group plan')
    await f.getByRole('button', { name: 'Cut this group' }).click()
    await until(async () => (await f.locator('.timeline-clip-v2.audio').count()) >= 4, 'both voices cut')
    const d = await until(() => drafts().find(p => {
      const voices = p.state.tracks.filter(t => !t.music)
      return voices.length === 2 && voices.every(t => t.clips.length >= 2)
    }), 'draft of the cut group', 45000)
    const [guestT, hostT] = d.state.tracks.filter(t => !t.music)
    const span = (t) => t.clips.map(c => [+c.timelinePosition.toFixed(2), +(c.timelinePosition + c.endTime - c.startTime).toFixed(2)])
    // the same kept stretches on both tracks (each voice keeps its share of every stretch)
    assert.deepEqual(span(hostT), span(guestT), 'both tracks cut at the same moments')
    // host speech still lines up with the guest's: the guest's answer starts right where the host's first words end
    const hostEnd = hostT.clips.at(-1).timelinePosition + hostT.clips.at(-1).endTime - hostT.clips.at(-1).startTime
    assert.ok(hostEnd > 6.2 && hostEnd < 7.5, `kept 6 s of talk plus the air around each cut, got ${hostEnd.toFixed(2)}`)
    // where only one person talks nothing was cut: the guest's 2 s answer is whole
    const guestTalk = guestT.clips.find(c => c.startTime <= 3.05 && c.endTime >= 4.95)
    assert.ok(guestTalk, 'the guest answer (file 3-5 s) is kept in one piece')
    const hostPiece = hostT.clips.find(c => Math.abs(c.timelinePosition - guestTalk.timelinePosition) < 0.01)
    assert.ok(hostPiece && hostPiece.groupId === guestTalk.groupId, 'pieces of one stretch are grouped across the tracks')
    // and the export has both voices at the same moments
    await f.getByRole('button', { name: /^Export$/ }).click()
    await f.getByRole('button', { name: 'Use this audio' }).first().waitFor({ timeout: 90000 })
    const mp3 = path.join(DATA, 'rendered', fs.readdirSync(path.join(DATA, 'rendered')).filter(x => x.endsWith('.mp3') && !x.startsWith('cache-')).map(x => [x, fs.statSync(path.join(DATA, 'rendered', x)).mtimeMs]).sort((a, b) => b[1] - a[1])[0][0])
    assert.ok(Math.abs(ffDuration(mp3) - hostEnd) < 0.15, `mp3 ${ffDuration(mp3)} s vs timeline ${hostEnd} s`)
    // a grouped piece: Studio voice goes to its group (host AND guest piece,
    // two recordings), and to nothing else
    const pair = [hostPiece.id, guestTalk.id]
    await f.locator(`.timeline-clip-v2[data-clip-id="${hostPiece.id}"]`).click()
    assert.match(await f.locator('.noise-hint').first().innerText(), /and its group \(2 clips\)/)
    await f.getByRole('radio', { name: 'Strong' }).click()
    await until(() => drafts().find(p => {
      const voices = clipsOf(p.state).filter(c => !c.music)
      const studio = voices.filter(c => /_dn-studio\.m4a/.test(c.url)).map(c => c.id).sort()
      return studio.join() === [...pair].sort().join()
    }), 'the grouped pair cleaned, nothing else', 60000)
    await g.ctx.close()
  })

  await step('podcast tools: chapters follow the cuts into the MP3 and the post, Studio voice on one piece, music ducked, audiograms picked on the timeline, arranged, posted with the audio', async () => {
    fs.rmSync(projectsDir, { recursive: true, force: true })
    const p = await openEditor()
    const f = p.frame
    await until(async () => (await f.locator('.timeline-clip-v2.audio').count()) === 1, 'recording loaded')
    await f.locator('.track-label[aria-label="Music"] input[type=file]').setInputFiles(path.join(HOST_DIR, 'bed.wav'))
    await until(async () => (await f.locator('.timeline-clip-v2.audio').count()) === 2, 'music on the Music track')
    // Duck on the music clip itself: -12 dB, listening to track 1 (Voice) by default;
    // the list names the other tracks by number, never the clip's own track
    await f.locator('.timeline-track-v2.audio').nth(1).locator('.timeline-clip-v2').first().click()
    await f.getByRole('radiogroup', { name: 'Duck this clip' }).getByRole('radio', { name: '-12 dB' }).click()
    const sourceOptions = await f.getByLabel('Duck source').locator('option').allInnerTexts()
    assert.deepEqual(sourceOptions, ['1 · Voice', 'All voice tracks'])
    // Cut silences works on the selected clip: back to the recording
    await f.locator('.timeline-track-v2.audio').first().locator('.timeline-clip-v2').first().click()
    // Chapters: M at 0:00 ("Intro"), then at 3 s (inside the second phrase), renamed
    await f.locator('.audio-stage-overview').focus()
    await f.locator('body').press('m')
    const dialog = f.getByRole('dialog', { name: 'Chapters' })
    await dialog.waitFor()
    assert.equal(await dialog.getByLabel('Chapter 1 name').inputValue(), 'Intro')
    await dialog.getByTitle('Close').click()
    for (let i = 0; i < 3; i++) await f.locator('body').press('Shift+ArrowRight')
    await f.locator('body').press('m')
    await dialog.getByLabel('Chapter 2 name').fill('Second part')
    await dialog.getByTitle('Close').click()
    assert.equal(await f.locator('.ruler-chapter').count(), 2, 'two flags on the ruler')
    // Cut the silences: the second chapter moves with its phrase (3 s in the file -> about 1.9 s)
    await f.getByRole('button', { name: /Cut silences/ }).click()
    await f.getByRole('dialog', { name: 'Cut silences' }).waitFor()
    await until(async () => /cuts/.test(await f.locator('.silence-cut-summary').innerText().catch(() => '')), 'cut plan summary')
    await f.getByRole('button', { name: /Edit for me|This clip only/ }).click()
    await until(async () => (await f.locator('.timeline-clip-v2.audio').count()) === 4, 'three speech parts + music')
    // Studio voice on one piece cleans that piece only (clip level; a group would go along)
    const firstPiece = await f.locator('.timeline-clip-v2.audio').first().getAttribute('data-clip-id')
    await f.locator('.timeline-clip-v2.audio').first().click()
    assert.match(await f.locator('.noise-hint').first().innerText(), /this clip only/)
    await f.getByRole('radio', { name: 'Strong' }).click()
    const d = await until(() => drafts().find(x => {
      const voice = clipsOf(x.state).filter(c => !c.music)
      return voice.length === 3 && voice.filter(c => /_dn-studio\.m4a/.test(c.url)).map(c => c.id).join() === firstPiece
    }), 'only that piece on the studio copy', 45000)
    assert.equal(d.state.master.duck, false, 'no whole-show duck')
    assert.equal(d.state.chapters.length, 2)
    assert.equal(d.state.chapters[1].title, 'Second part')
    assert.ok(d.state.chapters[1].anchor && Math.abs(d.state.chapters[1].anchor.t - 3) < 0.01, 'pinned to 3 s of the recording')
    // the music clip keeps its own -12 dB (Voice track), then -18 dB
    const musicTrack = d.state.tracks.find(t => t.music)
    const voiceTrack = d.state.tracks.find(t => !t.music)
    const bedId = musicTrack.clips[0].id
    await f.locator(`.timeline-clip-v2[data-clip-id="${bedId}"]`).click()
    const duckGroup = f.getByRole('radiogroup', { name: 'Duck this clip' })
    assert.equal(await duckGroup.getByRole('radio', { name: '-12 dB' }).getAttribute('aria-checked'), 'true')
    assert.equal(musicTrack.clips[0].duck.source, voiceTrack.id, 'listens to the Voice track')
    await duckGroup.getByRole('radio', { name: '-18 dB' }).click()
    await f.getByLabel('Duck source').selectOption(voiceTrack.id)
    await until(() => drafts().find(x => {
      const bed = x.state.tracks.find(t => t.music)?.clips.find(c => c.id === bedId)
      return bed?.duck?.db === -18 && bed.duck.source === voiceTrack.id
    }), 'the clip keeps its own duck')
    // Export: each ducked clip brings its own ramps (clip seconds), plus the chapters
    const renderReq = p.page.waitForRequest(r => r.method() === 'POST' && /\/api\/render$/.test(new URL(r.url()).pathname))
    await f.getByRole('button', { name: /^Export$/ }).click()
    const { timeline } = (await renderReq).postDataJSON()
    const bedOut = timeline.tracks.flatMap(t => t.clips).find(c => c.id === bedId)
    assert.equal(bedOut.duckPlan.gain, 0.1259)
    assert.ok(bedOut.duckPlan.spans.length >= 1)
    assert.equal(timeline.master.duck, undefined, 'no whole-show duck any more')
    assert.equal(timeline.chapters[0].title, 'Intro')
    assert.equal(timeline.chapters[0].start, 0)
    const second = timeline.chapters[1]
    assert.ok(second.start > 1.5 && second.start < 2.3, `second chapter moved with the cut, at ${second.start}`)
    await f.getByRole('button', { name: 'Use this audio' }).first().waitFor({ timeout: 90000 })
    // Audiograms: "Use this audio" with none yet asks first; "Make audiograms" opens them
    await f.getByRole('button', { name: 'Use this audio' }).first().click()
    await f.locator('.video-preview-send').click()
    await f.getByText('Make audiograms for Shorts?').waitFor()
    await f.getByRole('button', { name: 'Make audiograms' }).click()
    let ag = f.getByRole('dialog', { name: 'Audiograms' })
    // first the piece: nothing else shows until it is picked (and no tour yet)
    await ag.getByTestId('audiogram-start').waitFor({ timeout: 20000 })
    assert.equal(await ag.locator('.audiogram-box').count(), 0, 'no studio before the piece')
    assert.equal(await ag.getByLabel('Title on the video').count(), 0)
    const tip = f.locator('.tour-tooltip')
    assert.equal(await tip.count(), 0, 'the studio tour waits for the studio')
    await ag.getByRole('button', { name: 'Choose on the timeline' }).click()
    await f.locator('.range-pick-bar').waitFor()
    // the first time: a short tour of picking (its buttons work although the editor is locked)
    await tip.waitFor({ timeout: 10000 })
    assert.equal(await tip.locator('.tour-tooltip-title').innerText(), 'Click the start, then the end')
    await tip.locator('.tour-next-btn').click()
    assert.equal(await tip.locator('.tour-tooltip-title').innerText(), 'Move around')
    await tip.getByRole('button', { name: 'Skip' }).click()
    await tip.waitFor({ state: 'detached' })
    assert.ok(await f.locator('.range-pick-bar').isVisible(), 'the tour leaves the picking on')
    // a crosshair over all of the timeline, clips too
    assert.equal(await f.locator('.timeline-clip-v2').first().evaluate(el => getComputedStyle(el).cursor), 'crosshair')
    // the rest of the editor is locked while picking: no clicks, no shortcuts
    const clipsBefore = await f.locator('.timeline-clip-v2').count()
    assert.equal(await f.locator('.compact-menu-bar button').first().evaluate(el => getComputedStyle(el).pointerEvents), 'none', 'the menu bar is locked')
    await p.page.keyboard.press('Delete')
    await p.page.keyboard.press('Control+z')
    assert.equal(await f.locator('.timeline-clip-v2').count(), clipsBefore, 'shortcuts do nothing while picking')
    assert.ok(await f.locator('.range-pick-bar').isVisible(), 'still picking')
    // a drag over a clip draws a piece, it does not move the clip
    const clipBox = await f.locator('.timeline-clip-v2').first().boundingBox()
    const clipLeft = clipBox.x
    await p.page.mouse.move(clipBox.x + clipBox.width / 2, clipBox.y + clipBox.height / 2)
    await p.page.mouse.down()
    await p.page.mouse.move(clipBox.x + clipBox.width / 2 + 60, clipBox.y + clipBox.height / 2, { steps: 5 })
    await p.page.mouse.up()
    assert.equal((await f.locator('.timeline-clip-v2').first().boundingBox()).x, clipLeft, 'the clip stayed where it was')
    // Play the piece: plays only the picked part, stops at its end and goes back to its start
    {
      // a click marks the start (the old end goes), the next click the end
      const r0 = await f.locator('.timeline-ruler').boundingBox()
      await p.page.mouse.click(r0.x + 3, r0.y + r0.height / 2)
      await f.getByTestId('timeline-range-start').waitFor()
      assert.equal(await f.getByTestId('timeline-range').count(), 0, 'only the start is marked')
      assert.match(await f.getByTestId('range-pick-value').innerText(), /now click where it ends/)
      assert.ok(await f.getByRole('button', { name: 'Use this piece' }).isDisabled(), 'no piece yet')
      const seen = Math.min(r0.width, (await f.locator('.timeline-content').boundingBox()).width) // the ruler runs on past the view
      await p.page.mouse.click(r0.x + seen * 0.45, r0.y + r0.height / 2)
      await f.getByTestId('timeline-range').waitFor()
      // pull the end edge back a little
      const full = await f.getByTestId('timeline-range').boundingBox()
      const edge = await f.locator('[data-range-edge="end"]').boundingBox()
      await p.page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2)
      await p.page.mouse.down()
      await p.page.mouse.move(edge.x + edge.width / 2 - 40, edge.y + edge.height / 2, { steps: 5 })
      await p.page.mouse.up()
      const band = await f.getByTestId('timeline-range').boundingBox()
      assert.ok(Math.abs(band.width - (full.width - 40)) <= 5, `the end moved back (${full.width} -> ${band.width})`)
      assert.equal(band.x, full.x, 'the start stayed')
      const playBtn = f.getByRole('button', { name: 'Play the piece' })
      await playBtn.click()
      await f.getByRole('button', { name: 'Stop' }).waitFor()
      let maxX = 0
      let moved = false
      const started = Date.now()
      while (Date.now() - started < 30000 && await f.getByRole('button', { name: 'Stop' }).count()) {
        const ph = await f.locator('.timeline-playhead').boundingBox()
        if (ph) { maxX = Math.max(maxX, ph.x); if (ph.x > band.x + 4) moved = true }
        await sleep(40)
      }
      assert.ok(moved, 'the playhead ran through the piece')
      assert.ok(maxX <= band.x + band.width + 6, `the playhead stayed in the piece (${maxX} > ${band.x + band.width})`)
      await playBtn.waitFor()
      let back = null
      for (let i = 0; i < 40; i++) {
        back = await f.locator('.timeline-playhead').boundingBox()
        if (Math.abs(back.x - band.x) <= 4) break
        await sleep(50)
      }
      assert.ok(Math.abs(back.x - band.x) <= 4, `back at the start of the piece (${back.x} vs ${band.x})`)
      // Space plays it too, and stops it (also with the Play button focused)
      await playBtn.focus()
      await p.page.keyboard.press('Space')
      await f.getByRole('button', { name: 'Stop' }).waitFor()
      await p.page.keyboard.press('Space')
      await playBtn.waitFor()
      assert.ok(await f.locator('.range-pick-bar').isVisible(), 'still picking')
      // the timeline still moves: Shift+wheel zooms, dragging the ruler scrolls; the piece stays
      const content = f.locator('.timeline-content')
      const cBox = await content.boundingBox()
      const value = await f.getByTestId('range-pick-value').innerText()
      const w0 = band.width
      await p.page.mouse.move(cBox.x + 200, cBox.y + 60)
      await p.page.keyboard.down('Shift')
      await p.page.mouse.wheel(0, -300)
      await p.page.keyboard.up('Shift')
      await until(async () => (await f.getByTestId('timeline-range').boundingBox()).width > w0 * 1.2, 'Shift+wheel zoomed in while picking', 3000)
      await content.evaluate(el => { el.scrollLeft = 0 })
      const rz = await f.locator('.timeline-ruler').boundingBox()
      await p.page.mouse.move(cBox.x + 400, rz.y + rz.height / 2)
      await p.page.mouse.down()
      await p.page.mouse.move(cBox.x + 150, rz.y + rz.height / 2, { steps: 6 })
      await p.page.mouse.up()
      assert.ok(await content.evaluate(el => el.scrollLeft) > 150, 'dragging the ruler scrolled the timeline')
      assert.equal(await f.getByTestId('range-pick-value').innerText(), value, 'scrolling left the piece as it was')
      await f.getByRole('button', { name: 'Fit' }).click()
      await content.evaluate(el => { el.scrollLeft = 0 })
      await sleep(300)
    }
    // Cancel and Use this piece: text buttons of the same height, the words inside them
    const cancelBtn = f.locator('.range-pick-bar').getByRole('button', { name: 'Cancel' })
    const cb = await cancelBtn.boundingBox()
    const ub = await f.getByRole('button', { name: 'Use this piece' }).boundingBox()
    assert.ok(Math.abs(cb.height - ub.height) <= 1, `Cancel ${cb.height}px high, Use this piece ${ub.height}px`)
    assert.ok(await cancelBtn.evaluate(el => el.scrollWidth <= el.clientWidth), 'the word Cancel fits its button')
    const ruler = await f.locator('.timeline-ruler').boundingBox()
    const lastClip = await f.locator('.timeline-clip-v2').last().boundingBox()
    await p.page.mouse.click(ruler.x + 3, ruler.y + ruler.height / 2)
    await p.page.mouse.click(Math.min(lastClip.x + lastClip.width, ruler.x + (await f.locator('.timeline-content').boundingBox()).width) - 4, ruler.y + ruler.height / 2)
    await f.getByTestId('timeline-range').waitFor()
    const picked = await f.getByTestId('range-pick-value').innerText()
    await f.getByRole('button', { name: 'Use this piece' }).click()
    assert.equal(await f.locator('.app.picking-range').count(), 0, 'the editor is unlocked again')
    ag = f.getByRole('dialog', { name: 'Audiograms' })
    // now the studio, and the first time its tour
    await ag.locator('.audiogram-box[data-layer="title"]').waitFor({ timeout: 20000 })
    await tip.waitFor({ timeout: 10000 })
    const tourTitles = []
    for (let i = 0; i < 12 && await tip.count(); i++) {
      tourTitles.push(await tip.locator('.tour-tooltip-title').innerText())
      await tip.locator('.tour-next-btn').click()
    }
    assert.deepEqual(tourTitles, ['Audiograms', 'Your piece', 'Arrange it your way', 'A picture', 'The waveform', 'Parts', 'Make it'])
    assert.ok(await ag.isVisible(), 'the tour does not close the studio')
    assert.equal(await ag.getByLabel('Title on the video').inputValue(), 'speech')
    assert.equal(await ag.getByRole('radiogroup', { name: 'Picture layout' }).count(), 0, 'no picture layouts: the card')
    assert.equal(await ag.getByRole('button', { name: 'Save and close' }).count(), 0, 'nothing to save before the first audiogram')
    // the preview draws the look (the backend's page, in its own frame)
    const preview = () => f.frameLocator('iframe[title="Audiogram preview"]')
    await until(async () => (await preview().locator('#l-title').count()) === 1, 'the preview draws the title', 15000)
    assert.equal((await ag.getByTestId('audiogram-piece').innerText()).replace(/\s+/g, ' '), picked.replace(/\s+/g, ' '), 'the dialog uses the picked piece')
    const pieceSeconds = +/(\d+)s$/.exec(picked)[1]
    assert.ok(pieceSeconds >= 3, picked)
    // drag the title 60 preview px down
    const tb = await ag.locator('.audiogram-box[data-layer="title"]').boundingBox()
    await p.page.mouse.move(tb.x + tb.width / 2 + 30, tb.y + 10)
    await p.page.mouse.down()
    await p.page.mouse.move(tb.x + tb.width / 2 + 30, tb.y + 70, { steps: 6 })
    await p.page.mouse.up()
    // turn it about 10 degrees to the left with its handle (under the box): a press alone does not turn it
    const knob = await ag.locator('.audiogram-rotate').boundingBox()
    const moved = await ag.locator('.audiogram-box[data-layer="title"]').boundingBox()
    const mid = { x: moved.x + moved.width / 2, y: moved.y + moved.height / 2 }
    await p.page.mouse.move(knob.x + knob.width / 2, knob.y + knob.height / 2)
    await p.page.mouse.down()
    await p.page.mouse.up()
    assert.equal(await ag.locator('.audiogram-box-name').innerText(), 'Title', 'pressing the handle does not flip it')
    await p.page.mouse.move(knob.x + knob.width / 2, knob.y + knob.height / 2)
    await p.page.mouse.down()
    await p.page.mouse.move(mid.x + 200 * Math.cos(80 * Math.PI / 180), mid.y + 200 * Math.sin(80 * Math.PI / 180), { steps: 10 })
    await p.page.mouse.up()
    await ag.getByText('Title · -10°').waitFor()
    // the branding: the 3S only, in its own shape, never under its minimum size
    const PX = 520 / 1920
    await ag.getByRole('radio', { name: '3S logo' }).click()
    const logo = ag.locator('.audiogram-box[data-layer="logo"]')
    await until(async () => { const b = await logo.boundingBox(); return Math.abs(b.width / b.height - 1.15) < 0.06 }, 'the 3S logo box')
    await logo.click()
    const lb = await logo.boundingBox()
    const corner = await logo.locator('[data-corner="se"]').boundingBox()
    await p.page.mouse.move(corner.x + 3, corner.y + 3)
    await p.page.mouse.down()
    await p.page.mouse.move(lb.x - 200, lb.y - 200, { steps: 6 })
    await p.page.mouse.up()
    const small = await logo.boundingBox()
    assert.ok(small.height >= 120 * PX - 1, `the logo stays at least 120 px high (${small.height / PX})`)
    // and it grows with its box: pulled big, the drawn logo fills it
    const c2 = await logo.locator('[data-corner="se"]').boundingBox()
    await p.page.mouse.move(c2.x + 3, c2.y + 3)
    await p.page.mouse.down()
    await p.page.mouse.move(c2.x + 120, c2.y + 120, { steps: 6 })
    await p.page.mouse.up()
    const big = await logo.boundingBox()
    assert.ok(big.height > 300 * PX, `the logo box grew (${big.height / PX})`)
    await until(async () => {
      const m = await f.frameLocator('iframe[title="Audiogram preview"]').locator('#l-logo').evaluate(el => ({ box: el.clientHeight, drawn: el.firstElementChild.offsetHeight }))
      return m.drawn >= m.box * 0.85
    }, 'the drawn logo as big as its box', 10000)
    // the logo can not be hidden
    assert.equal(await ag.getByRole('button', { name: 'Hide 3Speak logo' }).count(), 0)
    assert.equal(await ag.getByRole('radio', { name: 'Square' }).count(), 0, 'no square: Shorts are vertical')
    await ag.getByRole('radio', { name: 'Circle wave' }).click()
    await ag.getByRole('button', { name: 'Make audiogram' }).click()
    await ag.getByTestId('audiogram-item').first().waitFor({ timeout: 120000 })
    const agUrl = await ag.locator('[data-testid="audiogram-item"] video').first().getAttribute('src')
    assert.ok(agUrl.startsWith(`${BACKEND}/rendered/audiogram-`), agUrl)
    const agFile = path.join(DATA, 'rendered', path.basename(new URL(agUrl).pathname))
    const agProbe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height:format=duration', '-of', 'json', agFile], { encoding: 'utf8' }))
    const vs = agProbe.streams.find(x => x.codec_name === 'h264')
    assert.deepEqual([vs.width, vs.height], [1080, 1920])
    assert.ok(agProbe.streams.some(x => x.codec_name === 'aac'))
    assert.ok(Math.abs(+agProbe.format.duration - pieceSeconds) < 1.2, `audiogram ${agProbe.format.duration}s, piece ${pieceSeconds}s`)
    // the look is the template now: kept on the server, the moved title in it
    const agTemplate = path.join(DATA, 'uploads', '.templates', USER, 'audiogram.json')
    const tpl = JSON.parse(await until(() => (fs.existsSync(agTemplate) ? fs.readFileSync(agTemplate, 'utf8') : null), 'audiogram template saved'))
    assert.equal(tpl.wave.type, 'ring')
    assert.equal(tpl.layouts.vertical.wave.w, tpl.layouts.vertical.wave.h, 'a round waveform has a square box')
    assert.equal(tpl.layouts.vertical.title.r, -10)
    assert.equal(tpl.logo, 'mark')
    assert.ok(tpl.layouts.vertical.logo.h >= 120, `logo ${JSON.stringify(tpl.layouts.vertical.logo)}`)
    assert.ok(tpl.layouts.vertical.title.y > 520 + 150 - 60, `title moved down in the template (y ${tpl.layouts.vertical.title.y})`)
    // every audiogram goes out with the audio: no toggle, a hint, its title as its name
    assert.equal(await ag.getByRole('button', { name: 'Post together with the audio' }).count(), 0)
    await ag.getByText(/They go out as 3Speak Shorts together with the audio/).waitFor()
    assert.equal(await ag.locator('.audiogram-made-title').first().innerText(), 'speech')
    // its text: typed here when 3Speak's editor does not answer (an older 3Speak) ...
    await ag.getByRole('button', { name: 'Text for Short 1' }).click()
    const typed = ag.getByRole('textbox', { name: 'Text for Short 1' })
    await typed.waitFor({ timeout: 5000 })
    await typed.fill('A teaser of the new episode')
    await typed.blur()
    // ... and written in 3Speak's own editor when it does
    await p.page.evaluate(() => { window.__textEditor = 'Written in the **3Speak** editor' })
    await ag.getByRole('button', { name: 'Text for Short 1' }).click()
    await until(async () => (await ag.getByTestId('audiogram-text').first().innerText()).includes('Written in the **3Speak** editor'), 'the text from 3Speak\'s editor')
    const asked = await p.page.evaluate(() => window.__messages.filter(m => m.type === 'edit-text').at(-1))
    assert.equal(asked.value, 'A teaser of the new episode', '3Speak\'s editor starts from the text there was')
    // with an audiogram there: Save and close at the top (the audiograms stay with the audio)
    await ag.getByRole('button', { name: 'Save and close' }).click()
    await ag.waitFor({ state: 'detached' })
    // opened again: the template is the starting point, the audiogram is still there
    await f.getByRole('button', { name: 'Audiograms (1)' }).click()
    ag = f.getByRole('dialog', { name: 'Audiograms' })
    await ag.getByText('Your last audiogram is the starting point').waitFor({ timeout: 15000 })
    assert.equal(await f.locator('.tour-tooltip').count(), 0, 'the tour shows only the first time')
    assert.equal(await ag.getByRole('radio', { name: 'Circle wave' }).getAttribute('aria-checked'), 'true')
    assert.match(await ag.getByTestId('audiogram-text').first().innerText(), /Written in the \*\*3Speak\*\* editor/)
    // change the piece: the studio comes back with a new preview frame, and it draws too
    await ag.getByRole('button', { name: 'Change the piece' }).click()
    await f.locator('.range-pick-bar').waitFor()
    await f.locator('.timeline-content').evaluate(el => { el.scrollLeft = 0 }) // it followed the playhead
    const rp = await f.locator('.timeline-ruler').boundingBox()
    // (a little in from 0:00: the old piece's start grip is there)
    await p.page.mouse.click(rp.x + 12, rp.y + rp.height / 2)
    await p.page.mouse.click(rp.x + Math.min(rp.width, (await f.locator('.timeline-content').boundingBox()).width) * 0.6, rp.y + rp.height / 2)
    await f.getByRole('button', { name: 'Use this piece' }).click()
    await ag.locator('.audiogram-box[data-layer="title"]').waitFor({ timeout: 20000 })
    await until(async () => (await preview().locator('#l-title').count()) === 1, 'the new preview frame draws the title too', 15000)
    // a look not in an audiogram yet: closing asks first (outside the dialog, and X)
    await ag.getByLabel('Line on the video').fill('A changed line')
    await p.page.mouse.click(5, 400)
    const confirm = f.locator('.audiogram-confirm')
    await confirm.getByText('Close without making it?').waitFor()
    await confirm.getByRole('button', { name: 'Keep editing' }).click()
    assert.ok(await ag.isVisible(), 'still open')
    assert.equal(await ag.getByLabel('Line on the video').inputValue(), 'A changed line')
    await ag.getByTitle('Close').click()
    await confirm.getByRole('button', { name: 'Close' }).click()
    await ag.waitFor({ state: 'detached' })
    // phones: the finished export's buttons still fit
    await p.page.setViewportSize({ width: 390, height: 844 })
    await sleep(300)
    const overflow = await f.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    assert.ok(overflow <= 1, `page overflows by ${overflow}px after export`)
    await p.page.setViewportSize({ width: 1280, height: 860 })
    await f.getByRole('button', { name: 'Use this audio' }).first().click()
    await f.locator('.video-preview-send').click()
    const post = await until(() => p.page.evaluate(() => window.__messages.find(m => m.type === 'post-to-3speak')), 'post-to-3speak')
    assert.deepEqual(post.chapters.map(c => c.title), ['Intro', 'Second part'])
    assert.equal(post.audiograms.length, 1)
    assert.equal(post.audiograms[0].url, agUrl)
    assert.equal(post.audiograms[0].description, 'Written in the **3Speak** editor')
    assert.deepEqual([post.audiograms[0].width, post.audiograms[0].height], [1080, 1920])
    assert.ok(Math.abs(post.chapters.at(-1).end - post.durationSec) < 0.01, 'the last chapter runs to the end')
    // ID3 chapters in the MP3 itself
    const mp3 = path.join(DATA, 'rendered', path.basename(new URL(post.outputUrl).pathname))
    const { chapters } = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_chapters', '-of', 'json', mp3], { encoding: 'utf8' }))
    assert.deepEqual(chapters.map(c => c.tags.title), ['Intro', 'Second part'])
    assert.ok(Math.abs(+chapters[1].start_time - second.start) < 0.01)
    // sent: the draft is still there (the upload may still be cancelled on 3Speak)
    await sleep(3500)
    assert.ok(drafts().length >= 1, 'the draft is kept after Use this audio')
    await p.ctx.close()
  })

  await step('recording a voice: live graph, full length in the preview, Use puts it on the Voice track with its length', async () => {
    // no template: the take sits at 0 on its own; no drafts: sending keeps the
    // last step's draft, which would be offered first
    fs.rmSync(templateFile, { force: true })
    if (fs.existsSync(projectsDir)) for (const file of fs.readdirSync(projectsDir)) fs.rmSync(path.join(projectsDir, file), { force: true })
    const r = await openEditor({ file: null })
    const f = r.frame
    await f.locator('.empty-timeline-actions').getByRole('button', { name: 'Record', exact: true }).click()
    await f.locator('.record-start-btn').waitFor({ timeout: 15000 })
    // bars away from the centre line = the graph moves with the (fake) mic
    const inked = () => f.evaluate(() => {
      const c = document.querySelector('.record-voice-graph')
      const g = c.getContext('2d').getImageData(0, 0, c.width, Math.floor(c.height / 3)).data
      let n = 0
      for (let i = 3; i < g.length; i += 4) if (g[i] > 0) n++
      return n
    })
    await until(async () => (await inked()) > 0, 'live voice graph before recording', 10000)
    await f.locator('.record-start-btn').click()
    await new Promise(res => setTimeout(res, 8000))
    await f.locator('.record-stop-btn').click()
    const audio = f.locator('.record-audio-indicator audio:not(.record-audio-loading)')
    await audio.waitFor({ timeout: 15000 })
    const shown = await audio.evaluate(el => el.duration)
    assert.ok(Number.isFinite(shown) && shown > 7.3 && shown < 9.5, `preview length ${shown}`)
    assert.ok((await inked()) > 0, 'the take\'s shape is drawn')
    await f.locator('.record-use-btn').click()
    const d = await until(() => drafts().find(p => clipsOf(p.state).some(c => /^Recording_/.test(c.name || '') && /\/api\/upload\/files\//.test(c.url))), 'draft with the uploaded recording', 45000)
    const rec = clipsOf(d.state).find(c => /^Recording_/.test(c.name))
    assert.equal(rec.track, clipsOf(d.state).find(c => !c.music && !c.templateRole)?.track, 'on the voice track')
    assert.ok(Number.isFinite(rec.duration) && rec.duration > 7.3 && rec.duration < 9.5, `clip length ${rec.duration}`)
    assert.ok(Math.abs((rec.endTime - rec.startTime) - rec.duration) < 0.05, `whole take on the timeline: ${rec.startTime}-${rec.endTime}`)

    // play, pause, back to 0, play again: the take must play from its start
    const audioState = () => f.evaluate(() => [...document.querySelectorAll('.global-preview audio')].map(a => ({ src: a.src.slice(-40), paused: a.paused, t: +a.currentTime.toFixed(2), d: a.duration, seekable: a.seekable.length ? [a.seekable.start(0), a.seekable.end(0)] : [], ready: a.readyState })))
    const ruler = f.locator('.timeline-ruler')
    const toStart = async () => { const b = await ruler.boundingBox(); await r.page.mouse.click(b.x + 1, b.y + b.height / 2) }
    const playBtn = f.locator('.global-preview button[title="Play"], .global-preview button[title="Pause"]').first()
    const toggle = async () => { if (await playBtn.count()) await playBtn.click(); else await r.page.keyboard.press(' ') }
    await toggle()
    await new Promise(res => setTimeout(res, 3000))
    const first = await audioState()
    // the length is in the file now (header fixed after recording): seekable to its end
    assert.equal(first.length, 1, JSON.stringify(first))
    assert.ok(Number.isFinite(first[0].d) && first[0].d > 7.3, `timeline audio knows its length: ${JSON.stringify(first)}`)
    assert.ok(!first[0].paused && first[0].t > 2, `plays: ${JSON.stringify(first)}`)
    await toggle()
    await toStart()
    assert.equal(await f.locator('[aria-label="Position in the show"]').getAttribute('aria-valuenow'), '0')
    await toggle()
    await new Promise(res => setTimeout(res, 1000))
    const again = await audioState()
    assert.ok(!again[0].paused && again[0].t > 0.5 && again[0].t < 2, `plays again from the start: ${JSON.stringify(again)}`)
    await r.ctx.close()
  })

  await step('teleprompter in the voice recorder: script, 3-2-1, the script shows while recording, the take keeps its sound', async () => {
    if (fs.existsSync(projectsDir)) for (const file of fs.readdirSync(projectsDir)) fs.rmSync(path.join(projectsDir, file), { force: true })
    const r = await openEditor({ file: null })
    const f = r.frame
    await f.locator('.empty-timeline-actions').getByRole('button', { name: 'Record', exact: true }).click()
    await f.locator('.record-start-btn').waitFor({ timeout: 15000 })
    await f.locator('.record-tp-btn').click()
    await f.locator('.tp-script-full').fill('Hello and welcome to the show. Today we talk about recording podcasts in the browser.')
    await f.getByRole('button', { name: 'Use this script' }).click()
    await f.locator('.record-tp-btn.active').waitFor({ timeout: 5000 })
    // clicks on the teleprompter must not close the recorder (its backdrop does)
    await f.locator('.tp-box').click()
    assert.equal(await f.locator('.record-audio-modal').count(), 1, 'recorder still open')
    await f.locator('.record-start-btn').click()
    await f.locator('.record-countdown').waitFor({ timeout: 3000 })
    await f.locator('.record-stop-btn').waitFor({ timeout: 10000 })
    assert.ok(await f.locator('.tp-box .tp-word').count() > 10, 'the script is on screen while recording')
    await new Promise(res => setTimeout(res, 4000))
    await f.locator('.record-stop-btn').click()
    const audio = f.locator('.record-audio-indicator audio:not(.record-audio-loading)')
    await audio.waitFor({ timeout: 15000 })
    const shown = await audio.evaluate(el => el.duration)
    assert.ok(Number.isFinite(shown) && shown > 3.3 && shown < 5.5, `take length ${shown}`)
    // the take has sound: the (fake) mic was still recorded with the teleprompter on
    const loud = await audio.evaluate(async (el) => {
      const buf = await (await fetch(el.src)).arrayBuffer()
      const ctx = new OfflineAudioContext(1, 1, 16000)
      const dec = await ctx.decodeAudioData(buf)
      const d = dec.getChannelData(0)
      let peak = 0
      for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]))
      return peak
    })
    assert.ok(loud > 0.01, `the take is not silent (peak ${loud})`)
    // the script hides with the take done
    assert.equal(await f.locator('.tp-box').count(), 0, 'no script over the finished take')
    await r.ctx.close()
  })

  await step('Cut silences works clip by clip on any track: a voice on the Music track is cut on its own; the last Voice track stays', async () => {
    if (fs.existsSync(projectsDir)) for (const file of fs.readdirSync(projectsDir)) fs.rmSync(path.join(projectsDir, file), { force: true })
    const r = await openEditor({ file: null })
    const f = r.frame
    // the last voice track can't be removed (no bin on it), Music still can be added to
    const labels = f.locator('.track-label.audio')
    assert.equal(await labels.count(), 2)
    assert.equal(await labels.first().locator('.track-delete-btn').count(), 0, 'no delete on the only voice track')
    // a voice recording put on the Music track (its + / Add Audio File)
    await labels.nth(1).locator('input[type=file]').setInputFiles(path.join(HOST_DIR, 'speech.wav'))
    const musicRow = f.locator('.timeline-track-v2.audio').nth(1)
    await musicRow.locator('.timeline-clip-v2').first().waitFor({ timeout: 15000 })
    const id = await musicRow.locator('.timeline-clip-v2').first().getAttribute('data-clip-id')
    await until(() => drafts().find(p => clipsOf(p.state).some(c => c.id === id && /\/api\/upload\/files\//.test((c.url || '') + (c.serverUrl || '')))), 'uploaded', 45000)
    // the clip's waveform spans the whole clip (bar i = i-th slice of its time),
    // so it lines up with the stage and the playhead
    const span = await musicRow.locator('.waveform-visual').first().evaluate(el => {
      const box = el.getBoundingClientRect()
      const bars = el.querySelectorAll('.wave-bar')
      return { left: bars[0].getBoundingClientRect().left - box.left, right: box.right - bars[bars.length - 1].getBoundingClientRect().right }
    })
    assert.ok(span.left < 4 && span.right < 4, `waveform fills the clip: ${JSON.stringify(span)}`)
    await musicRow.locator('.timeline-clip-v2').first().click()
    const cut = f.getByRole('button', { name: /Cut silences/ })
    assert.equal(await cut.isEnabled(), true, 'Cut silences works without a voice clip')
    await cut.click()
    await f.getByRole('dialog', { name: 'Cut silences' }).waitFor()
    await until(async () => /cuts/.test(await f.locator('.silence-cut-summary').innerText().catch(() => '')), 'cut plan summary')
    await f.getByRole('button', { name: /Edit for me|This clip only/ }).click()
    await until(async () => (await musicRow.locator('.timeline-clip-v2').count()) === 3, 'three parts on the Music track')
    await r.ctx.close()
  })

  await step('select many: a box over the cut pieces, then louder (150%) and Studio voice for all of them, boosted in the preview', async () => {
    // a free draft slot (the recording step's draft takes the last one)
    if (fs.existsSync(projectsDir)) for (const file of fs.readdirSync(projectsDir)) fs.rmSync(path.join(projectsDir, file), { force: true })
    const m = await openEditor()
    const f = m.frame
    await f.locator('.timeline-clip-v2.audio').first().waitFor({ timeout: 15000 })
    const firstId = await f.locator('.timeline-clip-v2.audio').first().getAttribute('data-clip-id')
    await until(() => drafts().find(p => clipsOf(p.state).some(c => c.id === firstId && /\/api\/upload\/files\//.test((c.url || '') + (c.serverUrl || '')))), 'recording uploaded', 45000)
    await f.getByRole('button', { name: /Cut silences/ }).click()
    await f.getByRole('dialog', { name: 'Cut silences' }).waitFor()
    await until(async () => /cuts/.test(await f.locator('.silence-cut-summary').innerText().catch(() => '')), 'cut plan summary')
    await f.getByRole('button', { name: /Edit for me|This clip only/ }).click()
    await until(async () => (await f.locator('.timeline-clip-v2.audio').count()) === 3, 'three speech parts')
    const ids = await f.locator('.timeline-clip-v2.audio').evaluateAll(els => els.map(e => e.dataset.clipId))
    const mine = () => drafts().find(p => ids.every(id => clipsOf(p.state).some(c => c.id === id)))

    // drag from the empty music track (right) up over the voice pieces (left)
    const [voiceRow, musicRow] = await f.locator('.timeline-track-v2.audio').all()
    const content = await f.locator('.timeline-content').boundingBox()
    const mb = await musicRow.boundingBox()
    const vb = await voiceRow.boundingBox()
    await m.page.mouse.move(Math.min(mb.x + mb.width, content.x + content.width) - 6, mb.y + mb.height / 2)
    await m.page.mouse.down()
    await m.page.mouse.move(vb.x + 2, vb.y + 2, { steps: 8 })
    assert.equal(await f.locator('.timeline-marquee').count(), 1, 'the box shows while dragging')
    await m.page.mouse.up()
    assert.equal(await f.locator('.timeline-clip-v2.selected').count(), 3)
    assert.equal(await f.locator('.multi-clip-panel .compact-properties-title').innerText(), '3 clips selected')

    await f.locator('[aria-label="Volume of all selected clips"]').fill('150')
    await until(() => { const d = mine(); return d && clipsOf(d.state).filter(c => ids.includes(c.id)).every(c => c.volume === 150) }, 'all three at 150%')

    // the preview plays them louder than an <audio> element can: through a gain node
    await f.locator('.global-preview button[title="Play"]').first().click()
    await new Promise(res => setTimeout(res, 1200))
    const el = await f.evaluate(() => { const a = document.querySelector('.global-preview audio'); return a && { boost: a.dataset.boost, cors: a.crossOrigin, paused: a.paused, t: a.currentTime, error: a.error && a.error.code } })
    assert.ok(el && el.boost === '1' && el.cors === 'anonymous' && !el.paused && el.t > 0.3 && !el.error, `boosted playback: ${JSON.stringify(el)}`)
    await f.locator('.global-preview button[title="Pause"]').first().click()

    // (after the playback check: the cleaned copy is AAC, which this test Chromium can't decode)
    // while it runs: a spinner in the panel and the editor's notice (recorded as they
    // appear: a clean-up the backend already has cached is over in a moment)
    await f.evaluate(() => {
      window.__seen = []
      new MutationObserver(() => {
        for (const sel of ['.cleaning-notice', '.multi-clip-panel .noise-busy']) {
          const el = document.querySelector(sel)
          if (el) window.__seen.push(`${sel}: ${el.textContent}`)
        }
      }).observe(document.body, { subtree: true, childList: true, characterData: true })
    })
    await f.locator('.multi-clip-panel').getByRole('radio', { name: 'Strong' }).click()
    await until(() => f.evaluate(() => window.__seen.length > 0), 'the clean-up shows', 5000)
    await f.locator('.cleaning-notice').waitFor({ state: 'detached', timeout: 60000 })
    const seen = await f.evaluate(() => window.__seen)
    assert.ok(seen.some(t => /^\.cleaning-notice: Cleaning up the voice of 3 clips/.test(t)), `notice: ${seen.slice(0, 3).join(' / ')}`)
    assert.ok(seen.some(t => /noise-busy: .*Cleaning up the voice/.test(t)), 'spinner in the panel')
    await until(() => { const d = mine(); return d && clipsOf(d.state).filter(c => ids.includes(c.id)).every(c => c.denoise === 'studio') }, 'Studio voice on all three', 60000)

    // Group them (one group id on all three), then Ungroup
    const groupIds = () => { const d = mine(); return d ? clipsOf(d.state).filter(c => ids.includes(c.id)).map(c => c.groupId || null) : [] }
    // in the timeline toolbar (next to Options), not in the panel
    assert.equal(await f.locator('.multi-clip-panel button', { hasText: /Group/ }).count(), 0, 'no group buttons in the panel')
    await f.locator('.timeline-toolbar button[title^="Group:"]').click()
    await until(() => { const g = groupIds(); return g.length === 3 && g[0] && g.every(x => x === g[0]) }, 'one group for all three')
    // one clip of the group selected: Ungroup sits next to Options
    await f.locator(`.timeline-clip-v2[data-clip-id="${ids[0]}"]`).click()
    assert.equal(await f.locator('.timeline-toolbar button[title="Clip settings"] + button[title^="Ungroup:"]').count(), 1, 'Ungroup next to Options')
    await f.locator('.timeline-toolbar button[title^="Ungroup:"]').click()
    await until(() => { const g = groupIds(); return g.length === 3 && g.every(x => x == null) }, 'ungrouped')
    await m.page.keyboard.press('Control+a')

    // Escape clears it, Ctrl+A takes every clip again
    await m.page.keyboard.press('Escape')
    assert.equal(await f.locator('.timeline-clip-v2.selected').count(), 0)
    await m.page.keyboard.press('Control+a')
    assert.equal(await f.locator('.timeline-clip-v2.selected').count(), 3)
    await m.ctx.close()
  })

  await step('phones: Select, tap each clip, Group in the toolbar, Done opens the panel for all of them', async () => {
    if (fs.existsSync(projectsDir)) for (const file of fs.readdirSync(projectsDir)) fs.rmSync(path.join(projectsDir, file), { force: true })
    const ph = await openEditor({ viewport: { width: 390, height: 844 } })
    const f = ph.frame
    await f.locator('.timeline-clip-v2.audio').first().waitFor({ timeout: 15000 })
    const firstId = await f.locator('.timeline-clip-v2.audio').first().getAttribute('data-clip-id')
    await until(() => drafts().find(p => clipsOf(p.state).some(c => c.id === firstId && /\/api\/upload\/files\//.test((c.url || '') + (c.serverUrl || '')))), 'recording uploaded', 45000)
    await f.getByRole('button', { name: /Cut silences/ }).click()
    await f.getByRole('dialog', { name: 'Cut silences' }).waitFor()
    await until(async () => /cuts/.test(await f.locator('.silence-cut-summary').innerText().catch(() => '')), 'cut plan summary')
    await f.getByRole('button', { name: /Edit for me|This clip only/ }).click()
    await until(async () => (await f.locator('.timeline-clip-v2.audio').count()) === 3, 'three speech parts')
    const ids = await f.locator('.timeline-clip-v2.audio').evaluateAll(els => els.map(e => e.dataset.clipId))

    await f.locator('.select-mode-btn').click()
    for (const id of ids) await f.locator(`.timeline-clip-v2[data-clip-id="${id}"]`).click()
    assert.equal(await f.locator('.timeline-clip-v2.selected').count(), 3)
    assert.match(await f.locator('.timeline-select-hint').innerText(), /3 clips selected/)
    assert.equal(await f.locator('.multi-clip-panel').count(), 0, 'no panel over the timeline while picking')
    // tapping one again takes it out, and back in
    await f.locator(`.timeline-clip-v2[data-clip-id="${ids[1]}"]`).click()
    assert.equal(await f.locator('.timeline-clip-v2.selected').count(), 2)
    await f.locator(`.timeline-clip-v2[data-clip-id="${ids[1]}"]`).click()
    // Group sits in the toolbar while picking (the panel isn't over the timeline yet)
    await f.locator('.timeline-toolbar button[title^="Group:"]').click()
    await f.locator('.timeline-select-hint').getByRole('button', { name: 'Done' }).click()
    assert.equal(await f.locator('.multi-clip-panel .compact-properties-title').innerText(), '3 clips selected')
    await until(() => {
      const d = drafts().find(p => ids.every(id => clipsOf(p.state).some(c => c.id === id)))
      const g = d ? clipsOf(d.state).filter(c => ids.includes(c.id)).map(c => c.groupId) : []
      return g.length === 3 && g[0] && g.every(x => x === g[0])
    }, 'grouped from the phone')
    await ph.ctx.close()
  })

  await step('delete asks in the editor (not window.confirm), Space plays from a slider, the timeline follows the playhead, the draft keeps it', async () => {
    if (fs.existsSync(projectsDir)) for (const file of fs.readdirSync(projectsDir)) fs.rmSync(path.join(projectsDir, file), { force: true })
    const d = await openEditor()
    const f = d.frame
    // native dialogs would be dismissed here (= "Cancel"): the old confirm() could never delete in this test
    let nativeDialogs = 0
    d.page.on('dialog', (dlg) => { nativeDialogs++; dlg.dismiss().catch(() => {}) })
    await f.locator('.timeline-clip-v2.audio').first().waitFor({ timeout: 15000 })
    const firstId = await f.locator('.timeline-clip-v2.audio').first().getAttribute('data-clip-id')
    await until(() => drafts().find(p => clipsOf(p.state).some(c => c.id === firstId && /\/api\/upload\/files\//.test((c.url || '') + (c.serverUrl || '')))), 'recording uploaded', 45000)
    await f.getByRole('button', { name: /Cut silences/ }).click()
    await f.getByRole('dialog', { name: 'Cut silences' }).waitFor()
    await until(async () => /cuts/.test(await f.locator('.silence-cut-summary').innerText().catch(() => '')), 'cut plan summary')
    await f.getByRole('button', { name: /Edit for me|This clip only/ }).click()
    const clips = f.locator('.timeline-clip-v2.audio')
    await until(async () => (await clips.count()) === 3, 'three speech parts')

    // layout: the settings sit beside the stage only; the timeline runs the full width below
    await clips.first().click()
    const side = f.locator('.compact-top-row > .compact-side')
    await side.locator('input[type=range]').first().waitFor()
    const box = await f.evaluate(() => {
      const r = (s) => document.querySelector(s).getBoundingClientRect()
      return { side: r('.compact-top-row > .compact-side'), stage: r('.compact-top-row > .global-preview'), timeline: r('.compact-timeline-section'), main: r('.compact-main') }
    })
    assert.ok(box.side.bottom <= box.timeline.top + 1, `panel ends above the timeline: ${JSON.stringify(box)}`)
    assert.ok(Math.abs(box.side.height - box.stage.height) < 2, 'panel as tall as the stage')
    assert.ok(Math.abs(box.timeline.width - box.main.width) < 2, 'timeline full width')
    // no text selection on the editor, but in the fields you type in
    assert.equal(await f.evaluate(() => getComputedStyle(document.querySelector('.app')).userSelect), 'none')

    // Delete key -> the editor's own question; Enter removes; Ctrl+Z brings it back
    await f.locator('.timeline-content').click({ position: { x: 5, y: 5 } }).catch(() => {})
    await clips.first().click()
    await d.page.keyboard.press('Delete')
    await f.locator('.confirm-dialog').waitFor({ timeout: 5000 })
    await d.page.keyboard.press('Enter')
    await until(async () => (await clips.count()) === 2, 'one part removed')
    assert.equal(await f.locator('.confirm-dialog').count(), 0)
    await d.page.keyboard.press('Control+z')
    await until(async () => (await clips.count()) === 3, 'undo brings it back')
    // the toolbar's Delete: Cancel keeps it, Remove removes it
    await clips.nth(1).click()
    await f.locator('.timeline-v2 .delete-btn').first().click()
    await f.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click()
    assert.equal(await clips.count(), 3)
    await f.locator('.timeline-v2 .delete-btn').first().click()
    await f.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click()
    await until(async () => (await clips.count()) === 2, 'removed from the toolbar')
    assert.equal(nativeDialogs, 0, 'no window.confirm')

    // Space right after changing a setting with a slider (focus still on it)
    await clips.first().click()
    const slider = side.locator('input[type=range]').first()
    await slider.focus()
    await d.page.keyboard.press('ArrowRight')
    const playBtn = f.locator('.global-preview button[title="Play"], .global-preview button[title="Pause"]').first()
    assert.equal(await playBtn.getAttribute('title'), 'Play')
    await d.page.keyboard.press(' ')
    await until(async () => (await playBtn.getAttribute('title')) === 'Pause', 'Space plays from the slider', 5000)
    await d.page.keyboard.press(' ')
    await until(async () => (await playBtn.getAttribute('title')) === 'Play', 'Space pauses again', 5000)

    // zoomed in: while playing the timeline scrolls so the playhead stays in the middle
    for (let i = 0; i < 5; i++) await d.page.keyboard.press('Control+Equal')
    await f.evaluate(() => { document.querySelector('.timeline-content').scrollLeft = 0 })
    await f.locator('.timeline-ruler').click({ position: { x: 40, y: 5 } })
    await d.page.keyboard.press(' ')
    await until(async () => (await f.evaluate(() => document.querySelector('.timeline-content').scrollLeft)) > 20, 'timeline scrolls along', 8000)
    const offset = await f.evaluate(() => {
      const c = document.querySelector('.timeline-content').getBoundingClientRect()
      const p = document.querySelector('.timeline-playhead').getBoundingClientRect()
      return Math.abs((p.left - c.left) - c.width / 2)
    })
    assert.ok(offset < 40, `playhead in the middle (${offset} px off)`)
    await sleep(700)
    await d.page.keyboard.press(' ')
    await until(async () => (await playBtn.getAttribute('title')) === 'Play', 'paused', 5000)

    // the draft keeps where the playhead stopped, and reopens there
    const stopped = await until(() => { const p = drafts()[0]; return p && p.state.playhead > 0.5 ? p.state.playhead : null }, 'playhead in the draft', 15000)
    await d.ctx.close()
    const again = await openEditor({ file: null })
    await again.frame.locator('.drafts-item').first().click({ timeout: 20000 })
    await until(async () => (await again.frame.locator('.timeline-clip-v2.audio').count()) === 2, 'draft reopened')
    const up = Math.ceil(stopped) // the stage rounds up (utils/limits formatLength)
    const want = `${Math.floor(up / 60)}:${String(up % 60).padStart(2, '0')}`
    await until(async () => (await again.frame.locator('.audio-stage-time').innerText()) === want, `stage shows ${want}`, 5000)
    await again.ctx.close()
  })

  await step('dragging the ruler scrolls the timeline and leaves the playhead; a short click moves it', async () => {
    if (fs.existsSync(projectsDir)) for (const file of fs.readdirSync(projectsDir)) fs.rmSync(path.join(projectsDir, file), { force: true })
    const r = await openEditor()
    const f = r.frame
    await f.locator('.timeline-clip-v2.audio').first().waitFor({ timeout: 15000 })
    for (let i = 0; i < 5; i++) await r.page.keyboard.press('Control+Equal')
    const state = () => f.evaluate(() => ({
      scroll: document.querySelector('.timeline-content').scrollLeft,
      playhead: parseFloat(document.querySelector('.timeline-playhead').style.left)
    }))
    await f.evaluate(() => { document.querySelector('.timeline-content').scrollLeft = 100 })
    const before = await state()
    // the scroll box stays put (the ruler inside it moves with the scroll)
    const ruler = { ...(await f.locator('.timeline-content').boundingBox()), height: (await f.locator('.timeline-ruler').boundingBox()).height }
    const y = ruler.y + ruler.height / 2
    // drag right-to-left by 150 px: scrolls 150 px further, playhead untouched
    await r.page.mouse.move(ruler.x + 500, y)
    await r.page.mouse.down()
    for (let i = 1; i <= 10; i++) await r.page.mouse.move(ruler.x + 500 - i * 15, y)
    await r.page.mouse.up()
    await sleep(100)
    const dragged = await state()
    assert.ok(Math.abs(dragged.scroll - (before.scroll + 150)) < 3, `scrolled by the drag: ${before.scroll} -> ${dragged.scroll}`)
    assert.equal(dragged.playhead, before.playhead, 'the drag did not move the playhead')
    // a short click (a pixel or two of wobble) still moves the playhead to the spot
    await r.page.mouse.move(ruler.x + 200, y)
    await r.page.mouse.down()
    await r.page.mouse.move(ruler.x + 201, y)
    await r.page.mouse.up()
    await sleep(300)
    const clicked = await state()
    const info = await f.evaluate(() => ({ ruler: document.querySelector('.timeline-ruler').offsetWidth, view: document.querySelector('.timeline-content').clientWidth, clipEnd: Math.max(...[...document.querySelectorAll('.timeline-clip-v2')].map(e => e.offsetLeft + e.offsetWidth)) }))
    assert.ok(Math.abs(clicked.playhead - (dragged.scroll + 200)) < 12, `click moved the playhead: ${JSON.stringify({ before, dragged, clicked, info })}`)
    await r.ctx.close()
  })

  await step('Ctrl+click adds / takes out a clip, Shift+click selects everything from the selected clip to the clicked one', async () => {
    if (fs.existsSync(projectsDir)) for (const file of fs.readdirSync(projectsDir)) fs.rmSync(path.join(projectsDir, file), { force: true })
    const r = await openEditor()
    const f = r.frame
    await f.locator('.timeline-clip-v2.audio').first().waitFor({ timeout: 15000 })
    const firstId = await f.locator('.timeline-clip-v2.audio').first().getAttribute('data-clip-id')
    await until(() => drafts().find(p => clipsOf(p.state).some(c => c.id === firstId && /\/api\/upload\/files\//.test((c.url || '') + (c.serverUrl || '')))), 'recording uploaded', 45000)
    await f.getByRole('button', { name: /Cut silences/ }).click()
    await f.getByRole('dialog', { name: 'Cut silences' }).waitFor()
    await until(async () => /cuts/.test(await f.locator('.silence-cut-summary').innerText().catch(() => '')), 'cut plan summary')
    await f.getByRole('button', { name: /Edit for me|This clip only/ }).click()
    const clips = f.locator('.timeline-clip-v2.audio')
    await until(async () => (await clips.count()) === 3, 'three speech parts')
    const selected = () => f.locator('.compact-properties-title').first().innerText().catch(() => '')
    await clips.nth(0).click()
    await clips.nth(2).click({ modifiers: ['Shift'] })
    await until(async () => /^3 clips selected/.test(await selected()), 'Shift+click: all three')
    await clips.nth(1).click({ modifiers: ['Control'] })
    await until(async () => /^2 clips selected/.test(await selected()), 'Ctrl+click takes the middle one out')
    await clips.nth(1).click({ modifiers: ['Control'] })
    await until(async () => /^3 clips selected/.test(await selected()), 'Ctrl+click puts it back')
    // the anchor is the last Ctrl-clicked clip (the middle one): Shift+click on the last = middle + last
    await clips.nth(2).click({ modifiers: ['Shift'] })
    await until(async () => /^2 clips selected/.test(await selected()), 'Shift+click from the anchor')
    await clips.nth(0).click()
    await until(async () => !/clips selected/.test(await selected()), 'a plain click selects one')
    await r.ctx.close()
  })

  await step('slow file requests: every cut piece still plays its own part of the recording, in step with the timeline', async () => {
    // a cut-up draft (clips point at the server's file, not a local blob)
    if (fs.existsSync(projectsDir)) for (const file of fs.readdirSync(projectsDir)) fs.rmSync(path.join(projectsDir, file), { force: true })
    const a = await openEditor()
    await a.frame.locator('.timeline-clip-v2.audio').first().waitFor({ timeout: 15000 })
    const id0 = await a.frame.locator('.timeline-clip-v2.audio').first().getAttribute('data-clip-id')
    await until(() => drafts().find(p => clipsOf(p.state).some(c => c.id === id0 && /\/api\/upload\/files\//.test(c.url || ''))), 'uploaded', 45000)
    await a.frame.getByRole('button', { name: /Cut silences/ }).click()
    await a.frame.getByRole('dialog', { name: 'Cut silences' }).waitFor()
    await until(async () => /cuts/.test(await a.frame.locator('.silence-cut-summary').innerText().catch(() => '')), 'cut plan summary')
    await a.frame.getByRole('button', { name: /Edit for me|This clip only/ }).click()
    await until(() => { const p = drafts()[0]; return p && clipsOf(p.state).filter(c => !c.music).length === 3 }, 'cut draft saved', 15000)
    await a.ctx.close()

    const b = await openEditor({ file: null })
    const f = b.frame
    // every request for the recording takes 2.5 s (a far seek in a long file without a seek index did)
    await b.ctx.route(`${BACKEND}/api/upload/files/**`, async (route) => { await sleep(2500); route.continue().catch(() => {}) })
    await f.locator('.drafts-item').first().click({ timeout: 20000 })
    await until(async () => (await f.locator('.timeline-clip-v2.audio').count()) === 3, 'draft reopened')
    const clips = clipsOf(drafts()[0].state).filter(c => !c.music)
    await f.evaluate((cs) => {
      window.__clips = Object.fromEntries(cs.map(c => [c.id, c]))
      window.__err = []
      const el0 = document.querySelector(`.timeline-clip-v2[data-clip-id="${cs[0].id}"]`)
      const pps = el0.offsetWidth / (cs[0].endTime - cs[0].startTime)
      window.__timer = setInterval(() => {
        const pos = parseFloat(document.querySelector('.timeline-playhead').style.left) / pps
        for (const el of document.querySelectorAll('audio[data-clip-id]')) {
          const c = window.__clips[el.dataset.clipId]
          if (!c || el.paused || el.seeking || el.readyState < 3) continue
          const into = pos - c.timelinePosition
          if (into < 0.3 || into > (c.endTime - c.startTime) - 0.1) continue // start-up and the cut itself
          window.__err.push({ id: c.id, err: Math.abs(el.currentTime - (c.startTime + into)) })
        }
      }, 40)
    }, clips)
    await b.page.keyboard.press(' ')
    const end = Math.max(...clips.map(c => c.timelinePosition + c.endTime - c.startTime))
    await until(async () => (await f.locator('.global-preview button[title="Play"]').count()) > 0, 'played to the end', (end + 20) * 1000)
    const errs = await f.evaluate(() => { clearInterval(window.__timer); return window.__err })
    const heard = new Set(errs.map(e => e.id))
    assert.equal(heard.size, 3, `all three pieces sounded (${heard.size})`)
    const worst = Math.max(...errs.map(e => e.err))
    assert.ok(worst < 0.25, `every piece in step with the timeline (worst ${worst.toFixed(3)} s off)`)
    await b.ctx.close()
  })

  await step('wheel scrolls the timeline, Shift+wheel zooms around the mouse, full screen on and off (button and F)', async () => {
    if (fs.existsSync(projectsDir)) for (const file of fs.readdirSync(projectsDir)) fs.rmSync(path.join(projectsDir, file), { force: true })
    const w = await openEditor()
    const f = w.frame
    await f.locator('.timeline-clip-v2.audio').first().waitFor({ timeout: 15000 })
    for (let i = 0; i < 5; i++) await w.page.keyboard.press('Control+Equal')
    const content = f.locator('.timeline-content')
    const box = await content.boundingBox()
    const scroll = () => content.evaluate(el => el.scrollLeft)
    const clipWidth = () => f.locator('.timeline-clip-v2.audio').first().evaluate(el => el.offsetWidth)
    await content.evaluate(el => { el.scrollLeft = 0 })
    await w.page.mouse.move(box.x + 300, box.y + 60)
    await w.page.mouse.wheel(0, 240)
    await until(async () => (await scroll()) > 100, 'wheel scrolled the timeline', 3000)
    // Shift + wheel up: zoom in, the moment under the mouse stays under it
    const s0 = await scroll()
    const w0 = await clipWidth()
    const t0 = (300 + s0) / w0 // in clip widths (the clip starts at 0)
    await w.page.keyboard.down('Shift')
    await w.page.mouse.wheel(0, -200)
    await w.page.keyboard.up('Shift')
    await until(async () => (await clipWidth()) > w0 * 1.2, 'Shift+wheel zoomed in', 3000)
    const w1 = await clipWidth()
    const t1 = (300 + await scroll()) / w1
    assert.ok(Math.abs(t1 - t0) * w1 < 6, `the spot under the mouse stayed (${t0.toFixed(4)} -> ${t1.toFixed(4)})`)
    // full screen
    const btn = f.getByRole('button', { name: 'Full screen' })
    await btn.click()
    await until(() => f.evaluate(() => !!document.fullscreenElement), 'full screen on', 5000)
    assert.equal(await f.getByRole('button', { name: 'Leave full screen' }).getAttribute('aria-pressed'), 'true')
    await w.page.keyboard.press('f')
    await until(() => f.evaluate(() => !document.fullscreenElement), 'F leaves full screen', 5000)
    await w.ctx.close()
  })

  await step('audio added from a track\'s + goes on that track at the playhead (a new track below when the spot is taken)', async () => {
    if (fs.existsSync(projectsDir)) for (const file of fs.readdirSync(projectsDir)) fs.rmSync(path.join(projectsDir, file), { force: true })
    const r = await openEditor()
    const f = r.frame
    await f.locator('.timeline-clip-v2.audio').first().waitFor({ timeout: 15000 })
    const voiceId = await f.locator('.timeline-clip-v2.audio').first().getAttribute('data-clip-id')
    await until(() => drafts().find(p => clipsOf(p.state).some(c => c.id === voiceId && /\/api\/upload\/files\//.test(c.url || ''))), 'uploaded', 45000)
    // playhead to 3.0 s (on the voice clip, the Music track is empty there)
    await f.locator('.timeline-content').click({ position: { x: 3, y: 60 } }).catch(() => {})
    for (let i = 0; i < 30; i++) await r.page.keyboard.press('ArrowRight')
    const labels = f.locator('.track-label.audio')
    // the Music track's + -> Add Audio File
    await labels.nth(1).locator('input[type=file]').setInputFiles(path.join(HOST_DIR, 'outro.wav'))
    const placed = await until(() => {
      const p = drafts()[0]
      const music = p && p.state.tracks.find(t => t.music)
      return music?.clips.find(c => /outro/.test(c.name) && /\/api\/upload\/files\//.test(c.url || '')) || null
    }, 'outro on the Music track', 30000)
    assert.ok(Math.abs(placed.timelinePosition - 3) < 0.15, `at the playhead: ${placed.timelinePosition}`)
    assert.equal(drafts()[0].state.tracks.filter(t => t.type === 'audio').length, 2, 'no new track')
    // the Voice track's + while the playhead is on its clip: a new track right below Voice, at the playhead
    await labels.nth(0).locator('input[type=file]').setInputFiles(path.join(HOST_DIR, 'intro.wav'))
    const after = await until(() => {
      const p = drafts()[0]
      const ts = p && p.state.tracks.filter(t => t.type === 'audio')
      return ts && ts.length === 3 && ts[1].clips.some(c => /intro/.test(c.name) && /\/api\/upload\/files\//.test(c.url || '')) ? ts : null
    }, 'intro on a new track below Voice', 30000)
    assert.equal(after[0].clips.length, 1, 'the voice clip is untouched')
    assert.ok(!after[1].music, 'a voice track like the one it came from')
    assert.ok(Math.abs(after[1].clips[0].timelinePosition - 3) < 0.15, `at the playhead: ${after[1].clips[0].timelinePosition}`)
    assert.ok(after[2].music, 'Music stays below')
    await r.ctx.close()
  })

  await step('voice clean-up on any track: a Music Library song on the Music track is uploaded, then cleaned (Off, Light, Medium, Strong)', async () => {
    // a tiny music library served by the editor (like /music/ in production)
    fs.mkdirSync(path.join(S, 'dist', 'music'), { recursive: true })
    fs.copyFileSync(path.join(HOST_DIR, 'bed.wav'), path.join(S, 'dist', 'music', 'bed.wav'))
    fs.writeFileSync(path.join(S, 'dist', 'music', 'library.json'), JSON.stringify({ version: 2, moods: [{ id: 'chill', label: 'Chill' }], tracks: [{ id: 'bed', title: 'Test bed', artist: 'E2E', mood: 'chill', duration: 5, file: 'bed.wav' }] }))
    if (fs.existsSync(projectsDir)) for (const file of fs.readdirSync(projectsDir)) fs.rmSync(path.join(projectsDir, file), { force: true })
    const r = await openEditor()
    const f = r.frame
    await f.locator('.timeline-clip-v2.audio').first().waitFor({ timeout: 15000 })
    const voiceId = await f.locator('.timeline-clip-v2.audio').first().getAttribute('data-clip-id')
    await until(() => drafts().find(p => clipsOf(p.state).some(c => c.id === voiceId && /\/api\/upload\/files\//.test(c.url || ''))), 'uploaded', 45000)
    // the Music track's + -> Music Library -> add the song
    const musicLabel = f.locator('.track-label.audio').nth(1)
    await musicLabel.locator('.track-add-btn').click()
    await f.locator('.track-add-popup').getByRole('button', { name: /Music Library/ }).click()
    await f.locator('.music-library-add').first().click()
    const musicRow = f.locator('.timeline-track-v2.audio').nth(1)
    await musicRow.locator('.timeline-clip-v2').first().waitFor({ timeout: 15000 })
    await musicRow.locator('.timeline-clip-v2').first().click()
    const levels = f.getByRole('radiogroup', { name: 'Noise reduction' })
    assert.deepEqual(await levels.getByRole('radio').allInnerTexts(), ['Off', 'Light', 'Medium', 'Strong'])
    await levels.getByRole('radio', { name: 'Strong' }).click()
    const song = await until(() => {
      const music = drafts()[0]?.state.tracks.find(t => t.music)
      const c = music?.clips[0]
      return c && /_dn-studio\.m4a/.test(c.url || '') ? c : null
    }, 'the song on its cleaned (uploaded) copy', 45000)
    assert.equal(song.denoise, 'studio')
    assert.match(song.denoiseSourceUrl, /\/api\/upload\/files\//, 'cleaned from an uploaded copy')
    // Off: back to the library file
    await levels.getByRole('radio', { name: 'Off' }).click()
    // Off: the uncleaned audio again (the draft keeps the uploaded copy of the song)
    await until(() => { const c = drafts()[0]?.state.tracks.find(t => t.music)?.clips[0]; return c && !c.denoise && !/_dn-/.test(c.url) }, 'Off: uncleaned again', 15000)
    await r.ctx.close()
  })

  await step('Ripple closes the gap on the selected clip\'s track only: the music on track 2 stays', async () => {
    if (fs.existsSync(projectsDir)) for (const file of fs.readdirSync(projectsDir)) fs.rmSync(path.join(projectsDir, file), { force: true })
    const r = await openEditor()
    const f = r.frame
    await f.locator('.timeline-clip-v2.audio').first().waitFor({ timeout: 15000 })
    const id0 = await f.locator('.timeline-clip-v2.audio').first().getAttribute('data-clip-id')
    await until(() => drafts().find(p => clipsOf(p.state).some(c => c.id === id0 && /\/api\/upload\/files\//.test(c.url || ''))), 'uploaded', 45000)
    await f.locator('.track-label.audio').nth(1).locator('input[type=file]').setInputFiles(path.join(HOST_DIR, 'bed.wav'))
    await f.locator('.timeline-track-v2.audio').nth(1).locator('.timeline-clip-v2').first().waitFor({ timeout: 15000 })
    await f.locator('.timeline-track-v2.audio').first().locator('.timeline-clip-v2').first().click()
    await f.getByRole('button', { name: /Cut silences/ }).click()
    await f.getByRole('dialog', { name: 'Cut silences' }).waitFor()
    await until(async () => /cuts/.test(await f.locator('.silence-cut-summary').innerText().catch(() => '')), 'cut plan summary')
    await f.getByRole('button', { name: /Edit for me|This clip only/ }).click()
    const voice = f.locator('.timeline-track-v2.audio').first().locator('.timeline-clip-v2')
    await until(async () => (await voice.count()) === 3, 'three pieces')
    // the middle piece out: a gap on track 1 (the first piece is left alone: no ripple from the delete)
    await voice.nth(1).click()
    await r.page.keyboard.press('Delete')
    await f.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click()
    await until(async () => (await voice.count()) === 2, 'two pieces, a gap between')
    const before = await until(() => { const p = drafts()[0]; const v = p && p.state.tracks.find(t => !t.music); return v && v.clips.length === 2 && p.state.tracks.find(t => t.music).clips.length === 1 ? p.state : null }, 'saved with the gap', 15000)
    const [a, b] = before.tracks.find(t => !t.music).clips.slice().sort((x, y) => x.timelinePosition - y.timelinePosition)
    const musicAt = before.tracks.find(t => t.music).clips[0].timelinePosition
    // select the first voice piece, playhead into the gap, G
    await voice.first().click()
    await f.evaluate(() => document.querySelector('.timeline-content').scrollLeft = 0)
    const pxPerSec = await voice.first().evaluate((el, len) => el.offsetWidth / len, a.endTime - a.startTime)
    const gapMid = (a.timelinePosition + (a.endTime - a.startTime) + b.timelinePosition) / 2
    await f.locator('.timeline-ruler').click({ position: { x: Math.round(gapMid * pxPerSec), y: 5 } })
    await until(async () => !(await f.getByRole('button', { name: /Ripple/ }).isDisabled()), 'Ripple enabled', 3000)
    assert.match(await f.getByRole('button', { name: /Ripple/ }).getAttribute('title'), /on track 1/)
    await voice.first().click() // the ruler click keeps the selection; make sure
    await r.page.keyboard.press('g')
    const after = await until(() => {
      const p = drafts()[0]
      const v = p?.state.tracks.find(t => !t.music)?.clips.find(c => c.id === b.id)
      return v && Math.abs(v.timelinePosition - b.timelinePosition) > 0.01 ? p.state : null
    }, 'the second piece moved up', 15000)
    const b2 = after.tracks.find(t => !t.music).clips.find(c => c.id === b.id)
    assert.ok(Math.abs(b2.timelinePosition - (a.timelinePosition + (a.endTime - a.startTime))) < 0.02, `closed the gap: ${b2.timelinePosition}`)
    assert.equal(after.tracks.find(t => t.music).clips[0].timelinePosition, musicAt, 'the music on track 2 did not move')
    await r.ctx.close()
  })

  await step('the draft keeps the timeline zoom: it reopens zoomed in, not fitted', async () => {
    if (fs.existsSync(projectsDir)) for (const file of fs.readdirSync(projectsDir)) fs.rmSync(path.join(projectsDir, file), { force: true })
    const z = await openEditor()
    const clip = z.frame.locator('.timeline-clip-v2.audio').first()
    await clip.waitFor({ timeout: 15000 })
    const id = await clip.getAttribute('data-clip-id')
    await until(() => drafts().find(p => clipsOf(p.state).some(c => c.id === id && /\/api\/upload\/files\//.test(c.url || ''))), 'uploaded', 45000)
    const fitted = await clip.evaluate(el => el.offsetWidth)
    // the keys go to the editor (focus inside it); a short clip fitted is near the top zoom already
    await z.frame.locator('.timeline-content').click({ position: { x: 3, y: 60 } }).catch(() => {})
    for (let i = 0; i < 3; i++) await z.page.keyboard.press('Control+Equal')
    await until(async () => (await clip.evaluate(el => el.offsetWidth)) > fitted * 1.3, 'zoomed in')
    const zoomedWidth = await clip.evaluate(el => el.offsetWidth)
    const saved = await until(() => { const p = drafts()[0]; return p?.state.zoom && Math.abs(p.state.zoom * 7.5 - zoomedWidth) < 3 ? p.state.zoom : null }, 'the zoom in the draft', 15000)
    await z.ctx.close()
    const again = await openEditor({ file: null })
    await again.frame.locator('.drafts-item').first().click({ timeout: 20000 })
    const clip2 = again.frame.locator('.timeline-clip-v2.audio').first()
    await clip2.waitFor({ timeout: 15000 })
    await sleep(500) // past the first-content Fit, which must not run
    const width = await clip2.evaluate(el => el.offsetWidth)
    assert.ok(Math.abs(width - saved * 7.5) < 3, `reopened at ${width} px, saved ${saved * 7.5} px (fitted was ${fitted})`)
    await again.ctx.close()
  })

  await step('flags: B and the Flag button set numbered flags in their own colours; click jumps, right-click removes; they and the selected clip come back with the draft', async () => {
    if (fs.existsSync(projectsDir)) for (const file of fs.readdirSync(projectsDir)) fs.rmSync(path.join(projectsDir, file), { force: true })
    const r = await openEditor()
    const f = r.frame
    const clip = f.locator('.timeline-clip-v2.audio').first()
    await clip.waitFor({ timeout: 15000 })
    const id = await clip.getAttribute('data-clip-id')
    await until(() => drafts().find(p => clipsOf(p.state).some(c => c.id === id && /\/api\/upload\/files\//.test(c.url || ''))), 'uploaded', 45000)
    // flag 1 at 1 s (B), flag 2 at 3 s (the toolbar button)
    await f.locator('.timeline-content').click({ position: { x: 3, y: 60 } }).catch(() => {})
    for (let i = 0; i < 10; i++) await r.page.keyboard.press('ArrowRight')
    await r.page.keyboard.press('b')
    for (let i = 0; i < 20; i++) await r.page.keyboard.press('ArrowRight')
    await f.getByRole('button', { name: /^Flag$/ }).click()
    const heads = f.locator('.timeline-flag-head')
    await until(async () => (await heads.count()) === 2, 'two flags')
    assert.deepEqual(await heads.allInnerTexts(), ['1', '2'])
    const colours = await heads.evaluateAll(els => els.map(el => getComputedStyle(el).backgroundColor))
    assert.notEqual(colours[0], colours[1], 'each flag its own colour')
    // click flag 1: the playhead jumps to 0:01
    await heads.first().click()
    await until(async () => (await f.locator('.audio-stage-time').innerText()) === '0:01', 'jumped to flag 1', 3000)
    // a third flag, removed with a right-click
    await r.page.keyboard.press('ArrowRight')
    await r.page.keyboard.press('b')
    await until(async () => (await heads.count()) === 3, 'three flags')
    await f.locator('.timeline-flag-head[data-flag="3"]').click({ button: 'right' })
    await until(async () => (await heads.count()) === 2, 'flag 3 removed')
    // select the clip; the draft keeps flags + selection
    await clip.click()
    const saved = await until(() => { const p = drafts()[0]; return p?.state.flags?.length === 2 && p.state.selected?.[0] === id ? p.state : null }, 'flags and selection in the draft', 15000)
    assert.deepEqual(saved.flags.map(x => x.n), [1, 2])
    await r.ctx.close()
    const again = await openEditor({ file: null })
    await again.frame.locator('.drafts-item').first().click({ timeout: 20000 })
    await again.frame.locator('.timeline-clip-v2.audio').first().waitFor({ timeout: 15000 })
    await until(async () => (await again.frame.locator('.timeline-flag-head').count()) === 2, 'flags back')
    assert.deepEqual(await again.frame.locator('.timeline-flag-head').allInnerTexts(), ['1', '2'])
    await until(async () => /selected/.test(await again.frame.locator(`.timeline-clip-v2[data-clip-id="${id}"]`).getAttribute('class')), 'the clip is selected again', 5000)
    await again.ctx.close()
  })

  await step('track heights: drag the handle under a track label; the track and its label grow, the tracks scroll up and down with their labels, the draft keeps it', async () => {
    if (fs.existsSync(projectsDir)) for (const file of fs.readdirSync(projectsDir)) fs.rmSync(path.join(projectsDir, file), { force: true })
    const r = await openEditor({ viewport: { width: 1280, height: 700 } })
    const f = r.frame
    const clip = f.locator('.timeline-clip-v2.audio').first()
    await clip.waitFor({ timeout: 15000 })
    const id = await clip.getAttribute('data-clip-id')
    await until(() => drafts().find(p => clipsOf(p.state).some(c => c.id === id && /\/api\/upload\/files\//.test(c.url || ''))), 'uploaded', 45000)
    const row = f.locator('.timeline-track-v2.audio').first()
    const label = f.locator('.track-label.audio').first()
    assert.equal(await row.evaluate(el => el.offsetHeight), 60)
    const handle = await label.locator('.track-resize-handle').boundingBox()
    await r.page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
    await r.page.mouse.down()
    for (let i = 1; i <= 9; i++) await r.page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2 + i * 20)
    await r.page.mouse.up()
    await until(async () => (await row.evaluate(el => el.offsetHeight)) === 240, 'the track grew to the maximum (240)')
    assert.equal(await label.evaluate(el => el.offsetHeight), 240, 'its label too')
    // two tall tracks no longer fit: the tracks scroll, the labels follow, the ruler stays
    // (scroll down first, as a person would, so the second handle is in view)
    await f.evaluate(async () => { document.querySelector('.timeline-content').scrollTop = 10000; await new Promise(res => setTimeout(res, 100)) })
    const handle2 = await f.locator('.track-label.audio').nth(1).locator('.track-resize-handle').boundingBox()
    await r.page.mouse.move(handle2.x + 20, handle2.y + 3)
    await r.page.mouse.down()
    for (let i = 1; i <= 9; i++) await r.page.mouse.move(handle2.x + 20, handle2.y + 3 + i * 20)
    await r.page.mouse.up()
    const scroll = await f.evaluate(async () => {
      const c = document.querySelector('.timeline-content')
      const can = c.scrollHeight > c.clientHeight + 10
      c.scrollTop = 100
      await new Promise(res => setTimeout(res, 100))
      return { can, content: c.scrollTop, labels: document.querySelector('.timeline-sidebar').scrollTop, rulerTop: document.querySelector('.timeline-ruler').getBoundingClientRect().top - c.getBoundingClientRect().top }
    })
    assert.ok(scroll.can, 'the tracks scroll up and down')
    assert.equal(scroll.labels, scroll.content, 'the labels follow the tracks')
    assert.ok(Math.abs(scroll.rulerTop) < 1, `the ruler stays at the top (${scroll.rulerTop})`)
    // the draft keeps the heights; double-click resets
    let last = null
    await until(() => { const p = drafts()[0]; const ts = p?.state.tracks.filter(t => t.type === 'audio'); last = ts?.map(t => t.height); return ts && ts[0].height === 240 && ts[1].height === 240 }, 'heights in the draft', 15000)
      .catch((err) => { throw new Error(`${err.message}: saved heights ${JSON.stringify(last)}`) })
    await f.evaluate(() => { document.querySelector('.timeline-content').scrollTop = 0 })
    await label.locator('.track-resize-handle').dblclick()
    await until(async () => (await row.evaluate(el => el.offsetHeight)) === 60, 'double-click: back to 60')
    await r.ctx.close()
  })

  await step('a remix saves a draft that keeps its original; opened again, it goes under that original', async () => {
    if (fs.existsSync(projectsDir)) for (const file of fs.readdirSync(projectsDir)) fs.rmSync(path.join(projectsDir, file), { force: true })
    ff(['-f', 'lavfi', '-i', 'testsrc=size=360x640:rate=30:duration=4', '-f', 'lavfi', '-i', 'sine=f=440:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(S, 'dist', 'remix-original.mp4')])
    const r = await openEditor({ file: null, mode: 'video' })
    await r.frame.getByText('Shorts Editor').first().waitFor()
    await r.page.evaluate((u) => window.__send({ type: 'load-media', url: u, name: 'Original', mediaType: 'video', parentAuthor: 'bob', parentPermlink: 'orig' }), `${EDITOR}/remix-original.mp4`)
    await r.frame.getByText('Free edit').first().click({ timeout: 20000 })
    await r.frame.locator('.timeline-clip-v2').first().waitFor()
    await r.frame.locator('.timeline-clip-v2').first().click()
    await r.page.keyboard.press('t') // an edit: a text
    const d = await until(() => drafts().find(p => p.state?.remix), 'a remix draft', 30000)
    assert.deepEqual(d.state.remix, { parentAuthor: 'bob', parentPermlink: 'orig' })
    await r.ctx.close()
    // opened again (not from the remix button): the draft brings the original back
    const o = await openEditor({ file: null, mode: 'video' })
    await o.frame.getByText(/Continue/i).first().waitFor({ timeout: 20000 })
    await o.frame.locator('.drafts-item').first().click()
    await o.frame.locator('.timeline-clip-v2').first().waitFor()
    await o.page.evaluate(() => window.__send({ type: 'get-state' }))
    const st = await until(() => o.page.evaluate(() => window.__messages.find(m => m.type === 'state-response')), 'state-response')
    assert.deepEqual(st.remixSource, { parentAuthor: 'bob', parentPermlink: 'orig' }, 'the export posts under the original')
    await o.ctx.close()
  })

  await step('shorts editor in a remix: Add Text goes in at the playhead over the video, selected; image and text stickers go in', async () => {
    // a sticker library and a video to remix, served by the editor's own origin
    const st = path.join(S, 'dist', 'stickers')
    fs.mkdirSync(st, { recursive: true })
    fs.writeFileSync(path.join(st, 'star.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M5 0l1.5 3.5H10L7 6l1 4-3-2.5L2 10l1-4-3-2.5h3.5z" fill="gold"/></svg>')
    fs.writeFileSync(path.join(st, 'library.json'), JSON.stringify({ version: 1, categories: [{ id: 'emoji', label: 'Emojis' }], items: [{ id: 'star', category: 'emoji', title: 'Star', file: 'star.svg', keywords: ['star'] }] }))
    ff(['-f', 'lavfi', '-i', 'testsrc=size=360x640:rate=30:duration=6', '-f', 'lavfi', '-i', 'sine=f=440:d=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(S, 'dist', 'original.mp4')])
    const v = await openEditor({ file: null, mode: 'video' })
    const f = v.frame
    await f.getByText('Shorts Editor').first().waitFor()
    await v.page.evaluate((u) => window.__send({ type: 'load-media', url: u, name: 'Original', mediaType: 'video', parentAuthor: 'bob', parentPermlink: 'orig' }), `${EDITOR}/original.mp4`)
    await f.getByText('Free edit').first().click({ timeout: 20000 })
    await f.locator('.timeline-clip-v2').first().waitFor()
    const videoLeft = (await f.locator('.timeline-clip-v2').first().boundingBox()).x
    // Add Text from the video track's +: at the playhead (0:00), over the video, selected, showing
    await f.locator('.track-add-btn').first().click()
    await f.getByRole('button', { name: 'Add Text' }).click()
    const text = f.locator('.timeline-clip-v2.text')
    await text.waitFor()
    assert.ok(Math.abs((await text.boundingBox()).x - videoLeft) < 3, 'the text starts at the playhead, not after the video')
    assert.match(await text.getAttribute('class'), /selected/, 'the new text is selected (its settings open)')
    await until(async () => (await f.locator('.compact-global-preview').innerText()).includes('Enter text here'), 'the preview shows the text', 5000)
    // an image sticker, then a text sticker: they go in, the editor stays
    const openStickers = async () => {
      await f.locator('.track-add-btn').first().click()
      await f.getByRole('button', { name: 'Stickers' }).click()
      await f.locator('.sticker-grid').waitFor()
    }
    await openStickers()
    await f.locator('.sticker-tile:not(.text)').first().click()
    await until(async () => (await f.locator('.timeline-clip-v2.image').count()) === 1, 'the image sticker is on the timeline', 5000)
    await openStickers()
    await f.getByRole('button', { name: 'Text boxes' }).click()
    await f.locator('.sticker-tile.text').first().click()
    await until(async () => (await f.locator('.timeline-clip-v2.text').count()) === 2, 'the text sticker is on the timeline', 5000)
    assert.equal(await f.locator('.app').count(), 1, 'the editor is still there')
    await v.ctx.close()
  })

  await step('the shorts video editor is unchanged (no mode, Video 1 + Audio 1, Render, no audio tools)', async () => {
    const v = await openEditor({ file: null, mode: 'video' })
    const ready = await v.page.evaluate(() => window.__messages.find(m => m.type === 'editor-ready'))
    assert.equal(ready.mode, undefined)
    assert.equal(ready.canEditAudio, undefined)
    await v.frame.getByText('Shorts Editor').first().waitFor()
    assert.equal(await v.frame.getByRole('button', { name: 'Cut silences' }).count(), 0)
    assert.equal(await v.frame.locator('.track-label:not(.audio)').count(), 1, 'a video track')
    assert.ok(await v.frame.getByRole('button', { name: /Render/ }).isVisible())
    await v.ctx.close()
  })
} finally {
  await browser.close()
  for (const s of servers) s.close()
  for (const c of children) c.kill('SIGTERM')
  fs.rmSync(S, { recursive: true, force: true })
  // Expected: the upload's "already on the server?" check (404 = no), and the free
  // tier's one-draft limit (409) when a later step opens a second recording
  const relevant = consoleErrors.filter(e => !/favicon|ERR_ABORTED|net::ERR_BLOCKED|by-hash|PUT \S+\/api\/projects\/|status of (404|409)/.test(e))
  console.log(`\nconsole errors: ${relevant.length}`)
  for (const e of relevant.slice(0, 15)) console.log('  ' + e.slice(0, 300))
  console.log(`\n${results.filter(r => r[0] === 'PASS').length}/${results.length} steps passed`)
  if (relevant.length || results.some(r => r[0] === 'FAIL')) process.exitCode = 1
}
