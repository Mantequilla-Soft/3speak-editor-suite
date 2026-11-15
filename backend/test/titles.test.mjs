// Better text: outlines and word by word entrances (utils/textAnim.js,
// utils/textFx.js), and titles from motion scenes (services/sceneClip.js).
// The drawtext graphs run through ffmpeg with a system font; the full text
// render needs the editor's Google fonts (the Docker image), the titles need
// Chromium (playwright's or CHROMIUM_PATH): skipped without them.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let hasFfmpeg = true
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }) } catch { hasFfmpeg = false }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'titles-'))
process.env.WORK_DIR = dir
const { buildAndRunFFmpeg } = await import('../src/services/ffmpeg.js')
const { strokeOption, wordPositions, wordDrawtexts } = await import('../src/utils/textFx.js')
const { wordState, ffmpegWordExprs, normalizeTextAnim } = await import('../src/utils/textAnim.js')
const { titleDoc, titlePlacement } = await import('../src/services/sceneClip.js')
after(() => fs.rmSync(dir, { recursive: true, force: true }))

const FONT = ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/dejavu/DejaVuSans.ttf', '/usr/share/fonts/ttf-dejavu/DejaVuSans.ttf'].find(f => fs.existsSync(f))
const GOOGLE_FONTS = fs.existsSync('/usr/share/fonts/google/Roboto[wdth,wght].ttf')
// Chromium: CHROMIUM_PATH, the system's, or any playwright download
if (!process.env.CHROMIUM_PATH) {
  const cache = path.join(os.homedir(), '.cache/ms-playwright')
  const found = ['/usr/bin/chromium-browser', '/usr/bin/chromium', ...(fs.existsSync(cache) ? fs.readdirSync(cache).filter(d => /^chromium-\d+$/.test(d)).map(d => path.join(cache, d, 'chrome-linux/chrome')) : [])].find(f => fs.existsSync(f))
  if (found) process.env.CHROMIUM_PATH = found
}
const hasChromium = !!process.env.CHROMIUM_PATH && fs.existsSync(process.env.CHROMIUM_PATH)

