// Captions on audiograms: the look and its box (kept clear of the 3Speak logo),
// the ASS file centred in the box, the ffmpeg graph with the captions drawn
// over everything, and real ffmpeg runs that show the words in the picture.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agcaptions-'))
const rendered = path.join(dir, 'rendered')
fs.mkdirSync(rendered, { recursive: true })
process.env.RENDERED_DIR = rendered
process.env.WORK_DIR = path.join(dir, 'work')
process.env.UPLOAD_DIR = path.join(dir, 'uploads')
process.env.EDITOR_TOKEN_SECRET = 'test-secret'

const AC = await import('../src/utils/audiogramCaptions.js')
const { audiogramArgs, cleanAudiogramStyle, cleanAudiogramOptions } = await import('../src/services/audiogram.js')
const { defaultLayers } = await import('../src/services/audiogramPage.js')
const { audiogramCaptionsOf, audiogramCaptionsFilter } = await import('../src/services/audiogramCaptionBurn.js')
const { hasAssFilter } = await import('../src/services/stt.js')

let hasFfmpeg = true
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }) } catch { hasFfmpeg = false }
const canBurn = hasFfmpeg && await hasAssFilter()
let hasChromium = false
try {
  const { chromium } = await import('playwright-core')
  const { chromiumPath } = await import('../src/services/audiogramPage.js')
  const b = await chromium.launch({ executablePath: chromiumPath(), headless: false, args: ['--headless=new', '--no-sandbox'] })
  await b.close()
  hasChromium = true
} catch {}

const SIZE = { w: 1080, h: 1920 }
const WORDS = [
  { text: 'Hello', start: 0.1, end: 0.5 }, { text: 'badadib', start: 0.55, end: 1.1 }, { text: 'fans.', start: 1.15, end: 1.5 },
  { text: 'Welcome', start: 1.9, end: 2.4 }, { text: 'back', start: 2.45, end: 2.9 }
]
const lookOn = (extra = {}) => AC.cleanAudiogramCaptionLook({ on: true, ...extra })

after(() => fs.rmSync(dir, { recursive: true, force: true }))

test('the look: off and karaoke by default, clamped, part of the audiogram style (and so of the template)', () => {
  const d = AC.cleanAudiogramCaptionLook(undefined)
  assert.equal(d.on, false)
  assert.equal(d.preset, 'karaoke')
  assert.equal(d.highlight, '#e32933')
  const l = AC.cleanAudiogramCaptionLook({ on: true, preset: 'pop', size: 40, color: 'red', font: 'Comic', boxes: { vertical: { x: 'a', y: 900, w: 5 }, 'bad key': {} } })
  assert.equal(l.preset, 'pop')
  assert.equal(l.size, 8)
  assert.equal(l.color, '#ffffff')
  assert.equal(l.font, 'Poppins')
  assert.equal(l.wordsPerPage, 1)
  assert.deepEqual(Object.keys(l.boxes), ['vertical'])
  assert.equal(l.boxes.vertical.w, 240)
  assert.equal(cleanAudiogramStyle({ captions: { on: true, preset: 'plain' } }).captions.preset, 'plain')
  assert.equal(cleanAudiogramStyle({}).captions.on, false)
})

test('the box: under the waveform when there is room, two lines high, never over the logo', () => {
  const plain = defaultLayers('vertical', false)
  const look = lookOn()
  const high = { ...plain, wave: { ...plain.wave, y: 700, h: 300 } }
  const b = AC.captionBox(look, 'vertical', SIZE, high)
  assert.equal(b.y, 700 + 300 + 24)
  assert.equal(b.h, AC.captionBlockHeight(look, SIZE))
  assert.ok(b.y + b.h <= SIZE.h * 0.85)
  // no room above the Shorts buttons (the bottom 15 %): over the waveform's middle
  const p = AC.captionBox(look, 'vertical', SIZE, plain)
  assert.ok(Math.abs(p.y + p.h / 2 - (plain.wave.y + plain.wave.h / 2)) <= 1)
  // with a picture the waveform sits low: the captions go over its middle
  const cover = defaultLayers('vertical', true)
  const c = AC.captionBox(look, 'vertical', SIZE, cover)
  assert.ok(Math.abs(c.y + c.h / 2 - (cover.wave.y + cover.wave.h / 2)) <= 1)
  // dragged onto the logo: moved clear of it
  const onLogo = { ...look, boxes: { vertical: { x: 100, y: plain.logo.y, w: 880 } } }
  const moved = AC.captionBox(onLogo, 'vertical', SIZE, plain)
  assert.ok(moved.y >= plain.logo.y + plain.logo.h || moved.y + moved.h <= plain.logo.y)
})

test('ASS: the frame, the font, each event centred in the box, the spoken word highlighted', () => {
  const look = lookOn({ boxes: { vertical: { x: 140, y: 1500, w: 800 } } })
  const box = AC.captionBox(look, 'vertical', SIZE, defaultLayers('vertical', false))
  const caps = AC.pieceCaptions(WORDS, 3, 'en')
  const ass = AC.audiogramCaptionsAss(caps, look, box, SIZE)
  assert.match(ass, /PlayResX: 1080\nPlayResY: 1920/)
  assert.match(ass, /Style: Cap,Poppins,/)
  const events = ass.split('\n').filter(l => l.startsWith('Dialogue:'))
  assert.equal(events.length, AC.audiogramCaptionEvents(caps, look, box, SIZE).length)
  assert.ok(events.length >= 4)
  assert.ok(events.every(l => l.includes(`\\pos(540,`)))
  assert.match(events[0], /\{\\c&H3329E3&\}HELLO/)
  // the box's width breaks the lines: narrow, fewer words fit on a page
  const count = (b) => AC.audiogramCaptionEvents(caps, look, b, SIZE)[0].lines.flat().length
  assert.ok(count({ ...box, w: 240 }) < count({ ...box, w: 900 }))
  // the words are kept inside the piece
  assert.equal(AC.pieceCaptions([{ text: 'late', start: 5, end: 6 }], 3), null)
  assert.equal(AC.pieceCaptions(WORDS, 1).words.length, 2)
})

