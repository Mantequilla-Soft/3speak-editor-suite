// Reframing ("Export as" another shape): the window follows the clip's face
// path, the same in the render as in the preview (utils/reframe.js).
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let hasFfmpeg = true
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }) } catch { hasFfmpeg = false }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reframe-'))
process.env.WORK_DIR = path.join(dir, 'work')
const { normalizeReframe, centreAt, reframeBox, pathExpr, reframeFilter, smoothPath, thinPath, isReframable, panFor, coverOverflow, MAX_PATH_POINTS } = await import('../src/utils/reframe.js')
const { buildAndRunFFmpeg } = await import('../src/services/ffmpeg.js')
after(() => fs.rmSync(dir, { recursive: true, force: true }))

// A 160x90 source: red on the left half, blue on the right half
function source(name, seconds = 2) {
  const file = path.join(dir, name)
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=red:s=160x90:d=${seconds}:r=10`,
    '-vf', 'drawbox=x=80:y=0:w=80:h=90:color=blue:t=fill', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', file])
  return file
}
// The average colour of one frame of a video at `at` seconds: [r, g, b]
function colourAt(file, at) {
  const out = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(at), '-i', file, '-frames:v', '1',
    '-vf', 'scale=1:1:flags=area', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'])
  return [...out.subarray(0, 3)]
}
const reddish = ([r, , b]) => r > 150 && b < 100
const bluish = ([r, , b]) => b > 150 && r < 100

test('a reframe is checked: points in order, inside the frame, a limited number', () => {
  const r = normalizeReframe({ path: [[0, 0.2, 0.5], [1, 1.4, -1], [0.5, 0.3, 0.3], ['x', 1, 1], [2, 0.6, 0.5]], offsetX: 3, aspect: 16 / 9 })
  assert.deepEqual(r.path, [[0, 0.2, 0.5], [1, 1, 0], [2, 0.6, 0.5]])
  assert.equal(r.offsetX, 0.5)
  assert.equal(r.offsetY, 0)
  assert.equal(r.aspect, 1.7778)
  assert.equal(normalizeReframe(null), null)
  const many = normalizeReframe({ path: Array.from({ length: 200 }, (_, i) => [i, 0.5, 0.5]) })
  assert.equal(many.path.length, MAX_PATH_POINTS)
})

test('the centre follows the path in straight lines and holds before and after it', () => {
  const r = { path: [[1, 0.2, 0.5], [3, 0.6, 0.3]], offsetX: 0.1 }
  assert.deepEqual(centreAt(r, 0), { cx: 0.3, cy: 0.5 })
  assert.deepEqual(centreAt(r, 2), { cx: 0.5, cy: 0.4 })
  assert.deepEqual(centreAt(r, 9), { cx: 0.7, cy: 0.3 })
  assert.deepEqual(centreAt({ path: [] }, 4), { cx: 0.5, cy: 0.5 })
})

test('the preview pan matches the render window', () => {
  // 16:9 footage in a 9:16 frame: the media is 3.16 frames wide
  const { rx, ry } = coverOverflow(16 / 9, 9 / 16)
  assert.ok(Math.abs(rx - 3.1605) < 0.001)
  assert.equal(ry, 1)
  // render: x = clip(c * iw - 0.5 * ow, 0, iw - ow); pan = x / (iw - ow)
  for (const c of [0, 0.2, 0.5, 0.77, 1]) {
    const iw = 1920 * rx
    const x = Math.min(iw - 1920, Math.max(0, c * iw - 0.5 * 1920))
    assert.ok(Math.abs(panFor(c, rx, 0.5) - x / (iw - 1920)) < 1e-9)
  }
  const box = reframeBox({ path: [[0, 0.8, 0.5]], aspect: 16 / 9 }, 0, 9 / 16)
  assert.equal(box.w, 1)
  assert.equal(box.panY, 0.5)
  assert.ok(box.panX > 0.8)
})

test('the path expression is flat for holds and has one term per slope', () => {
  const e = pathExpr({ path: [[0, 0.2, 0.5], [1, 0.2, 0.5], [2, 0.6, 0.5]] }, 1, 't')
  assert.equal((e.match(/clip\(t-/g) || []).length, 1)
  assert.equal(pathExpr({ path: [] }, 2, 't'), '0.5')
  assert.match(reframeFilter({ path: [[0, 0.1, 0.5], [4, 0.6, 0.5]] }, { w: 1080, h: 1920, startTime: 2.5 }), /\(t\+2\.5\)/)
  assert.equal(reframeFilter(null, { w: 1, h: 1 }), null)
})

test('face samples become a calm, short path: gaps hold, one wrong detection is ignored', () => {
  const samples = []
  for (let i = 0; i < 40; i++) {
    const t = i / 4
    if (i >= 10 && i < 14) samples.push({ t, cx: null }) // no face for a second
    else if (i === 20) samples.push({ t, cx: 0.95, cy: 0.5 }) // one wrong one
    else samples.push({ t, cx: i < 25 ? 0.3 : 0.7, cy: 0.5 })
  }
  const p = smoothPath(samples)
  assert.ok(p.length >= 2 && p.length <= MAX_PATH_POINTS)
  const at = (t) => centreAt({ path: p }, t).cx
  assert.ok(Math.abs(at(3) - 0.3) < 0.04, 'held through the gap')
  assert.ok(at(5) < 0.4, 'the single outlier does not move it')
  assert.ok(at(9.75) > 0.6, 'it follows the real move')
  assert.deepEqual(smoothPath([{ t: 0, cx: null }]), [])
  assert.equal(thinPath(Array.from({ length: 500 }, (_, i) => [i, Math.random(), Math.random()]), 0.001, 20).length <= 20, true)
})

test('only footage framed as it came is reframed', () => {
  assert.equal(isReframable({ type: 'video' }), true)
  assert.equal(isReframable({ type: 'video', zoom: 100 }), true)
  assert.equal(isReframable({ type: 'video', zoom: 150 }), false)
  assert.equal(isReframable({ type: 'video', positionX: 20 }), false)
  assert.equal(isReframable({ type: 'video', layout: { x: 0, y: 0, w: 0.5, h: 0.5 } }), false)
  assert.equal(isReframable({ type: 'image' }), false)
})

test('ffmpeg: the window moves from the left to the right of the source with the path', { skip: !hasFfmpeg }, () => {
  const src = source('lr.mp4')
  const out = path.join(dir, 'lr-out.mp4')
  const vf = reframeFilter({ path: [[0, 0.1, 0.5], [2, 0.9, 0.5]] }, { w: 90, h: 160 })
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', src, '-vf', vf, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', out])
  const probe = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', out]).toString().trim()
  assert.equal(probe, '90,160')
  assert.ok(reddish(colourAt(out, 0)), 'starts on the red left')
  assert.ok(bluish(colourAt(out, 1.85)), 'ends on the blue right')
})

test('ffmpeg: a full render of a reframed 16:9 clip into 9:16, trimmed into its source', { skip: !hasFfmpeg }, async () => {
  const src = source('full.mp4', 3)
  const jobDir = path.join(dir, 'job')
  fs.mkdirSync(jobDir, { recursive: true })
  const out = path.join(dir, 'full-out.mp4')
  // the clip starts 1 s into its file; the path is in file time: the face is
  // on the right from 1.5 s on, so the whole clip shows the blue side
  const timeline = {
    outputWidth: 90, outputHeight: 160, previewWidth: 90, previewHeight: 160, fps: 10,
    tracks: [{ id: 'v', type: 'video', clips: [{ id: 'c1', type: 'video', url: 'x', startTime: 1, endTime: 2.5, timelinePosition: 0, audioEnabled: false, zoom: 100, reframe: { path: [[0, 0.1, 0.5], [1.5, 0.9, 0.5]] } }] }]
  }
  await buildAndRunFFmpeg({ timeline, downloadedFiles: new Map([['c1', src]]), outputPath: out, jobDir, onProgress: () => {} })
  const probe = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', out]).toString().trim()
  assert.equal(probe, '90,160')
  assert.ok(bluish(colourAt(out, 1.2)), 'the window is on the right half (blue)')
  // without the reframe the same clip is letterboxed: mostly black in a 9:16 frame
  const plain = path.join(dir, 'plain-out.mp4')
  const t2 = JSON.parse(JSON.stringify(timeline))
  delete t2.tracks[0].clips[0].reframe
  await buildAndRunFFmpeg({ timeline: t2, downloadedFiles: new Map([['c1', src]]), outputPath: plain, jobDir, onProgress: () => {} })
  const [r, g, b] = colourAt(plain, 1)
  assert.ok(r + g + b < 200, 'letterboxed: dark on average')
})

test('a retimed clip maps its clip time back to the face path in media seconds', () => {
  const path = [[0, 0.3, 0.5], [10, 0.7, 0.5]]
  const plain = reframeFilter({ path }, { w: 1080, h: 1920, startTime: 2 })
  assert.match(plain, /\(t\+2\)/)
  const fast = reframeFilter({ path }, { w: 1080, h: 1920, startTime: 2, mediaTime: '(2+t*2)' })
  assert.match(fast, /\(2\+t\*2\)/)
  assert.doesNotMatch(fast, /\(t\+2\)/)
})