const W = 180, H = 320
const ff = (...args) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...args])
const lit = (file, t, y0 = 0, y1 = H) => {
  const b = execFileSync('ffmpeg', ['-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 24 })
  let n = 0
  for (let i = y0 * W; i < y1 * W; i++) if (b[i] > 128) n++
  return n
}

test('outline: drawtext border sized like the preview (outside the letters)', () => {
  assert.equal(strokeOption({}, 3), '')
  assert.equal(strokeOption({ textStroke: { color: '#FF0000', width: 2 } }, 3), ':borderw=6:bordercolor=#ff0000')
})

test('word positions: measured by the editor, or estimated when they do not fit', () => {
  const measured = { wordLayout: { lines: [{ width: 100, words: [{ x: 0, w: 40 }, { x: 50, w: 50 }] }] } }
  assert.deepEqual(wordPositions(measured, ['Hello badadib'], 20), [{ width: 100, words: [{ text: 'Hello', x: 0, w: 40 }, { text: 'badadib', x: 50, w: 50 }] }])
  const est = wordPositions({}, ['ab cd'], 10)
  assert.equal(est[0].words[1].x, 3 * 5.5)
})

test('word states and their ffmpeg expressions agree', () => {
  for (const type of ['pop', 'fadeUp', 'typewriter', 'slide']) {
    const anim = { type, stagger: 0.2, duration: 0.4 }
    for (const i of [0, 2]) {
      for (const t of [0, 0.15, 0.5, 0.65, 1.5]) {
        const s = wordState(anim, i, t)
        const e = ffmpegWordExprs(anim, i)
        const ev = (x) => Function('t', 'min', 'max', 'pow', 'gte', 'lt', 'iff', `return ${x.replace(/\bif\(/g, 'iff(')}`)(t, Math.min, Math.max, Math.pow, (a, b) => (a >= b ? 1 : 0), (a, b) => (a < b ? 1 : 0), (c, a, b) => (c ? a : b))
        assert.ok(Math.abs(ev(e.alpha) - s.opacity) < 1e-6, `${type} ${i} ${t} alpha`)
        assert.ok(Math.abs(ev(e.dx) - s.dx) < 1e-6 && Math.abs(ev(e.dy) - s.dy) < 1e-6, `${type} ${i} ${t} move`)
        assert.ok(Math.abs(ev(e.scale) - s.scale) < 1e-6, `${type} ${i} ${t} scale`)
      }
    }
  }
  assert.equal(normalizeTextAnim({ type: 'typewriter', stagger: 9 }).stagger, 0.6)
})

test('per-word drawtext graph runs in ffmpeg: words appear one after another', { skip: !hasFfmpeg || !FONT, timeout: 60000 }, async () => {
  const clip = { textAnim: { type: 'pop', stagger: 0.4, duration: 0.3 }, textStroke: { color: '#000000', width: 2 }, fontSize: 20 }
  const filters = await wordDrawtexts(clip, {
    lines: ['ONE TWO THREE'], lineY: () => 140, fontSize: 30, scale: 1, w: W, padding: 20, posX: 0, hAlign: 'center',
    font: FONT, fontColor: '#ffffff', shadow: '', stroke: strokeOption(clip, 1), basePath: path.join(dir, 'words')
  })
  assert.equal(filters.length, 3)
  const out = path.join(dir, 'words.mp4')
  ff('-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=30:d=1.6`, '-vf', filters.join(','), '-pix_fmt', 'yuv420p', out)
  const a = lit(out, 0.35, 120, 200), b = lit(out, 0.75, 120, 200), c = lit(out, 1.5, 120, 200)
  assert.ok(a > 0 && b > a && c > b, `more words over time: ${a} ${b} ${c}`)
  assert.equal(lit(out, 0.0, 120, 200), 0, 'nothing at the start')
})

test('a text clip with an outline and a word entrance renders (Google fonts)', { skip: !hasFfmpeg || !GOOGLE_FONTS, timeout: 60000 }, async () => {
  const tracks = [{ id: 'v', type: 'video', clips: [{ id: 't', type: 'text', text: 'Hello badadib fans', fontSize: 30, startTime: 0, endTime: 2, timelinePosition: 0, textAlign: 'center',
    textStroke: { color: '#000000', width: 2 }, textAnim: { type: 'fadeUp', stagger: 0.3, duration: 0.3 }, wrappedLines: ['Hello badadib fans'] }] }]
  const jobDir = path.join(dir, 'text'); fs.mkdirSync(jobDir)
  const out = path.join(dir, 'text.mp4')
  await buildAndRunFFmpeg({ timeline: { outputWidth: W, outputHeight: H, previewWidth: W, previewHeight: H, fps: 30, tracks }, downloadedFiles: new Map(), outputPath: out, jobDir, onProgress: () => {} })
  assert.ok(lit(out, 1.8) > lit(out, 0.1))
})

test('titles: the doc is checked by the engine\'s schema; placement follows zoom and position', () => {
  assert.throws(() => titleDoc({}, 1080, 1920), /without a scene/)
  assert.throws(() => titleDoc({ sceneDoc: { scenes: [{ type: 'nope' }] } }, 1080, 1920))
  const doc = titleDoc({ sceneDoc: { brand: { name: 'badadib' }, scenes: [{ type: 'statement', duration: 2, lines: ['Hello'] }] } }, 1080, 1920)
  assert.equal(doc.width, 1080)
  assert.equal(doc.scenes[0].type, 'statement')
  assert.deepEqual(titlePlacement({ zoom: 100 }, 1080, 1920), { sw: 1080, sh: 1920, x: 0, y: 0 })
  assert.deepEqual(titlePlacement({ zoom: 50, positionX: -100, positionY: 200 }, 1080, 1920, 3), { sw: 540, sh: 960, x: 270 - 150, y: 480 + 300 })
})

async function renderTitle(name, transparent) {
  const red = path.join(dir, 'red.mp4')
  if (!fs.existsSync(red)) ff('-f', 'lavfi', '-i', `color=c=red:s=${W}x${H}:r=30:d=2`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', red)
  const sceneDoc = { brand: { name: 'badadib', font: 'Inter', headFont: 'Inter', colors: { bg: '#0a0b12', ink: '#f4f5f8', mute: '#9aa0b4', accent: '#ff5a36', accent2: '#5ad1c8', accent3: '#8a8cff' } },
    scenes: [{ type: 'statement', duration: 1.5, label: '', lines: ['Hello', 'badadib'] }] }
  const tracks = [
    { id: 'top', type: 'video', clips: [{ id: 's', type: 'scene', name: 'Title', startTime: 0, endTime: 1.5, duration: 1.5, timelinePosition: 0, zoom: 100, sceneDoc, transparent }] },
    { id: 'base', type: 'video', clips: [{ id: 'v', type: 'video', url: 'x', startTime: 0, endTime: 1.5, duration: 2, timelinePosition: 0, audioEnabled: false }] }
  ]
  const jobDir = path.join(dir, name); fs.mkdirSync(jobDir)
  const out = path.join(dir, `${name}.mp4`)
  await buildAndRunFFmpeg({ timeline: { outputWidth: W, outputHeight: H, previewWidth: W, previewHeight: H, fps: 30, tracks }, downloadedFiles: new Map([['v', red]]), outputPath: out, jobDir, onProgress: () => {} })
  const b = execFileSync('ffmpeg', ['-loglevel', 'error', '-ss', '1.2', '-i', out, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 24 })
  return { corner: [b[(5 * W + 5) * 3], b[(5 * W + 5) * 3 + 1], b[(5 * W + 5) * 3 + 2]], frame: b }
}

test('a title over the video keeps the video around its words; an intro card brings its own background', { skip: !hasFfmpeg || !hasChromium, timeout: 240000 }, async () => {
  const over = await renderTitle('title-over', true)
  assert.ok(over.corner[0] > 200 && over.corner[2] < 60, `red video at the corner: ${over.corner}`)
  let white = 0
  for (let i = 0; i < over.frame.length; i += 3) if (over.frame[i] > 200 && over.frame[i + 1] > 200 && over.frame[i + 2] > 200) white++
  assert.ok(white > 20, `the title's light letters are drawn: ${white}`)
  const card = await renderTitle('title-card', false)
  assert.ok(card.corner[0] < 60, `the card's dark background at the corner: ${card.corner}`)
})