test('the request: captions only when the look is on and there are words', () => {
  const on = cleanAudiogramOptions({ start: 0, duration: 3, style: { captions: { on: true } } })
  const off = cleanAudiogramOptions({ start: 0, duration: 3, style: {} })
  assert.equal(audiogramCaptionsOf(on.style, { words: WORDS }, 3).words.length, 5)
  assert.equal(audiogramCaptionsOf(off.style, { words: WORDS }, 3), null)
  assert.equal(audiogramCaptionsOf(on.style, { words: [] }, 3), null)
  assert.equal(audiogramCaptionsOf(on.style, undefined, 3), null)
})

test('ffmpeg graph: the captions are drawn last, before the fades', () => {
  const style = cleanAudiogramStyle({ captions: { on: true } })
  const args = audiogramArgs({ input: 'a.mp3', below: 'b.png', box: { cx: 540, cy: 1300, w: 900, h: 300, r: 0 }, output: 'o.mp4', start: 0, duration: 3, style, captionsFilter: "ass=filename='/x/captions.ass'" })
  const graph = args[args.indexOf('-filter_complex') + 1]
  assert.match(graph, /\[bw\]ass=filename='\/x\/captions\.ass',fade=t=in/)
  const plain = audiogramArgs({ input: 'a.mp3', below: 'b.png', box: { cx: 540, cy: 1300, w: 900, h: 300, r: 0 }, output: 'o.mp4', start: 0, duration: 3, style })
  assert.ok(!plain[plain.indexOf('-filter_complex') + 1].includes('ass='))
})

const gray = (f, t) => execFileSync('ffmpeg', ['-loglevel', 'error', '-ss', String(t), '-i', f, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 64 << 20 })
const changed = (a, b, box) => {
  let n = 0
  for (let y = box.y; y < box.y + box.h; y++) for (let x = Math.max(0, box.x); x < Math.min(1080, box.x + box.w); x++) if (Math.abs(a[y * 1080 + x] - b[y * 1080 + x]) > 40) n++
  return n
}

test('a real audiogram graph through ffmpeg: words in the caption box, nothing outside it', { skip: !canBurn, timeout: 120000 }, async () => {
  const audio = path.join(dir, 'piece.mp3')
  const still = path.join(dir, 'below.png')
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=300:d=4', '-c:a', 'libmp3lame', audio])
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x0a0b12:s=1080x1920', '-frames:v', '1', still])
  const style = cleanAudiogramStyle({ captions: { on: true, boxes: { vertical: { x: 140, y: 1500, w: 800 } } } })
  const layers = style.layouts.vertical
  const jobDir = fs.mkdtempSync(path.join(dir, 'job-'))
  const captions = audiogramCaptionsOf(style, { words: WORDS }, 3)
  const filter = await audiogramCaptionsFilter({ captions, style, format: 'vertical', size: SIZE, layers, jobDir })
  assert.match(filter, /^ass=filename='/)
  const box = AC.captionBox(style.captions, 'vertical', SIZE, layers)
  const make = (out, captionsFilter) => execFileSync('ffmpeg', audiogramArgs({ input: audio, below: still, box: null, output: out, start: 0, duration: 3, style, captionsFilter }))
  const withOut = path.join(dir, 'with.mp4')
  const without = path.join(dir, 'without.mp4')
  make(withOut, filter)
  make(without, null)
  const a = gray(withOut, 1.5)
  const b = gray(without, 1.5)
  assert.ok(changed(a, b, box) > 500, 'the words show in the box')
  assert.equal(changed(a, b, { x: 0, y: 0, w: 1080, h: box.y - 40 }), 0, 'nothing above the box')
})

test('the route makes an audiogram with captions (stills by Chromium)', { skip: !(canBurn && hasChromium), timeout: 180000 }, async () => {
  const express = (await import('express')).default
  const { audiogramRouter } = await import('../src/routes/audiogram.js')
  const app = express()
  app.use(express.json())
  app.use('/api/audiogram', audiogramRouter)
  const server = app.listen(0)
  await new Promise(r => server.once('listening', r))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=300:d=6', '-c:a', 'libmp3lame', path.join(rendered, 'episode.mp3')])
    const mid = Buffer.from(JSON.stringify({ u: 'badadib', exp: Date.now() + 60000 })).toString('base64url')
    const token = `v1.${mid}.${crypto.createHmac('sha256', 'test-secret').update(mid).digest('hex')}`
    const r = await fetch(`${base}/api/audiogram`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ url: '/rendered/episode.mp3', start: 1, duration: 3, title: 'badadib live', style: { captions: { on: true } }, captions: { words: WORDS, language: 'en' } })
    })
    const { jobId } = await r.json()
    let s
    for (let i = 0; i < 200; i++) {
      s = await (await fetch(`${base}/api/audiogram/${jobId}`)).json()
      if (s.status !== 'processing') break
      await new Promise(res => setTimeout(res, 250))
    }
    assert.equal(s.status, 'completed', s.error)
    assert.ok(fs.existsSync(path.join(rendered, path.basename(s.outputUrl))))
  } finally {
    server.close()
  }
})
