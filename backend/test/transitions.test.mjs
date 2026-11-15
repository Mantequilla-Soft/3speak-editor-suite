// Transitions and video fades (utils/transitions.js, utils/transitionRender.js)
// through the real render pipeline: a red clip into a blue one, each with its
// own tone on the audio track. Needs ffmpeg on PATH; skipped without it.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let hasFfmpeg = true
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }) } catch { hasFfmpeg = false }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transitions-'))
process.env.WORK_DIR = dir
const { buildAndRunFFmpeg } = await import('../src/services/ffmpeg.js')
const { shiftOverlay } = await import('../src/utils/transitionRender.js')
after(() => fs.rmSync(dir, { recursive: true, force: true }))

const W = 180, H = 320
const ff = (...args) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...args])
const red = path.join(dir, 'red.mp4'), blue = path.join(dir, 'blue.mp4')
if (hasFfmpeg) {
  ff('-f', 'lavfi', '-i', `color=c=red:s=${W}x${H}:r=30:d=3`, '-f', 'lavfi', '-i', 'sine=f=440:d=3', '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', red)
  ff('-f', 'lavfi', '-i', `color=c=blue:s=${W}x${H}:r=30:d=3`, '-f', 'lavfi', '-i', 'sine=f=1500:d=3', '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', blue)
}

