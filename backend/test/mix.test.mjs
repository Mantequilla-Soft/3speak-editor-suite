// Audio mixing through the real render pipeline (needs ffmpeg on PATH; skipped without it).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let hasFfmpeg = true
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }) } catch { hasFfmpeg = false }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mix-'))
process.env.WORK_DIR = dir
const { buildAndRunFFmpeg } = await import('../src/services/ffmpeg.js')
after(() => fs.rmSync(dir, { recursive: true, force: true }))

const tone = path.join(dir, 'tone.m4a')
before(() => { if (hasFfmpeg) execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=440:d=4', '-c:a', 'aac', tone]) })

async function render(name, audioClips) {
  const tracks = [{ id: 'v', type: 'video', clips: [{ id: 'c', type: 'color', duration: 3, startTime: 0, endTime: 3, timelinePosition: 0, backgroundColor: '#000000' }] },
    { id: 'a', type: 'audio', clips: audioClips }]
  const downloadedFiles = new Map(audioClips.map(c => [c.id, tone]))
  const jobDir = path.join(dir, name); fs.mkdirSync(jobDir, { recursive: true })
  const out = path.join(dir, `${name}.mp4`)
  await buildAndRunFFmpeg({ timeline: { outputWidth: 160, outputHeight: 284, previewWidth: 160, previewHeight: 284, fps: 30, tracks }, downloadedFiles, outputPath: out, jobDir, onProgress: () => {} })
  return out
}
const peak = (file, ss, t) => {
  const r = execFileSync('sh', ['-c', `ffmpeg -nostats -ss ${ss} -t ${t} -i "${file}" -af volumedetect -f null - 2>&1 | grep max_volume || true`], { encoding: 'utf8' })
  const m = /max_volume: (-?[\d.]+|-inf) dB/.exec(r)
  return m ? (m[1] === '-inf' ? -Infinity : +m[1]) : -Infinity
}
const clip = (id, extra = {}) => ({ id, type: 'audio', name: id, duration: 4, startTime: 0, endTime: 3, timelinePosition: 0, volume: 50, ...extra })

test('two overlapping sources add up instead of being divided by the number of inputs', { skip: !hasFfmpeg }, async () => {
  const one = peak(await render('one', [clip('a')]), 0.5, 1)
  const two = peak(await render('two', [clip('a'), clip('b')]), 0.5, 1)
  assert.ok(two > one + 3, `one ${one} dB, two ${two} dB`)
})

test('fade in starts silent and fade out ends silent', { skip: !hasFfmpeg }, async () => {
  const f = await render('fades', [clip('m', { fadeIn: 1, fadeOut: 1 })])
  assert.ok(peak(f, 0, 0.05) < peak(f, 1.2, 0.5) - 20, 'start is much quieter than the middle')
  assert.ok(peak(f, 2.93, 0.06) < peak(f, 1.2, 0.5) - 20, 'end is much quieter than the middle')
})
