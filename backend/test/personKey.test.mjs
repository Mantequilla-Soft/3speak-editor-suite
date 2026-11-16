// Background removal without a green screen (person key): the matte file the
// editor uploads, its resampling to output frames, the filtergraph, and real
// renders through ffmpeg (skipped without ffmpeg on PATH).
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

let hasFfmpeg = true
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }) } catch { hasFfmpeg = false }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'personkey-'))
process.env.WORK_DIR = dir
const PM = await import('../src/utils/personMask.js')
const { readMaskFile, writePersonMaskStream, buildPersonKeyFilter, personKeyForSize } = await import('../src/services/personKey.js')
const { buildAndRunFFmpeg } = await import('../src/services/ffmpeg.js')
after(() => fs.rmSync(dir, { recursive: true, force: true }))

// A matte track: frames of w x h, `fill(frameIndex, x, y)` -> 0..255
function matte(w, h, frames, fps, start, fill) {
  const data = new Uint8Array(w * h * frames)
  for (let f = 0; f < frames; f++) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[f * w * h + y * w + x] = fill(f, x, y)
  return PM.buildMaskPayload({ v: 1, w, h, fps, start, frames }, data)
}
const writeGz = (name, payload) => {
  const p = path.join(dir, name)
  fs.writeFileSync(p, zlib.gzipSync(payload))
  return p
}

test('settings: defaults, clamping, background kinds and the alpha range', () => {
  const k = PM.normalizePersonKey({ color: 'person' })
  assert.deepEqual(k, { mode: 'person', threshold: 0.5, softness: 0.3, maskUrl: null, background: { kind: 'none', blur: 0.025, color: '#000000' } })
  const c = PM.normalizePersonKey({ threshold: 5, softness: -1, background: { kind: 'color', color: '#FF00aa' } })
  assert.equal(c.threshold, 0.9)
  assert.equal(c.softness, 0.02)
  assert.equal(c.background.color, '#ff00aa')
  assert.equal(PM.normalizeBackground({ kind: 'weird' }).kind, 'none')
  assert.equal(PM.normalizeBackground({ kind: 'blur', blur: 1 }).blur, 0.08)
  const r = PM.personAlphaRange(k)
  assert.deepEqual(r, { lo: 89, hi: 166 })
  assert.equal(PM.personAlpha(0, r), 0)
  assert.equal(PM.personAlpha(255, r), 255)
  assert.equal(PM.personAlpha(128, r), 129)
  // a very hard edge still has a range of 2
  const hard = PM.personAlphaRange({ threshold: 0.9, softness: 0.02 })
  assert.ok(hard.hi - hard.lo >= 2 && hard.hi <= 255)
})

test('matte size, range and frame picks', () => {
  assert.deepEqual(PM.personMaskSize(1920, 1080), [256, 144])
  assert.deepEqual(PM.personMaskSize(1080, 1920), [144, 256])
  assert.deepEqual(PM.personMaskRange(30, 5, 10), { start: 0, end: 30 })
  assert.deepEqual(PM.personMaskRange(3600, 100, 160), { start: 100, end: 160 })
  assert.equal(PM.personMaskFrames({ start: 0, end: 2 }), 30)
  const h = { v: 1, w: 8, h: 8, fps: 15, start: 0, frames: 30 }
  assert.equal(PM.maskFrameIndex(h, 0), 0)
  assert.equal(PM.maskFrameIndex(h, 1 / 15 * 0.6), 1)
  assert.equal(PM.maskFrameIndex(h, 99), 29)
  assert.equal(PM.maskFrameIndex(h, -1), 0)
  // 30 fps output from a 15 fps matte: each matte frame twice, from the clip's in point
  assert.deepEqual(PM.resampleMaskIndexes(h, 1, 1.2, 30), [15, 16, 16, 17, 17, 18])
})

test('payload: round trip, and broken files are refused', async () => {
  const payload = matte(8, 8, 3, 15, 0, (f) => f * 100)
  const t = PM.parseMaskPayload(payload)
  assert.deepEqual(t.header, { v: 1, w: 8, h: 8, fps: 15, start: 0, frames: 3 })
  assert.equal(PM.maskFrame(t, 2)[0], 200)
  assert.equal(PM.parseMaskPayload(new Uint8Array(40)), null)
  assert.equal(PM.parseMaskPayload(payload.subarray(0, payload.length - 10)), null, 'too few frame bytes')
  const bad = PM.buildMaskPayload({ v: 1, w: 4000, h: 8, fps: 15, start: 0, frames: 1 }, new Uint8Array(32000))
  assert.equal(PM.parseMaskPayload(bad), null, 'absurd size')
  const gz = await readMaskFile(writeGz('rt.gz', payload))
  assert.equal(gz.header.frames, 3)
  const plain = path.join(dir, 'plain.bin'); fs.writeFileSync(plain, payload)
  assert.equal((await readMaskFile(plain)).header.w, 8)
})

