// Speed, ramps, stills and keyframes through the real render pipeline (needs
// ffmpeg on PATH; those tests are skipped without it). The source video's
// brightness says which media second a frame is from, so the tests can read
// back what the render showed when, and compare it with the shared maths the
// preview uses (utils/clipSpeed.js, utils/keyframes.js).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let hasFfmpeg = true
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }) } catch { hasFfmpeg = false }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-'))
process.env.WORK_DIR = dir
const { buildAndRunFFmpeg } = await import('../src/services/ffmpeg.js')
const { segmentFilter, segmentArgs } = await import('../src/services/audioRender.js')
const speed = await import('../src/utils/clipSpeed.js')
const kf = await import('../src/utils/keyframes.js')
const { filterGraphArgs } = await import('../src/utils/keyframeRender.js')
after(() => { if (!process.env.KEEP_MOTION_TEST) fs.rmSync(dir, { recursive: true, force: true }) })

const W = 160, H = 284
// Brightness = 60 x media second (0..240 over 4 s), with a 440 Hz tone
const ramp = path.join(dir, 'ramp.mp4')
const white = path.join(dir, 'white.mp4')
const dot = path.join(dir, 'dot.png')
const tone = path.join(dir, 'tone.m4a')
before(() => {
  if (!hasFfmpeg) return
  const ff = (...a) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...a])
  ff('-f', 'lavfi', '-i', "nullsrc=s=64x64:r=30:d=4,format=gray,geq=lum='min(255,T*60)'", '-f', 'lavfi', '-i', 'sine=f=440:d=4',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '1', '-c:a', 'aac', '-shortest', ramp)
  ff('-f', 'lavfi', '-i', 'color=c=white:s=160x284:r=30:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', white)
  ff('-f', 'lavfi', '-i', 'color=c=white:s=20x20:d=1', '-frames:v', '1', dot)
  ff('-f', 'lavfi', '-i', 'sine=f=440:d=4', '-c:a', 'aac', tone)
})

async function render(name, tracks, files) {
  const jobDir = path.join(dir, name); fs.mkdirSync(jobDir, { recursive: true })
  const out = path.join(dir, `out-${name}.mp4`)
  await buildAndRunFFmpeg({ timeline: { outputWidth: W, outputHeight: H, previewWidth: W, previewHeight: H, fps: 30, tracks }, downloadedFiles: new Map(Object.entries(files)), outputPath: out, jobDir, onProgress: () => {} })
  return out
}
const frame = (file, t) => execFileSync('ffmpeg', ['-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'])
// Mean brightness of the frame's middle (the 64x64 source fits to 160x160 there)
const middle = (buf) => {
  let sum = 0, n = 0
  for (let y = H / 2 - 20; y < H / 2 + 20; y++) for (let x = 60; x < 100; x++) { sum += buf[y * W + x]; n++ }
  return sum / n
}
// Centre and width of the bright pixels (white layers on black)
const bright = (buf) => {
  let sx = 0, sy = 0, n = 0, minX = W, maxX = -1
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (buf[y * W + x] > 128) { sx += x; sy += y; n++; minX = Math.min(minX, x); maxX = Math.max(maxX, x) }
  return n ? { x: sx / n, y: sy / n, width: maxX - minX + 1, n } : { x: NaN, y: NaN, width: 0, n: 0 }
}
const duration = (file, stream = 'v:0') => +execFileSync('ffprobe', ['-v', 'error', '-select_streams', stream, '-show_entries', 'stream=duration', '-of', 'csv=p=0', file]).toString().trim()
const mediaSecondShown = (file, t) => middle(frame(file, t)) / 60
const videoClip = (extra = {}) => ({ id: 'v1', type: 'video', name: 'ramp', duration: 4, startTime: 0, endTime: 4, timelinePosition: 0, ...extra })

// --- the shared maths -------------------------------------------------------

test('a ramp maps clip time to media time and back', () => {
  const c = { startTime: 0, endTime: 4, speedRamp: { points: [{ at: 1, speed: 2 }, { at: 2, speed: 0.5 }, { at: 3, speed: 3 }] } }
  for (const t of [0, 0.5, 1, 1.3, 1.9, 2, 2.5, 3, 3.7]) {
    assert.ok(Math.abs(speed.clipTimeAt(c, speed.sourceAt(c, t)) - t) < 1e-9, `round trip at ${t}`)
  }
  assert.equal(speed.sourceAt(c, 1), 2) // 2x up to the first point
  assert.ok(Math.abs(speed.sourceAt(c, 2) - (2 + 1.25)) < 1e-9) // average 1.25x from 1 to 2
  assert.equal(speed.speedAt(c, 1.5), 1.25)
})

