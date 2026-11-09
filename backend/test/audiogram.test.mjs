// Audiogram: the share video of a piece of an exported episode (option and
// layout checks, the ffmpeg graph, and a real render through the route).
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let hasFfmpeg = true
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }) } catch { hasFfmpeg = false }
// The stills need Chromium (playwright-core; CHROMIUM_PATH points at one locally)
let hasChromium = false
try {
  const { chromium } = await import('playwright-core')
  const { chromiumPath } = await import('../src/services/audiogramPage.js')
  const b = await chromium.launch({ executablePath: chromiumPath(), headless: false, args: ['--headless=new', '--no-sandbox'] })
  await b.close()
  hasChromium = true
} catch {}
const canRender = hasFfmpeg && hasChromium
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audiogram-'))
const rendered = path.join(dir, 'rendered')
fs.mkdirSync(rendered, { recursive: true })
process.env.RENDERED_DIR = rendered
process.env.WORK_DIR = path.join(dir, 'work')
process.env.UPLOAD_DIR = path.join(dir, 'uploads')
process.env.EDITOR_TOKEN_SECRET = 'test-secret'
const express = (await import('express')).default
const { audiogramRouter } = await import('../src/routes/audiogram.js')
const { cleanAudiogramOptions, cleanAudiogramStyle, cleanImageUrl, audiogramArgs, pageState, waveFilter, AUDIOGRAM_MAX_SECONDS } = await import('../src/services/audiogram.js')
const { cleanLayers, defaultLayers, audiogramPageHtml, renderStills } = await import('../src/services/audiogramPage.js')
const { imageDataUri } = await import('../src/routes/audiogram.js')

const mint = (u) => {
  const mid = Buffer.from(JSON.stringify({ u, exp: Date.now() + 60000 })).toString('base64url')
  return `v1.${mid}.${crypto.createHmac('sha256', 'test-secret').update(mid).digest('hex')}`
}
let server, base
before(async () => {
  const app = express()
  app.use(express.json())
  app.use('/api/audiogram', audiogramRouter)
  server = app.listen(0)
  await new Promise(r => server.once('listening', r))
  base = `http://127.0.0.1:${server.address().port}`
  if (hasFfmpeg) execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=300:d=20', '-c:a', 'libmp3lame', path.join(rendered, 'episode.mp3')])
})
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }) })