test('the matte stream has one frame per output frame (plus a spare)', async () => {
  const file = writeGz('s.gz', matte(8, 8, 30, 15, 0, (f) => f))
  const out = await writePersonMaskStream({ startTime: 1, endTime: 1.5 }, file, path.join(dir, 's.gray'), 30)
  assert.equal(out.frames, 16)
  const bytes = fs.readFileSync(out.path)
  assert.equal(bytes.length, 16 * 64)
  assert.deepEqual([0, 1, 2, 3, 14, 15].map(j => bytes[j * 64]), [15, 16, 16, 17, 22, 22])
})

test('filtergraph: see-through, colour and blur backgrounds', () => {
  const base = { clipLabel: '1:v', maskLabel: '3:v', maskTransform: 'scale=100:100', i: 0, delay: 'setpts=PTS+1.000/TB', outLabel: 'v0' }
  const none = buildPersonKeyFilter({ ...base, key: personKeyForSize(PM.normalizePersonKey({}), 100) }).join(';')
  assert.match(none, /lut=c0='clip\(\(val-89\)\*255\/77,0,255\)'/)
  assert.match(none, /alphamerge,setpts=PTS\+1\.000\/TB\[v0\]$/)
  const col = buildPersonKeyFilter({ ...base, key: personKeyForSize(PM.normalizePersonKey({ background: { kind: 'color', color: '#00ff00' } }), 100) }).join(';')
  assert.match(col, /drawbox=.*color=0x00ff00@1:t=fill/)
  assert.match(col, /overlay=0:0:format=auto,setpts/)
  const blur = buildPersonKeyFilter({ ...base, key: personKeyForSize(PM.normalizePersonKey({ background: { kind: 'blur', blur: 0.05 } }), 200) }).join(';')
  assert.match(blur, /gblur=sigma=10\.00/)
})

// Renders: a blue video keyed over a red colour clip. The matte says the left
// half is the person: left stays blue, right shows what is behind.
const W = 160, H = 120
async function renderPerson(name, background, { maskOk = true } = {}) {
  const blue = path.join(dir, 'blue.mp4')
  if (!fs.existsSync(blue)) execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=blue:s=${W}x${H}:d=2:r=30`, '-pix_fmt', 'yuv420p', blue])
  const mask = writeGz(`${name}.gz`, matte(16, 12, 30, 15, 0, (f, x) => (x < 8 ? 255 : 0)))
  const tracks = [
    { id: 'top', type: 'video', clips: [{ id: 'p', type: 'video', name: 'me', duration: 2, startTime: 0, endTime: 2, timelinePosition: 0, zoom: 100, chromaKey: { color: 'person', maskUrl: '/x.gz', background } }] },
    { id: 'bottom', type: 'video', clips: [{ id: 'bg', type: 'color', duration: 2, startTime: 0, endTime: 2, timelinePosition: 0, backgroundColor: '#ff0000' }] }
  ]
  const downloadedFiles = new Map([['p', blue], ...(maskOk ? [['p__mask', mask]] : [])])
  const jobDir = path.join(dir, name); fs.mkdirSync(jobDir, { recursive: true })
  const out = path.join(dir, `${name}.mp4`)
  await buildAndRunFFmpeg({ timeline: { outputWidth: W, outputHeight: H, previewWidth: W, previewHeight: H, fps: 30, tracks }, downloadedFiles, outputPath: out, jobDir, onProgress: () => {} })
  return out
}
// average RGB of a box of the frame at 1 s
const rgbAt = (file, x, y, w = 10, h = 10) => {
  const raw = execFileSync('ffmpeg', ['-loglevel', 'error', '-ss', '1', '-i', file, '-frames:v', '1', '-vf', `crop=${w}:${h}:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'])
  const s = [0, 0, 0]
  for (let i = 0; i < raw.length; i += 3) for (let c = 0; c < 3; c++) s[c] += raw[i + c]
  return s.map(v => Math.round(v / (raw.length / 3)))
}
const near = (got, want, tol = 40) => got.every((v, i) => Math.abs(v - want[i]) <= tol)