async function render(name, transition, extra = {}) {
  const tracks = [
    { id: 'v', type: 'video', clips: [
      { id: 'a', type: 'video', url: 'x', startTime: 0, endTime: 1, duration: 3, timelinePosition: 0, audioEnabled: false, groupId: 'g1', ...(transition ? { transition: { type: transition, duration: 1, to: 'b' } } : {}), ...extra.a },
      { id: 'b', type: 'video', url: 'x', startTime: 1, endTime: 2, duration: 3, timelinePosition: 1, audioEnabled: false, groupId: 'g2', ...extra.b }] },
    { id: 'au', type: 'audio', clips: [
      { id: 'aa', type: 'audio', url: 'x', startTime: 0, endTime: 1, duration: 3, timelinePosition: 0, groupId: 'g1' },
      { id: 'ba', type: 'audio', url: 'x', startTime: 1, endTime: 2, duration: 3, timelinePosition: 1, groupId: 'g2' }] }
  ]
  const jobDir = path.join(dir, name); fs.mkdirSync(jobDir, { recursive: true })
  const out = path.join(dir, `${name}.mp4`)
  await buildAndRunFFmpeg({ timeline: { outputWidth: W, outputHeight: H, previewWidth: W, previewHeight: H, fps: 30, tracks },
    downloadedFiles: new Map([['a', red], ['b', blue], ['aa', red], ['ba', blue]]), outputPath: out, jobDir, onProgress: () => {} })
  return out
}
const at = (file, t, x = W / 2, y = H / 2) => {
  const b = execFileSync('ffmpeg', ['-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 24 })
  const i = (Math.round(y) * W + Math.round(x)) * 3
  return { r: b[i], g: b[i + 1], b: b[i + 2] }
}
const tone = (file, f, ss) => {
  const r = execFileSync('sh', ['-c', `ffmpeg -nostats -ss ${ss} -t 0.2 -i "${file}" -af "bandpass=f=${f}:width_type=q:w=8,volumedetect" -f null - 2>&1 | grep mean_volume || true`], { encoding: 'utf8' })
  const m = /mean_volume: (-?[\d.]+) dB/.exec(r)
  return m ? +m[1] : -Infinity
}

test('overlay offsets are added in brackets (a negative slide stays valid)', () => {
  assert.equal(shiftOverlay('(W-w)/2:(H-h)/2', '-W*min(1,t)', null), '(W-w)/2+(-W*min(1\\,t)):(H-h)/2')
  assert.equal(shiftOverlay('10:20', null, null), '10:20')
})

test('a crossfade mixes the two pictures at the cut, and their sound overlaps', { skip: !hasFfmpeg, timeout: 90000 }, async () => {
  const hard = await render('hard', null)
  const out = await render('crossfade', 'crossfade')
  assert.ok(at(hard, 1.03).r < 30, 'a hard cut is blue right after the cut')
  const mid = at(out, 1.0)
  assert.ok(mid.r > 90 && mid.b > 90, `half red, half blue at the cut: ${JSON.stringify(mid)}`)
  assert.ok(at(out, 0.3).r > 230 && at(out, 1.7).b > 230, 'clean before and after')
  // the outgoing tone goes on past the cut and the incoming one starts before it
  assert.ok(tone(out, 440, 1.15) > tone(hard, 440, 1.15) + 10, 'red tone after the cut')
  assert.ok(tone(out, 1500, 0.65) > tone(hard, 1500, 0.65) + 10, 'blue tone before the cut')
})

test('a slide moves the incoming picture in from the right', { skip: !hasFfmpeg, timeout: 60000 }, async () => {
  const out = await render('slide', 'slideleft')
  const left = at(out, 1.0, 20), right = at(out, 1.0, W - 20)
  assert.ok(left.r > 200 && left.b < 60, `left still red: ${JSON.stringify(left)}`)
  assert.ok(right.b > 200 && right.r < 60, `right already blue: ${JSON.stringify(right)}`)
})

test('a dip to black is dark at the cut', { skip: !hasFfmpeg, timeout: 60000 }, async () => {
  const out = await render('dip', 'dissolve')
  const c = at(out, 1.0)
  assert.ok(c.r < 40 && c.b < 40, JSON.stringify(c))
  assert.ok(at(out, 0.75).r > 80 && at(out, 0.75).r < 200, 'half way down')
})

test('zoom and whip render (perspective and blur on the layers)', { skip: !hasFfmpeg, timeout: 90000 }, async () => {
  const z = await render('zoom', 'zoom')
  const mid = at(z, 1.0)
  assert.ok(mid.r > 90 && mid.b > 90, `zoom fades through: ${JSON.stringify(mid)}`)
  const w = await render('whip', 'whip')
  assert.ok(at(w, 0.3).r > 230 && at(w, 1.7).b > 230)
})

test('fade in and out of a video clip', { skip: !hasFfmpeg, timeout: 60000 }, async () => {
  const out = await render('fades', null, { a: { fadeIn: 0.5 }, b: { fadeOut: 0.5 } })
  assert.ok(at(out, 0.05).r < 60, 'dark at the start')
  assert.ok(at(out, 0.6).r > 230, 'full after the fade')
  assert.ok(at(out, 1.95).b < 60, 'dark at the end')
})

test('a crossfade from a 2x clip into a normal one: the fast clip plays its media at double speed and holds its own last frame', { skip: !hasFfmpeg, timeout: 120000 }, async () => {
  // red for 1.5 s of media, then green: at 2x that change shows at 0.75 s on the timeline
  const redGreen = path.join(dir, 'redgreen.mp4')
  ff('-f', 'lavfi', '-i', `color=c=red:s=${W}x${H}:r=30:d=1.5`, '-f', 'lavfi', '-i', `color=c=0x00ff00:s=${W}x${H}:r=30:d=1.5`, '-f', 'lavfi', '-i', 'sine=f=440:d=3',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-map', '2:a', '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', redGreen)
  const tracks = [
    { id: 'v', type: 'video', clips: [
      { id: 'a', type: 'video', url: 'x', startTime: 0, endTime: 1, duration: 3, speed: 2, timelinePosition: 0, audioEnabled: false, groupId: 'g1', transition: { type: 'crossfade', duration: 0.4, to: 'b' } },
      { id: 'b', type: 'video', url: 'x', startTime: 1, endTime: 2, duration: 3, timelinePosition: 1, audioEnabled: false, groupId: 'g2' }] },
    { id: 'au', type: 'audio', clips: [
      { id: 'aa', type: 'audio', url: 'x', startTime: 0, endTime: 1, duration: 3, speed: 2, timelinePosition: 0, groupId: 'g1' },
      { id: 'ba', type: 'audio', url: 'x', startTime: 1, endTime: 2, duration: 3, timelinePosition: 1, groupId: 'g2' }] }
  ]
  const jobDir = path.join(dir, 'fast'); fs.mkdirSync(jobDir, { recursive: true })
  const out = path.join(dir, 'fast.mp4')
  await buildAndRunFFmpeg({ timeline: { outputWidth: W, outputHeight: H, previewWidth: W, previewHeight: H, fps: 30, tracks },
    downloadedFiles: new Map([['a', redGreen], ['b', blue], ['aa', redGreen], ['ba', blue]]), outputPath: out, jobDir, onProgress: () => {} })
  const early = at(out, 0.4), late = at(out, 0.78)
  assert.ok(early.r > 200 && early.g < 60, `red early: ${JSON.stringify(early)}`)
  assert.ok(late.g > 200 && late.r < 60, `green from 0.75 s of media at 2x: ${JSON.stringify(late)}`)
  // after the cut the fast clip is held on its last frame (green) under the incoming blue
  const mid = at(out, 1.1)
  assert.ok(mid.g > 60 && mid.b > 60 && mid.r < 60, `green and blue mixed after the cut: ${JSON.stringify(mid)}`)
  // its sound goes on past the cut (the piece past the cut at 2x)
  assert.ok(tone(out, 440, 1.05) > -60, 'fast clip\'s tone after the cut')
  assert.ok(fs.readdirSync(jobDir).some(f => /xfade_aa/.test(f)), 'a piece of the fast clip\'s sound past the cut')
})