test('a new speed keeps the same stretch of media, and moves the keyframes with it', () => {
  const c = { startTime: 2, endTime: 6, keyframes: { scale: [{ t: 3, v: 120 }] } }
  const u = speed.retime(c, { speed: 2 })
  assert.equal(u.speed, 2)
  assert.equal(u.startTime, 1)
  assert.equal(u.endTime, 3)
  assert.equal(u.keyframes.scale[0].t, 1.5)
  const back = speed.retime({ ...c, ...u }, {})
  assert.equal(back.startTime, 2)
  assert.equal(back.endTime, 6)
  assert.equal(back.speed, undefined)
})

test('ramp presets cover the clip\'s stretch of media', () => {
  for (const p of speed.RAMP_PRESETS) {
    const u = speed.rampUpdates({ startTime: 1, endTime: 5 }, p.id)
    const [a, b] = speed.sourceRange(u)
    assert.ok(Math.abs(a - 1) < 1e-6 && Math.abs(b - 5) < 1e-6, `${p.id}: ${a}..${b}`)
  }
})

test('atempo chains keep each step in range', () => {
  assert.equal(speed.ffmpegAudioTiming({ startTime: 0, endTime: 4, speed: 0.25 }).filter, 'atempo=0.5,atempo=0.5')
  assert.equal(speed.ffmpegAudioTiming({ startTime: 0, endTime: 4, speed: 4 }).filter, 'atempo=2,atempo=2')
  assert.equal(speed.ffmpegAudioTiming({ startTime: 0, endTime: 4, speed: 1.5 }).filter, 'atempo=1.5')
  assert.equal(speed.ffmpegAudioTiming({ startTime: 0, endTime: 4 }), null)
  assert.ok(speed.ffmpegAudioTiming({ startTime: 0, endTime: 1, freezeAt: 2 }).silent)
})

test('keyframes: linear and eased values, reference layout and the relative move', () => {
  const c = { startTime: 0, endTime: 4, zoom: 100, positionX: 30, keyframes: { scale: [{ t: 1, v: 100, ease: 'ease' }, { t: 2, v: 150 }], x: [{ t: 0, v: 0 }, { t: 2, v: 40 }] } }
  assert.equal(kf.propAt(c, 'scale', 0), 100)
  assert.equal(kf.propAt(c, 'scale', 1.5), 125)
  assert.ok(kf.propAt(c, 'scale', 1.25) < 112.5, 'eased: slower at the start')
  assert.equal(kf.propAt(c, 'x', 1), 20)
  const base = kf.keyframeBase(c)
  assert.equal(base.positionX, 0)
  assert.equal(base.zoom, 100)
  const r = kf.relativeAt(c, 2, 2)
  assert.equal(r.k, 1.5)
  assert.equal(r.dx, 1.5 * 40 * 2)
  assert.equal(kf.keyframeBase({ id: 'x' }).id, 'x')
})

test('old clips without the new fields render exactly as before', () => {
  const c = { startTime: 1, endTime: 3, volume: 80 }
  assert.equal(speed.ffmpegVideoTiming(c), null)
  assert.equal(kf.keyframeBase(c), c)
  assert.equal(segmentFilter(c), 'volume=0.800')
  assert.ok(segmentArgs(c, 'in.m4a', 96000, 'out.flac').includes('1.000000'))
})

