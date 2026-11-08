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
  env: { ...process.env, PORT: String(BACKEND_PORT), EDITOR_TOKEN_SECRET: SECRET, UPLOAD_DIR: path.join(DATA, 'uploads'), UPLOADS_DIR: path.join(DATA, 'uploads'), RENDERED_DIR: path.join(DATA, 'rendered'), WORK_DIR: path.join(DATA, 'work') },
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
    for (const want of ['Cut silences', 'Your template', 'Level and duck', 'Chapters', 'Export']) assert.ok(titles.includes(want), `tour step ${want} in ${titles.join(', ')}`)
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
    assert.equal(await frame.getByRole('button', { name: 'Level loudness' }).getAttribute('aria-pressed'), 'true')
    assert.match(await frame.getByRole('button', { name: 'Level loudness' }).innerText(), /Level: on/)
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

  await step('sending deletes the draft (its job is done)', async () => {
    await until(() => drafts().length === 0, 'draft deleted')
  })
  await first.ctx.close()

  await step('a new recording gets the template by itself: silences cut, intro/outro/bed placed', async () => {
    const second = await openEditor()
    const f = second.frame
    await f.getByText(/Template applied: intro, outro, music bed/).waitFor({ timeout: 30000 })
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
    await f.getByRole('radio', { name: 'Studio voice' }).click()
    await until(() => drafts().find(p => {
      const voices = clipsOf(p.state).filter(c => !c.music)
      const studio = voices.filter(c => /_dn-studio\.m4a/.test(c.url)).map(c => c.id).sort()
      return studio.join() === [...pair].sort().join()
    }), 'the grouped pair cleaned, nothing else', 60000)
    await g.ctx.close()
  })

  await step('podcast tools: chapters follow the cuts into the MP3 and the post, Studio voice on one piece, music ducked, audiogram', async () => {
    fs.rmSync(projectsDir, { recursive: true, force: true })
    const p = await openEditor()
    const f = p.frame
    await until(async () => (await f.locator('.timeline-clip-v2.audio').count()) === 1, 'recording loaded')
    await f.locator('.track-label[aria-label="Music"] input[type=file]').setInputFiles(path.join(HOST_DIR, 'bed.wav'))
    await until(async () => (await f.locator('.timeline-clip-v2.audio').count()) === 2, 'music on the Music track')
    // Duck: -12 dB from the menu
    await f.getByRole('button', { name: 'Duck music' }).click()
    await f.getByRole('radio', { name: /^-12 dB/ }).click()
    assert.match(await f.getByRole('button', { name: 'Duck music' }).innerText(), /Duck: -12 dB/)
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
    await f.getByRole('radio', { name: 'Studio voice' }).click()
    const d = await until(() => drafts().find(x => {
      const voice = clipsOf(x.state).filter(c => !c.music)
      return voice.length === 3 && voice.filter(c => /_dn-studio\.m4a/.test(c.url)).map(c => c.id).join() === firstPiece
    }), 'only that piece on the studio copy', 45000)
    assert.deepEqual(d.state.master, { loudness: true, duck: true, duckDb: -12 })
    assert.equal(d.state.chapters.length, 2)
    assert.equal(d.state.chapters[1].title, 'Second part')
    assert.ok(d.state.chapters[1].anchor && Math.abs(d.state.chapters[1].anchor.t - 3) < 0.01, 'pinned to 3 s of the recording')
    // Duck is a clip setting too: the music clip shows the top bar's -12 dB,
    // then gets its own -18 dB with the Voice track as its sidechain source
    const musicTrack = d.state.tracks.find(t => t.music)
    const voiceTrack = d.state.tracks.find(t => !t.music)
    const bedId = musicTrack.clips[0].id
    await f.locator(`.timeline-clip-v2[data-clip-id="${bedId}"]`).click()
    const duckGroup = f.getByRole('radiogroup', { name: 'Duck this clip' })
    assert.equal(await duckGroup.getByRole('radio', { name: '-12 dB' }).getAttribute('aria-checked'), 'true')
    assert.match(await f.locator('.compact-side').innerText(), /Set by Duck in the top bar/)
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
    // Audiogram of the export: vertical, the whole (short) episode, with the title
    await f.getByRole('button', { name: 'Audiogram' }).click()
    const ag = f.getByRole('dialog', { name: 'Audiogram' })
    await ag.waitFor()
    assert.equal(await ag.getByLabel('Title on the video').inputValue(), 'speech')
    await ag.getByRole('radio', { name: 'Vertical' }).click()
    assert.equal(await ag.getByRole('radio', { name: /^All/ }).getAttribute('aria-checked'), 'true', 'a short episode: all of it')
    await ag.getByRole('button', { name: 'Make audiogram' }).click()
    await ag.locator('video.audiogram-preview').waitFor({ timeout: 60000 })
    const agUrl = await ag.locator('video.audiogram-preview').getAttribute('src')
    assert.ok(agUrl.startsWith(`${BACKEND}/rendered/audiogram-`), agUrl)
    const agFile = path.join(DATA, 'rendered', path.basename(new URL(agUrl).pathname))
    const agProbe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height:format=duration', '-of', 'json', agFile], { encoding: 'utf8' }))
    const vs = agProbe.streams.find(x => x.codec_name === 'h264')
    assert.deepEqual([vs.width, vs.height], [1080, 1920])
    assert.ok(agProbe.streams.some(x => x.codec_name === 'aac'))
    assert.ok(await ag.getByRole('link', { name: 'Download' }).isVisible())
    await ag.getByTitle('Close').click()
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
    assert.ok(Math.abs(post.chapters.at(-1).end - post.durationSec) < 0.01, 'the last chapter runs to the end')
    // ID3 chapters in the MP3 itself
    const mp3 = path.join(DATA, 'rendered', path.basename(new URL(post.outputUrl).pathname))
    const { chapters } = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_chapters', '-of', 'json', mp3], { encoding: 'utf8' }))
    assert.deepEqual(chapters.map(c => c.tags.title), ['Intro', 'Second part'])
    assert.ok(Math.abs(+chapters[1].start_time - second.start) < 0.01)
    await p.ctx.close()
  })

  await step('recording a voice: live graph, full length in the preview, Use puts it on the Voice track with its length', async () => {
    // no template: the take sits at 0 on its own
    fs.rmSync(templateFile, { force: true })
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
    await f.locator('.multi-clip-panel').getByRole('radio', { name: 'Studio voice' }).click()
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