const post = async (body) => {
  const r = await fetch(`${base}/api/audiogram`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${mint('alice')}` }, body: JSON.stringify(body) })
  return [r.status, await r.json()]
}

describe('audiogram options and look', () => {
  test('cleanAudiogramOptions: 3 seconds to 2 minutes from 0 on, vertical unless square', () => {
    const o = cleanAudiogramOptions({ start: 12.34567, duration: 95, title: '  My   episode ' })
    assert.equal(o.start, 12.346)
    assert.equal(o.duration, 95)
    assert.equal(o.format, 'vertical')
    assert.equal(o.title, 'My episode')
    assert.equal(cleanAudiogramOptions({ start: 0, duration: 30, format: 'square' }).format, 'square')
    assert.equal(AUDIOGRAM_MAX_SECONDS, 120)
    for (const bad of [{ start: -1, duration: 10 }, { start: 0, duration: 2 }, { start: 0, duration: 121 }, { start: 'a', duration: 10 }, {}]) {
      assert.ok(cleanAudiogramOptions(bad).error, JSON.stringify(bad))
    }
  })

  test('cleanAudiogramStyle: defaults for anything missing or wrong', () => {
    const d = cleanAudiogramStyle({})
    assert.deepEqual(d.wave, { type: 'bars', color: '#e32933' })
    assert.deepEqual(d.background, { image: null, imageLayout: 'blur' })
    assert.equal(d.line, 'Full episode on *3speak.tv*')
    assert.equal(d.layouts.vertical.cover.on, false, 'no picture: no cover in the first arrangement')
    const s = cleanAudiogramStyle({ format: 'square', duration: 500, wave: { type: 'nope', color: 'red' }, background: { image: 'javascript:alert(1)', imageLayout: 'x' }, line: 'x'.repeat(300) })
    assert.equal(s.format, 'square')
    assert.equal(s.duration, 120)
    assert.deepEqual(s.wave, { type: 'bars', color: '#e32933' })
    assert.equal(s.background.image, null)
    assert.equal(s.line.length, 120)
    const withPic = cleanAudiogramStyle({ background: { image: 'https://images.example/cover.jpg' } })
    assert.equal(withPic.layouts.vertical.cover.on, true, 'a picture: the cover card in the first arrangement')
  })

  test('cleanImageUrl: our uploads and https pictures only', () => {
    assert.equal(cleanImageUrl('/api/upload/files/abc.png'), '/api/upload/files/abc.png')
    assert.equal(cleanImageUrl('https://3speak-editor-api.okinoko.io/api/upload/files/abc.png'), 'https://3speak-editor-api.okinoko.io/api/upload/files/abc.png')
    assert.equal(cleanImageUrl('http://localhost:3104/api/upload/files/abc.png'), 'http://localhost:3104/api/upload/files/abc.png')
    assert.equal(cleanImageUrl('https://images.hive.blog/0x0/cover.jpg'), 'https://images.hive.blog/0x0/cover.jpg')
    for (const bad of ['http://169.254.169.254/latest', 'file:///etc/passwd', 'data:image/png;base64,AAA', '/api/upload/files/../x', 'https://u:p@x.example/a.png', '', 5, null]) {
      assert.equal(cleanImageUrl(bad), null, String(bad))
    }
  })

  test('cleanLayers: boxes kept inside the frame, at least 16 px, the rest from the default', () => {
    const l = cleanLayers({ title: { x: -5000, y: 99999, w: 2, h: 99999, z: 99, on: false }, wave: 'nope' }, 'vertical', true)
    assert.deepEqual(l.title, { x: 0, y: 1904, w: 16, h: 1920, z: 20, on: false })
    assert.deepEqual(l.wave, defaultLayers('vertical', true).wave)
    assert.deepEqual(Object.keys(l).sort(), ['cover', 'line', 'logo', 'title', 'wave'])
  })

  test('the first arrangements keep vertical text clear of the Shorts buttons (top 12 %, bottom 15 %)', () => {
    for (const withCover of [true, false]) {
      const l = defaultLayers('vertical', withCover)
      for (const id of ['logo', 'title', 'line']) {
        assert.ok(l[id].y >= 0.12 * 1920 && l[id].y + l[id].h <= 0.85 * 1920, `${id} ${JSON.stringify(l[id])}`)
      }
    }
  })
})

describe('the ffmpeg graph', () => {
  const style = cleanAudiogramStyle({})
  test('cut from start, waveform between the two stills', () => {
    const args = audiogramArgs({ input: '/in.mp3', below: '/b.png', above: '/a.png', box: { x: 90, y: 1440, w: 900, h: 180 }, output: '/o.mp4', start: 5, duration: 15, style })
    assert.deepEqual(args.slice(args.indexOf('-ss'), args.indexOf('-ss') + 6), ['-ss', '5', '-t', '15', '-i', '/in.mp3'])
    assert.ok(args.includes('/b.png') && args.includes('/a.png'))
    const graph = args[args.indexOf('-filter_complex') + 1]
    assert.match(graph, /\[bg\]\[wave\]overlay=x=90:y=1440/)
    assert.match(graph, /\[bw\]\[top\]overlay/)
    assert.equal(args.at(-1), '/o.mp4')
  })

  test('nothing over the waveform: one still; waveform off: no waveform', () => {
    const one = audiogramArgs({ input: '/in', below: '/b.png', box: { x: 0, y: 0, w: 100, h: 100 }, output: '/o', start: 0, duration: 5, style })
    assert.doesNotMatch(one[one.indexOf('-filter_complex') + 1], /\[top\]/)
    const none = audiogramArgs({ input: '/in', below: '/b.png', box: null, output: '/o', start: 0, duration: 5, style })
    assert.doesNotMatch(none[none.indexOf('-filter_complex') + 1], /showwaves/)
  })

  test('each waveform kind has its filter', () => {
    assert.match(waveFilter('bars', 900, 180, '#ffffff'), /aeval=abs.*showwaves=s=38x180.*flags=neighbor.*drawgrid/)
    assert.match(waveFilter('centered', 900, 180, '#ffffff'), /mode=cline/)
    assert.match(waveFilter('line', 900, 180, '#ffffff'), /mode=line/)
    assert.match(waveFilter('dots', 900, 180, '#ffffff'), /mode=p2p/)
  })

  test('the page is static and builds itself from the state', () => {
    const html = audiogramPageHtml()
    assert.match(html, /window\.applyAudiogram/)
    assert.doesNotMatch(html, /fonts\.googleapis/, 'the render page loads nothing')
    assert.match(audiogramPageHtml({ preview: true }), /audiogram-state/)
    const st = pageState({ format: 'square', title: 'T', style, image: null })
    assert.deepEqual([st.width, st.height], [1080, 1080])
    assert.equal(st.layers, style.layouts.square)
  })
})

test('the picture: our own upload from the disk; no private hosts, no http, no other files', async () => {
  fs.mkdirSync(process.env.UPLOAD_DIR, { recursive: true })
  fs.writeFileSync(path.join(process.env.UPLOAD_DIR, 'pic.png'), Buffer.from('89504e470d0a1a0a', 'hex'))
  assert.match(await imageDataUri('/api/upload/files/pic.png'), /^data:image\/png;base64,iVBORw0KGgo/)
  assert.match(await imageDataUri('https://backend.example/api/upload/files/pic.png'), /^data:image\/png/)
  assert.equal(await imageDataUri('https://127.0.0.1/x.png'), null)
  assert.equal(await imageDataUri('https://localhost/x.png'), null)
  assert.equal(await imageDataUri('http://example.com/x.png'), null)
  fs.writeFileSync(path.join(process.env.UPLOAD_DIR, 'notes.txt'), 'x')
  assert.equal(await imageDataUri('/api/upload/files/notes.txt'), null)
})

test('stills: the layers over the waveform go on a transparent second still', { skip: !hasChromium }, async () => {
  const style = cleanAudiogramStyle({ layouts: { vertical: { title: { z: 9 }, line: { z: 1 } } } })
  const st = pageState({ format: 'vertical', title: 'Over the wave', style, image: null })
  const r = await renderStills({ state: st, belowFile: path.join(dir, 'below.png'), aboveFile: path.join(dir, 'above.png') })
  assert.equal(r.above, path.join(dir, 'above.png'))
  assert.deepEqual(r.box, { x: 90, y: 1120, w: 900, h: 360 })
  assert.ok(fs.statSync(r.below).size > 1000)
  const flat = cleanAudiogramStyle({ layouts: { vertical: { title: { z: 0 }, line: { z: 0 }, logo: { z: 0 } } } })
  const r2 = await renderStills({ state: pageState({ format: 'vertical', title: 'x', style: flat, image: null }), belowFile: path.join(dir, 'b2.png'), aboveFile: path.join(dir, 'a2.png') })
  assert.equal(r2.above, null, 'nothing over the waveform: no second still')
})

test('the route renders an MP4 of the asked piece from our own export', { skip: !canRender }, async () => {
  const [status, { jobId }] = await post({ url: 'https://elsewhere.example/rendered/episode.mp3?x=1', start: 4, duration: 6, format: 'square', title: 'Episode: "quotes", <b>tags</b> and \\ backslashes' })
  assert.equal(status, 200)
  let job
  for (let i = 0; i < 600; i++) {
    job = await (await fetch(`${base}/api/audiogram/${jobId}`)).json()
    if (job.status !== 'processing') break
    await new Promise(r => setTimeout(r, 100))
  }
  assert.equal(job.status, 'completed', job.error)
  assert.match(job.outputUrl, /^\/rendered\/audiogram-[0-9a-f-]+\.mp4$/)
  const out = path.join(rendered, path.basename(job.outputUrl))
  const p = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height:format=duration', '-of', 'json', out], { encoding: 'utf8' }))
  assert.deepEqual(p.streams.map(s => s.codec_name).sort(), ['aac', 'h264'])
  assert.equal(p.streams.find(s => s.codec_name === 'h264').width, 1080)
  assert.ok(Math.abs(+p.format.duration - 6) < 0.15, `duration ${p.format.duration}`)
  assert.equal(fs.readdirSync(rendered).filter(f => f.includes('.part')).length, 0, 'no part file left')
})

test('the route serves the preview page and refuses bad options and unknown jobs', async () => {
  const page = await fetch(`${base}/api/audiogram/page`)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /applyAudiogram/)
  const d = await (await fetch(`${base}/api/audiogram/defaults`)).json()
  assert.equal(d.maxSeconds, 120)
  assert.equal(d.style.wave.type, 'bars')
  assert.equal(d.coverLayouts.vertical.cover.on, true)
  assert.equal((await post({ start: 0, duration: 10 }))[0], 400)
  assert.equal((await post({ url: '/rendered/episode.mp3', start: 0, duration: 121 }))[0], 400)
  assert.equal((await fetch(`${base}/api/audiogram/nope`)).status, 404)
})

test('a missing file fails the job with a message, not the server', { skip: !hasFfmpeg }, async () => {
  const [, { jobId }] = await post({ url: '/rendered/gone.mp3', start: 0, duration: 5 })
  let job
  for (let i = 0; i < 100; i++) {
    job = await (await fetch(`${base}/api/audiogram/${jobId}`)).json()
    if (job.status !== 'processing') break
    await new Promise(r => setTimeout(r, 100))
  }
  assert.equal(job.status, 'failed')
  assert.ok(job.error)
})
