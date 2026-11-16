// Looks (utils/clipLook.js, utils/lookFx.js) through the real render pipeline:
// presets, split tone, blur, vignette and sharpen on video, image (with
// transparency) and keyed clips. Needs ffmpeg on PATH; skipped without it.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let hasFfmpeg = true
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }) } catch { hasFfmpeg = false }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'looks-'))
process.env.WORK_DIR = dir
const { buildAndRunFFmpeg } = await import('../src/services/ffmpeg.js')
const { fxGeometry, clipFxFilter } = await import('../src/utils/lookFx.js')
const { applyPreset } = await import('../src/utils/clipLook.js')
after(() => fs.rmSync(dir, { recursive: true, force: true }))

const W = 180, H = 320
const ff = (...args) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...args])
const grey = path.join(dir, 'grey.mp4')
const detail = path.join(dir, 'detail.mp4')
const sticker = path.join(dir, 'sticker.png')
const green = path.join(dir, 'green.mp4')
if (hasFfmpeg) {
  ff('-f', 'lavfi', '-i', `color=c=0x808080:s=${W}x${H}:r=30:d=1`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', grey)
  ff('-f', 'lavfi', '-i', `testsrc2=s=${W}x${H}:r=30:d=1`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', detail)
  ff('-f', 'lavfi', '-i', 'color=c=white@0.0:s=64x64,format=rgba,drawbox=x=16:y=16:w=32:h=32:color=red@1:t=fill', '-frames:v', '1', sticker)
  ff('-f', 'lavfi', '-i', `color=c=0x00ff00:s=${W}x${H}:r=30:d=1`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', green)
}

async function render(name, clips, files) {
  const tracks = [{ id: 'v', type: 'video', clips }]
  const jobDir = path.join(dir, name); fs.mkdirSync(jobDir, { recursive: true })
  const out = path.join(dir, `${name}.mp4`)
  await buildAndRunFFmpeg({ timeline: { outputWidth: W, outputHeight: H, previewWidth: W, previewHeight: H, fps: 30, tracks }, downloadedFiles: new Map(files), outputPath: out, jobDir, onProgress: () => {} })
  return out
}
const frame = (f, t = 0.5) => execFileSync('ffmpeg', ['-loglevel', 'error', '-ss', String(t), '-i', f, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 24 })
const px = (buf, x, y) => { const i = (y * W + x) * 3; return [buf[i], buf[i + 1], buf[i + 2]] }
const luma = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b
// sum of differences between neighbours: drops when the picture is blurred
const detailOf = (buf) => { let s = 0; for (let y = 0; y < H; y++) for (let x = 1; x < W; x++) s += Math.abs(buf[(y * W + x) * 3] - buf[(y * W + x - 1) * 3]); return s }
const vclip = (id, extra = {}) => ({ id, type: 'video', name: id, url: 'x', startTime: 0, endTime: 1, duration: 1, timelinePosition: 0, audioEnabled: false, ...extra })

test('vignette: geometry follows the preview (picture vs canvas, layout boxes)', () => {
  assert.deepEqual(fxGeometry({ layout: { x: 0, y: 0, w: 0.5, h: 0.5 } }, 1080, 1920), { frameH: 960, zoom: 1, vignetteScale: 1 })
  // a 16:9 picture in a 9:16 canvas spans a smaller diagonal than the canvas
  const g = fxGeometry({ zoom: 150 }, 1080, 1920, { width: 1920, height: 1080 })
  assert.equal(g.zoom, 1.5)
  assert.ok(g.vignetteScale > 0.4 && g.vignetteScale < 0.6, String(g.vignetteScale))
  assert.equal(fxGeometry({}, 1080, 1920, { width: 1080, height: 1920 }).vignetteScale, 1)
})

test('no look, no extra filters', async () => {
  assert.equal(await clipFxFilter({ look: null }, null, W, H), '')
  assert.equal(await clipFxFilter({ look: { split: 40 } }, null, W, H), '')
})

test('a vignette darkens the corners and leaves the centre', { skip: !hasFfmpeg, timeout: 60000 }, async () => {
  const plain = frame(await render('plain', [vclip('a')], [['a', grey]]))
  const vig = frame(await render('vig', [vclip('a', { look: { vignette: 100 } })], [['a', grey]]))
  assert.ok(Math.abs(luma(px(vig, W / 2, H / 2)) - luma(px(plain, W / 2, H / 2))) < 6, 'centre unchanged')
  assert.ok(luma(px(vig, 2, 2)) < luma(px(plain, 2, 2)) - 40, 'corner darker')
})

test('blur softens and sharpen crisps the picture', { skip: !hasFfmpeg, timeout: 60000 }, async () => {
  const plain = detailOf(frame(await render('d-plain', [vclip('a')], [['a', detail]])))
  const blur = detailOf(frame(await render('d-blur', [vclip('a', { look: { blur: 100 } })], [['a', detail]])))
  const sharp = detailOf(frame(await render('d-sharp', [vclip('a', { look: { sharpen: 80 } })], [['a', detail]])))
  assert.ok(blur < plain * 0.75, `blur ${blur} vs ${plain}`)
  assert.ok(sharp > plain * 1.1, `sharpen ${sharp} vs ${plain}`)
})

test('a preset (B&W) and the teal and orange split tone change the colours', { skip: !hasFfmpeg, timeout: 60000 }, async () => {
  const bw = applyPreset('bw')
  const [r, g, b] = px(frame(await render('bw', [vclip('a', { color: bw.color, look: bw.look })], [['a', detail]])), 60, 100)
  assert.ok(Math.abs(r - g) < 8 && Math.abs(g - b) < 8, `grey: ${r} ${g} ${b}`)
  const to = frame(await render('teal', [vclip('a', { look: { split: 100 } })], [['a', grey]]))
  const plain = frame(await render('teal-plain', [vclip('a')], [['a', grey]]))
  assert.notDeepEqual(px(to, W / 2, H / 2), px(plain, W / 2, H / 2))
})

test('an image keeps its transparency under a vignette and blur; a keyed clip takes a look too', { skip: !hasFfmpeg, timeout: 90000 }, async () => {
  const clips = [
    vclip('bg'),
    { id: 's', type: 'image', name: 's', url: 'x', startTime: 0, endTime: 1, duration: 1, timelinePosition: 0, zoom: 100, look: { vignette: 80, blur: 10 } }
  ]
  const tracks = [{ id: 'top', type: 'video', clips: [clips[1]] }, { id: 'bottom', type: 'video', clips: [clips[0]] }]
  const jobDir = path.join(dir, 'img'); fs.mkdirSync(jobDir)
  const out = path.join(dir, 'img.mp4')
  await buildAndRunFFmpeg({ timeline: { outputWidth: W, outputHeight: H, previewWidth: W, previewHeight: H, fps: 30, tracks }, downloadedFiles: new Map([['bg', grey], ['s', sticker]]), outputPath: out, jobDir, onProgress: () => {} })
  const f = frame(out)
  // the grey background shows around the sticker (its transparent part stayed transparent)
  assert.ok(Math.abs(luma(px(f, 5, 5)) - 128) < 12, `background at the corner: ${px(f, 5, 5)}`)
  const keyed = frame(await render('keyed', [vclip('k', { chromaKey: { color: 'green', similarity: 0.3, blend: 0.1 }, look: { vignette: 50, sharpen: 20 } })], [['k', green]]))
  assert.ok(luma(px(keyed, W / 2, H / 2)) < 40, 'green keyed out over the black base')
})