test('render: see-through background shows the track below beside the person', { skip: !hasFfmpeg, timeout: 120000 }, async () => {
  const f = await renderPerson('none', { kind: 'none' })
  assert.ok(near(rgbAt(f, 20, 55), [0, 0, 255]), `left (person) ${rgbAt(f, 20, 55)}`)
  assert.ok(near(rgbAt(f, 130, 55), [255, 0, 0]), `right (background) ${rgbAt(f, 130, 55)}`)
})

test('render: colour background replaces the room, blur keeps the clip opaque', { skip: !hasFfmpeg, timeout: 120000 }, async () => {
  const c = await renderPerson('color', { kind: 'color', color: '#00ff00' })
  assert.ok(near(rgbAt(c, 20, 55), [0, 0, 255]), `left ${rgbAt(c, 20, 55)}`)
  assert.ok(near(rgbAt(c, 130, 55), [0, 255, 0]), `right ${rgbAt(c, 130, 55)}`)
  const b = await renderPerson('blur', { kind: 'blur', blur: 0.03 })
  assert.ok(near(rgbAt(b, 130, 55), [0, 0, 255]), `blurred blue behind, no red: ${rgbAt(b, 130, 55)}`)
})

test('render: without its matte the clip renders unkeyed instead of failing', { skip: !hasFfmpeg, timeout: 120000 }, async () => {
  const f = await renderPerson('nomask', { kind: 'none' }, { maskOk: false })
  assert.ok(near(rgbAt(f, 130, 55), [0, 0, 255]), `right ${rgbAt(f, 130, 55)}`)
})

test('render: a person-keyed clip at 2x speed reads its matte at the media second it shows', { skip: !hasFfmpeg, timeout: 120000 }, async () => {
  const blue4 = path.join(dir, 'blue4.mp4')
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=blue:s=${W}x${H}:d=4:r=30`, '-pix_fmt', 'yuv420p', blue4])
  // 4 media seconds: the person is on the left before media second 2, on the right after it
  const mask = writeGz('speed.gz', matte(16, 12, 60, 15, 0, (f, x) => ((f < 30) === (x < 8) ? 255 : 0)))
  const tracks = [
    { id: 'top', type: 'video', clips: [{ id: 'p', type: 'video', name: 'me', duration: 4, startTime: 0, endTime: 2, speed: 2, timelinePosition: 0, zoom: 100, chromaKey: { color: 'person', maskUrl: '/x.gz' } }] },
    { id: 'bottom', type: 'video', clips: [{ id: 'bg', type: 'color', duration: 2, startTime: 0, endTime: 2, timelinePosition: 0, backgroundColor: '#ff0000' }] }
  ]
  const jobDir = path.join(dir, 'speed'); fs.mkdirSync(jobDir, { recursive: true })
  const out = path.join(dir, 'speed.mp4')
  await buildAndRunFFmpeg({ timeline: { outputWidth: W, outputHeight: H, previewWidth: W, previewHeight: H, fps: 30, tracks }, downloadedFiles: new Map([['p', blue4], ['p__mask', mask]]), outputPath: out, jobDir, onProgress: () => {} })
  const at = (t, x) => {
    const raw = execFileSync('ffmpeg', ['-loglevel', 'error', '-ss', String(t), '-i', out, '-frames:v', '1', '-vf', `crop=10:10:${x}:55`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'])
    const s = [0, 0, 0]
    for (let i = 0; i < raw.length; i += 3) for (let c = 0; c < 3; c++) s[c] += raw[i + c]
    return s.map(v => Math.round(v / (raw.length / 3)))
  }
  // timeline 0.5 s = media 1 s: person left; timeline 1.5 s = media 3 s: person right
  assert.ok(near(at(0.5, 20), [0, 0, 255]) && near(at(0.5, 130), [255, 0, 0]), `0.5 s: ${at(0.5, 20)} | ${at(0.5, 130)}`)
  assert.ok(near(at(1.5, 20), [255, 0, 0]) && near(at(1.5, 130), [0, 0, 255]), `1.5 s: ${at(1.5, 20)} | ${at(1.5, 130)}`)
})

test('matte picks follow the clip speed (sourceAt)', async () => {
  const { sourceAt } = await import('../src/utils/clipSpeed.js')
  const h = { v: 1, w: 8, h: 8, fps: 15, start: 0, frames: 60 }
  const clip = { startTime: 0, endTime: 1, speed: 2 }
  assert.deepEqual(PM.resampleMaskIndexes(h, 0, 0.2, 30, (c) => sourceAt(clip, c)), [0, 1, 2, 3, 4, 5])
  const still = { startTime: 0, endTime: 1, freezeAt: 2 }
  assert.deepEqual(new Set(PM.resampleMaskIndexes(h, 0, 1, 30, (c) => sourceAt(still, c))), new Set([30]))
})