test('the audio render (audio editor, captions) reads sped-up sound at its own speed', () => {
  const c = { startTime: 1, endTime: 3, speed: 2, volume: 100 }
  assert.equal(segmentFilter(c), 'atempo=2')
  const args = segmentArgs(c, 'in.m4a', 96000, 'out.flac')
  assert.equal(args[args.indexOf('-ss') + 1], '2.000000') // clip time 1 at 2x = media second 2
  const v = { startTime: 0, endTime: 2, volume: 40, keyframes: { volume: [{ t: 0, v: 100 }, { t: 2, v: 0 }] } }
  assert.match(segmentFilter(v), /^volume=eval=frame:volume='max\(0,/)
  assert.ok(!segmentFilter(v).includes('volume=0.400'), 'animated volume replaces the clip\'s own')
  const still = segmentArgs({ startTime: 0, endTime: 1, freezeAt: 1 }, 'in.m4a', 48000, 'out.flac')
  assert.ok(still.includes('anullsrc=r=48000:cl=stereo'), 'a still is silent')
})

test('a long filtergraph goes to ffmpeg as a script file', async () => {
  const file = path.join(dir, 'g.txt')
  assert.deepEqual(await filterGraphArgs('null', file), ['-filter_complex', 'null'])
  const long = 'null,'.repeat(30000) + 'null'
  assert.deepEqual(await filterGraphArgs(long, file), ['-filter_complex_script', file])
  assert.equal(fs.readFileSync(file, 'utf8'), long)
})

// --- real renders -----------------------------------------------------------

test('2x speed: half as long, and each moment shows twice as far into the media', { skip: !hasFfmpeg }, async () => {
  const c = videoClip(speed.retime(videoClip(), { speed: 2 }))
  const a = { ...c, id: 'a1', type: 'audio' }
  const out = await render('speed2', [{ id: 'v', type: 'video', clips: [c] }, { id: 'a', type: 'audio', clips: [a] }], { v1: ramp, a1: ramp })
  assert.ok(Math.abs(duration(out) - 2) < 0.1, `video ${duration(out)} s`)
  assert.ok(Math.abs(duration(out, 'a:0') - 2) < 0.1, `audio ${duration(out, 'a:0')} s`)
  for (const t of [0.5, 1, 1.5]) assert.ok(Math.abs(mediaSecondShown(out, t) - speed.sourceAt(c, t)) < 0.15, `at ${t}: ${mediaSecondShown(out, t)}`)
})

test('slow motion 0.5x of the first 2 s: 4 s long', { skip: !hasFfmpeg }, async () => {
  const c = videoClip({ ...speed.retime(videoClip({ endTime: 2 }), { speed: 0.5 }), endTime: 4 })
  assert.equal(c.endTime, 4)
  const out = await render('slow', [{ id: 'v', type: 'video', clips: [c] }], { v1: ramp })
  assert.ok(Math.abs(duration(out) - 4) < 0.1)
  for (const t of [1, 2, 3]) assert.ok(Math.abs(mediaSecondShown(out, t) - t / 2) < 0.15, `at ${t}: ${mediaSecondShown(out, t)}`)
})

test('a speed ramp renders the same media moments the preview computes', { skip: !hasFfmpeg }, async () => {
  const c = videoClip(speed.rampUpdates(videoClip(), 'hero'))
  const a = { ...c, id: 'a1', type: 'audio' }
  const length = c.endTime - c.startTime
  const out = await render('ramp', [{ id: 'v', type: 'video', clips: [c] }, { id: 'a', type: 'audio', clips: [a] }], { v1: ramp, a1: ramp })
  assert.ok(Math.abs(duration(out) - length) < 0.1, `${duration(out)} vs ${length}`)
  assert.ok(Math.abs(duration(out, 'a:0') - length) < 0.15, `audio ${duration(out, 'a:0')} vs ${length}`)
  for (const f of [0.15, 0.4, 0.5, 0.6, 0.85]) {
    const t = f * length
    const want = speed.sourceAt(c, c.startTime + t)
    assert.ok(Math.abs(mediaSecondShown(out, t) - want) < 0.15, `at ${t.toFixed(2)}: ${mediaSecondShown(out, t)} vs ${want}`)
  }
})

test('a still holds one frame for its length', { skip: !hasFfmpeg }, async () => {
  const c = videoClip({ startTime: 0, endTime: 1.5, freezeAt: 2, audioEnabled: false })
  const out = await render('still', [{ id: 'v', type: 'video', clips: [c] }], { v1: ramp })
  assert.ok(Math.abs(duration(out) - 1.5) < 0.1)
  for (const t of [0.1, 0.7, 1.4]) assert.ok(Math.abs(mediaSecondShown(out, t) - 2) < 0.1, `at ${t}: ${mediaSecondShown(out, t)}`)
})

test('image keyframes: the render puts the layer where the shared maths does', { skip: !hasFfmpeg }, async () => {
  // A 20x20 white image, contain-fit (160 wide) then zoom 20% = 32 px square
  const c = { id: 'i1', type: 'image', name: 'dot', startTime: 0, endTime: 2, timelinePosition: 0, zoom: 20,
    keyframes: { x: [{ t: 0, v: -200 }, { t: 2, v: 200 }], scale: [{ t: 0, v: 20 }, { t: 1, v: 40, ease: 'ease' }, { t: 2, v: 20 }] } }
  const out = await render('kfimage', [{ id: 'v', type: 'video', clips: [c] }], { i1: dot })
  for (const t of [0.25, 1, 1.5]) {
    const b = bright(frame(out, t))
    const p = kf.layerPivot(c, W, H)
    const r = kf.relativeAt(c, t)
    assert.ok(Math.abs(b.x - (p.x + r.dx)) < 2.5, `x at ${t}: ${b.x} vs ${p.x + r.dx}`)
    assert.ok(Math.abs(b.width - 32 * r.k) < 3, `size at ${t}: ${b.width} vs ${32 * r.k}`)
  }
})

test('video keyframes: scale, rotation and opacity on a video clip', { skip: !hasFfmpeg }, async () => {
  const c = { id: 'w1', type: 'video', name: 'white', duration: 4, startTime: 0, endTime: 2, timelinePosition: 0.5,
    keyframes: { scale: [{ t: 0, v: 40 }, { t: 2, v: 80 }], opacity: [{ t: 1, v: 100 }, { t: 2, v: 0 }], rotation: [{ t: 0, v: 0 }, { t: 0.5, v: 90 }, { t: 1, v: 0 }] } }
  const bg = { id: 'bg', type: 'color', startTime: 0, endTime: 2.5, timelinePosition: 0, backgroundColor: '#000000' }
  const out = await render('kfvideo', [{ id: 'top', type: 'video', clips: [c] }, { id: 'bottom', type: 'video', clips: [bg] }], { w1: white })
  // 0.5 s into the clip: scale 50% turned 90 degrees, so its width is its height
  const turned = bright(frame(out, 1.0))
  assert.ok(Math.abs(turned.width - 284 * 0.5) < 6, `turned width ${turned.width}`)
  // 1 s in: 60%, upright, full opacity
  const upright = bright(frame(out, 1.5))
  assert.ok(Math.abs(upright.width - 160 * 0.6) < 4, `width ${upright.width}`)
  // 1.5 s in: half transparent over black
  const half = frame(out, 2.0)
  const v = half[Math.floor(H / 2) * W + W / 2]
  assert.ok(v > 90 && v < 170, `half opacity ${v}`)
})

test('animated volume: loud at the start, silent at the end', { skip: !hasFfmpeg }, async () => {
  const a = { id: 'a1', type: 'audio', duration: 4, startTime: 0, endTime: 3, timelinePosition: 0, volume: 30,
    keyframes: { volume: [{ t: 0, v: 100 }, { t: 2, v: 0 }] } }
  const bg = { id: 'bg', type: 'color', startTime: 0, endTime: 3, timelinePosition: 0, backgroundColor: '#000000' }
  const out = await render('kfvol', [{ id: 'v', type: 'video', clips: [bg] }, { id: 'a', type: 'audio', clips: [a] }], { a1: tone })
  const peak = (ss, t) => {
    const r = execFileSync('sh', ['-c', `ffmpeg -nostats -ss ${ss} -t ${t} -i "${out}" -af volumedetect -f null - 2>&1 | grep max_volume || true`], { encoding: 'utf8' })
    const m = /max_volume: (-?[\d.]+|-inf) dB/.exec(r)
    return m ? (m[1] === '-inf' ? -Infinity : +m[1]) : -Infinity
  }
  // 100% at the start (the tone peaks near -18 dB; at the clip's own 30% it would be near -28), silent at the end
  assert.ok(peak(0, 0.2) > -20, `start ${peak(0, 0.2)}`)
  assert.ok(peak(2.3, 0.5) < peak(0, 0.2) - 30, `end ${peak(2.3, 0.5)}`)
})

test('hundreds of keyframes still render (script-file graph)', { skip: !hasFfmpeg }, async () => {
  const scale = Array.from({ length: 300 }, (_, i) => ({ t: i * 0.01, v: 100 + (i % 2) * 10 }))
  const c = { id: 'w1', type: 'video', name: 'white', duration: 4, startTime: 0, endTime: 3, timelinePosition: 0, keyframes: { scale, x: scale.map(k => ({ t: k.t, v: k.v - 100 })) } }
  const out = await render('many', [{ id: 'v', type: 'video', clips: [c] }], { w1: white })
  assert.ok(Math.abs(duration(out) - 3) < 0.1)
})
