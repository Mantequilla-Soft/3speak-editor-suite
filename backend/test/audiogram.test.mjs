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
const { cleanAudiogramOptions, cleanAudiogramStyle, cleanImageUrl, audiogramArgs, pageState, waveFilter, circleMaps, circleGeometry, AUDIOGRAM_MAX_SECONDS } = await import('../src/services/audiogram.js')
const { cleanLayers, defaultLayers, audiogramPageHtml, renderStills, waveBox, logoBox, LOGO_STYLES } = await import('../src/services/audiogramPage.js')
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
  test('cleanAudiogramOptions: 3 seconds to 2 minutes from 0 on, always vertical', () => {
    const o = cleanAudiogramOptions({ start: 12.34567, duration: 95, title: '  My   episode ' })
    assert.equal(o.start, 12.346)
    assert.equal(o.duration, 95)
    assert.equal(o.format, 'vertical')
    assert.equal(o.title, 'My episode')
    assert.equal(cleanAudiogramOptions({ start: 0, duration: 30, format: 'square' }).format, 'vertical', 'no square any more: Shorts are vertical')
    assert.equal(AUDIOGRAM_MAX_SECONDS, 120)
    for (const bad of [{ start: -1, duration: 10 }, { start: 0, duration: 2 }, { start: 0, duration: 121 }, { start: 'a', duration: 10 }, {}]) {
      assert.ok(cleanAudiogramOptions(bad).error, JSON.stringify(bad))
    }
  })

  test('cleanAudiogramStyle: defaults for anything missing or wrong', () => {
    const d = cleanAudiogramStyle({})
    assert.deepEqual(d.wave, { type: 'bars', color: '#e32933' })
    assert.deepEqual(d.background, { image: null, imageLayout: 'card' })
    assert.equal(d.logo, 'full')
    assert.equal(cleanAudiogramStyle({ logo: 'mark' }).logo, 'mark')
    assert.equal(cleanAudiogramStyle({ logo: 'nope' }).logo, 'full')
    assert.equal(d.line, 'Full episode on *3speak.tv*')
    assert.equal(d.layouts.vertical.cover.on, false, 'no picture: no cover in the first arrangement')
    const s = cleanAudiogramStyle({ format: 'square', duration: 500, wave: { type: 'nope', color: 'red' }, background: { image: 'javascript:alert(1)', imageLayout: 'x' }, line: 'x'.repeat(300) })
    assert.equal(s.format, 'vertical')
    assert.deepEqual(Object.keys(s.layouts), ['vertical'])
    assert.equal(s.duration, 120)
    assert.deepEqual(s.wave, { type: 'bars', color: '#e32933' })
    assert.equal(s.background.image, null)
    assert.equal(s.line.length, 120)
    for (const type of ['bars', 'centered', 'line', 'dots', 'circle', 'ring']) assert.equal(cleanAudiogramStyle({ wave: { type } }).wave.type, type)
    for (const imageLayout of ['card', 'blur', 'fill']) assert.equal(cleanAudiogramStyle({ background: { imageLayout } }).background.imageLayout, imageLayout)
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

  test('cleanLayers: boxes kept inside the frame, at least 16 px, turned -180..180, the rest from the default', () => {
    const l = cleanLayers({ title: { x: -5000, y: 99999, w: 2, h: 99999, z: 99, r: 370.4, on: false }, line: { r: -190 }, wave: 'nope' }, 'vertical', true)
    assert.deepEqual(l.title, { x: 0, y: 1904, w: 16, h: 1920, z: 19, r: 10, on: false })
    assert.equal(l.line.r, 170)
    assert.deepEqual(l.wave, defaultLayers('vertical', true).wave)
    assert.deepEqual(Object.keys(l).sort(), ['cover', 'line', 'logo', 'title', 'wave'])
  })

  test('the 3Speak logo can not be hidden, shrunk away, squeezed thin, pushed out or covered', () => {
    const l = cleanLayers({ logo: { x: -900, y: 5000, w: 3, h: 3, z: 0, r: 30, on: false } }, 'vertical', false)
    assert.deepEqual(l.logo, { x: 0, y: 1920 - 64, w: 320, h: 64, z: 20, r: 30, on: true })
    // a wide, flat box (the logo would be tiny in it) gets the logo's shape, around the same middle
    const flat = cleanLayers({ logo: { x: 0, y: 500, w: 1080, h: 30 } }, 'vertical', false).logo
    assert.deepEqual([flat.w, flat.h, flat.x + flat.w / 2, flat.y + flat.h / 2], [320, 64, 540, 515])
    // the 3S only: square-ish, at least 120 high
    const mark = cleanLayers({ logo: { x: 100, y: 100, w: 10, h: 10 } }, 'vertical', false, 'mark').logo
    assert.deepEqual([mark.w, mark.h], [138, 120])
    assert.deepEqual(defaultLayers('vertical', true, 'mark').logo, { on: true, r: 0, x: 460, y: 206, w: 161, h: 140, z: 20 })
    for (const [style, s] of Object.entries(LOGO_STYLES)) {
      const box = logoBox(style, { cx: 540, cy: 960, h: 99999 }, { w: 1080, h: 1920 })
      assert.ok(box.w <= 1080 && box.x >= 0 && Math.abs(box.w / box.h - s.aspect) < 0.02, `${style} ${JSON.stringify(box)}`)
    }
    assert.ok(Object.entries(l).every(([id, b]) => id === 'logo' || b.z < l.logo.z))
    assert.equal(defaultLayers('vertical', true).logo.z, 20)
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
    const args = audiogramArgs({ input: '/in.mp3', below: '/b.png', above: '/a.png', box: { cx: 540, cy: 1530, w: 900, h: 180, r: 0 }, output: '/o.mp4', start: 5, duration: 15, style })
    assert.deepEqual(args.slice(args.indexOf('-ss'), args.indexOf('-ss') + 6), ['-ss', '5', '-t', '15', '-i', '/in.mp3'])
    assert.ok(args.includes('/b.png') && args.includes('/a.png'))
    const graph = args[args.indexOf('-filter_complex') + 1]
    assert.match(graph, /\[bg\]\[w0\]overlay=x=540-overlay_w\/2:y=1530-overlay_h\/2/)
    assert.doesNotMatch(graph, /rotate/)
    assert.match(graph, /\[bw\]\[top\]overlay/)
    assert.equal(args.at(-1), '/o.mp4')
  })

  test('nothing over the waveform: one still; waveform off: no waveform', () => {
    const one = audiogramArgs({ input: '/in', below: '/b.png', box: { cx: 50, cy: 50, w: 100, h: 100, r: 0 }, output: '/o', start: 0, duration: 5, style })
    assert.doesNotMatch(one[one.indexOf('-filter_complex') + 1], /\[top\]/)
    const none = audiogramArgs({ input: '/in', below: '/b.png', box: null, output: '/o', start: 0, duration: 5, style })
    assert.doesNotMatch(none[none.indexOf('-filter_complex') + 1], /showwaves/)
  })

  test('a turned waveform is turned around its middle, on transparent', () => {
    const args = audiogramArgs({ input: '/in', below: '/b.png', box: { cx: 540, cy: 1300, w: 900, h: 360, r: -90 }, output: '/o', start: 0, duration: 5, style })
    assert.match(args[args.indexOf('-filter_complex') + 1], /\[w0\]rotate=a=-1\.57080:ow=rotw\(-1\.57080\):oh=roth\(-1\.57080\):c=none\[w1\];\[bg\]\[w1\]overlay=x=540-overlay_w\/2/)
  })

  test('a round waveform: its strip bent round by the two maps (inputs after the stills)', () => {
    const round = cleanAudiogramStyle({ wave: { type: 'circle' } })
    const box = { cx: 540, cy: 1300, w: 600, h: 600, r: 0 }
    const args = audiogramArgs({ input: '/in', below: '/b.png', above: '/a.png', box, maps: { x: '/x.pgm', y: '/y.pgm' }, output: '/o', start: 0, duration: 5, style: round })
    assert.deepEqual(args.slice(args.indexOf('/x.pgm') - 1, args.indexOf('/x.pgm') + 3), ['-i', '/x.pgm', '-i', '/y.pgm'])
    assert.match(args[args.indexOf('-filter_complex') + 1], /\[strip\]\[3:v\]\[4:v\]remap=fill=black@0/)
    const noMaps = audiogramArgs({ input: '/in', below: '/b.png', box, output: '/o', start: 0, duration: 5, style: round })
    assert.doesNotMatch(noMaps[noMaps.indexOf('-filter_complex') + 1], /showwaves/, 'no maps: no round waveform')
  })

  test('circleMaps: 16-bit PGMs, nothing in the middle or the corners, the band mapped and mirrored', () => {
    const side = 200
    const { x, y } = circleMaps('ring', side)
    const head = `P5\n${side} ${side}\n65535\n`
    assert.equal(x.subarray(0, head.length).toString(), head)
    assert.equal(x.length, head.length + side * side * 2)
    const at = (buf, px, py) => buf.readUInt16BE(head.length + (py * side + px) * 2)
    assert.equal(at(x, 100, 100), 65535, 'the middle is empty')
    assert.equal(at(x, 0, 0), 65535, 'the corners are empty')
    const g = circleGeometry('ring', side)
    assert.equal(at(x, 100, 2), 0, 'the top is the start of the strip')
    assert.equal(at(y, 100, 2), 0, 'the outside is row 0')
    assert.equal(at(x, 100, 197), g.cols - 1, 'the bottom is its end')
    assert.equal(at(x, 30, 100), at(x, 169, 100), 'left and right mirror each other')
    const bars = circleMaps('circle', side)
    const cols = new Set()
    for (let px = 0; px < side; px++) cols.add(at(bars.x, px, 4))
    assert.ok(cols.has(65535), 'gaps between the bars')
  })

  test('each waveform kind has its filter', () => {
    assert.match(waveFilter('bars', 900, 180, '#ffffff'), /aeval=abs.*showwaves=s=38x180.*flags=neighbor.*drawgrid/)
    assert.match(waveFilter('centered', 900, 180, '#ffffff'), /mode=cline/)
    assert.match(waveFilter('line', 900, 180, '#ffffff'), /mode=line/)
    assert.match(waveFilter('dots', 900, 180, '#ffffff'), /mode=p2p/)
    assert.match(waveFilter('circle', 600, 600, '#ffffff'), /aeval=abs.*showwaves=s=48x\d+:mode=cline.*crop=48:/)
    assert.match(waveFilter('ring', 600, 600, '#ffffff'), /lowpass.*showwaves=s=200x\d+:mode=p2p/)
  })

  test('the page is static and builds itself from the state', () => {
    const html = audiogramPageHtml()
    assert.match(html, /window\.applyAudiogram/)
    assert.doesNotMatch(html, /fonts\.googleapis/, 'the render page loads nothing')
    assert.match(audiogramPageHtml({ preview: true }), /audiogram-state/)
    assert.match(html, /state\.logo === 'mark' \? '' : '<span>3Speak<\/span>'/)
    assert.equal(pageState({ format: 'vertical', title: 'T', style: cleanAudiogramStyle({ logo: 'mark' }), image: null }).logo, 'mark')
    const st = pageState({ format: 'square', title: 'T', style, image: null })
    assert.deepEqual([st.width, st.height], [1080, 1920])
    assert.equal(st.layers, style.layouts.vertical)
  })

  test('waveBox: placed by its middle; the round ones square', () => {
    assert.deepEqual(waveBox({ x: 90, y: 1120, w: 900, h: 361, r: 12, on: true }, 'bars'), { cx: 540, cy: 1301, w: 900, h: 362, r: 12 })
    assert.deepEqual(waveBox({ x: -200, y: 1000, w: 900, h: 500 }, 'ring'), { cx: 250, cy: 1250, w: 500, h: 500, r: 0 })
    assert.equal(waveBox({ x: 0, y: 0, w: 100, h: 100, on: false }, 'bars'), null)
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
  assert.deepEqual(r.box, { cx: 540, cy: 1300, w: 900, h: 360, r: 0 })
  assert.ok(fs.statSync(r.below).size > 1000)
  const flat = cleanAudiogramStyle({ layouts: { vertical: { title: { z: 0 }, line: { z: 0 }, logo: { z: 0 } } } })
  const r2 = await renderStills({ state: pageState({ format: 'vertical', title: 'x', style: flat, image: null }), belowFile: path.join(dir, 'b2.png'), aboveFile: path.join(dir, 'a2.png') })
  assert.ok(r2.above, 'the logo is always over the waveform')
})

test('the logo grows with its box, in both styles, turned too', { skip: !hasChromium }, async () => {
  const { chromium } = await import('playwright-core')
  const { chromiumPath } = await import('../src/services/audiogramPage.js')
  const b = await chromium.launch({ executablePath: chromiumPath(), headless: false, args: ['--headless=new', '--no-sandbox'] })
  try {
    const page = await b.newPage({ viewport: { width: 1080, height: 1920 } })
    await page.setContent(audiogramPageHtml())
    for (const [logo, box] of [['full', { x: 40, y: 200, w: 1000, h: 200 }], ['mark', { x: 140, y: 200, w: 690, h: 600 }], ['full', { x: 40, y: 200, w: 1000, h: 200, r: 30 }]]) {
      const style = cleanAudiogramStyle({ logo, layouts: { vertical: { logo: box } } })
      const st = pageState({ format: 'vertical', title: 'T', style, image: null })
      const m = await page.evaluate((s) => {
        window.applyAudiogram(s, 'all')
        const el = document.getElementById('l-logo')
        return { boxW: el.clientWidth, boxH: el.clientHeight, w: el.firstElementChild.offsetWidth, h: el.firstElementChild.offsetHeight }
      }, st)
      assert.ok(m.w >= m.boxW * 0.9 && m.w <= m.boxW + 1, `${logo} ${JSON.stringify(m)}: as wide as its box`)
      assert.ok(m.h >= m.boxH * 0.85, `${logo} ${JSON.stringify(m)}: about as high as its box`)
    }
  } finally {
    await b.close()
  }
})

test('the route renders an MP4 of the asked piece from our own export', { skip: !canRender }, async () => {
  const [status, { jobId }] = await post({ url: 'https://elsewhere.example/rendered/episode.mp3?x=1', start: 4, duration: 6, style: { wave: { type: 'circle' }, layouts: { vertical: { wave: { x: 240, y: 1000, w: 600, h: 600, r: 15 } } } }, title: 'Episode: "quotes", <b>tags</b> and \\ backslashes' })
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
  assert.equal(p.streams.find(s => s.codec_name === 'h264').height, 1920)
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
