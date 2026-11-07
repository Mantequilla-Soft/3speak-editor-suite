// Audio mode through the HTTP routes: POST /api/render with output 'audio'
// (MP3 out, limits, cache) and POST /api/clip/audio-analysis (server-side
// loudness + peaks for files too big for the browser).
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let hasFfmpeg = true
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }) } catch { hasFfmpeg = false }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-routes-'))
const uploads = path.join(dir, 'uploads')
const rendered = path.join(dir, 'rendered')
fs.mkdirSync(uploads, { recursive: true })
process.env.UPLOAD_DIR = uploads
process.env.UPLOADS_DIR = uploads
process.env.RENDERED_DIR = rendered
process.env.WORK_DIR = path.join(dir, 'work')
process.env.EDITOR_TOKEN_SECRET = 'test-secret'
const express = (await import('express')).default
const { renderRouter, MAX_AUDIO_RENDER_SECONDS } = await import('../src/routes/render.js')
const { clipRouter, createAnalyser, ANALYSIS_RATE, ANALYSIS_WINDOW } = await import('../src/routes/clip.js')

const mint = (u) => {
  const mid = Buffer.from(JSON.stringify({ u, exp: Date.now() + 60000 })).toString('base64url')
  return `v1.${mid}.${crypto.createHmac('sha256', 'test-secret').update(mid).digest('hex')}`
}
let server, base
before(async () => {
  const app = express()
  app.use(express.json({ limit: '5mb' }))
  app.use('/api/render', renderRouter)
  app.use('/api/clip', clipRouter)
  server = app.listen(0)
  await new Promise(r => server.once('listening', r))
  base = `http://127.0.0.1:${server.address().port}`
  if (hasFfmpeg) {
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=440:d=6', '-af', 'volume=6dB', path.join(uploads, 'voice.wav')])
    // 2 s tone, 2 s silence, 2 s tone
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=440:d=2', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=2',
      '-filter_complex', '[0:a][1:a][0:a]concat=n=3:v=0:a=1', path.join(uploads, 'pause.wav')])
  }
})
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }) })

const post = async (p, body, { auth = true } = {}) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${mint('alice')}` } : {}) }, body: JSON.stringify(body) })
  return [r.status, await r.json().catch(() => null)]
}
const audioTimeline = (clips, extra = {}) => ({ output: 'audio', master: { loudness: false }, tracks: [{ id: 't', type: 'audio', clips }], ...extra })
const clip = (id, extra = {}) => ({ id, type: 'audio', name: id, url: '/api/upload/files/voice.wav', startTime: 0, endTime: 2, timelinePosition: 0, volume: 100, ...extra })

async function finish(jobId) {
  for (let i = 0; i < 200; i++) {
    const job = await (await fetch(`${base}/api/render/${jobId}`)).json()
    if (['completed', 'failed', 'aborted'].includes(job.status)) return job
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error('render did not finish')
}

describe('POST /api/render, output audio', () => {
  test('needs a sign-in like every render', async () => {
    assert.equal((await post('/api/render', { timeline: audioTimeline([clip('a')]) }, { auth: false }))[0], 401)
  })

  test('empty or muted audio is refused up front', async () => {
    const [s, b] = await post('/api/render', { timeline: audioTimeline([]) })
    assert.equal(s, 400)
    assert.match(b.error, /Nothing to render/)
    const [s2] = await post('/api/render', { timeline: { output: 'audio', tracks: [{ id: 't', type: 'audio', muted: true, clips: [clip('a')] }] } })
    assert.equal(s2, 400)
  })

  test(`over ${MAX_AUDIO_RENDER_SECONDS / 3600} hours is refused up front`, async () => {
    const [s, b] = await post('/api/render', { timeline: audioTimeline([clip('a', { timelinePosition: MAX_AUDIO_RENDER_SECONDS })]) })
    assert.equal(s, 400)
    assert.match(b.error, /limit is 3 hours/)
  })

  test('renders an MP3 and an unchanged timeline reuses it', { skip: !hasFfmpeg }, async () => {
    const timeline = audioTimeline([clip('a', { endTime: 1.5 }), clip('b', { startTime: 3, endTime: 4, timelinePosition: 2 })])
    const [s, { jobId }] = await post('/api/render', { timeline })
    assert.equal(s, 200)
    const job = await finish(jobId)
    assert.equal(job.status, 'completed', job.error)
    assert.match(job.outputUrl, /^\/rendered\/[0-9a-f-]+\.mp3$/)
    const file = path.join(rendered, path.basename(job.outputUrl))
    const p = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,format_name', '-of', 'json', file], { encoding: 'utf8' }))
    assert.equal(p.format.format_name, 'mp3')
    assert.ok(Math.abs(+p.format.duration - 3) < 0.08, `duration ${p.format.duration}`)

    const [, again] = await post('/api/render', { timeline })
    const reused = await finish(again.jobId)
    assert.equal(reused.status, 'completed')
    assert.match(reused.outputUrl, /^\/rendered\/cache-[0-9a-f]+\.mp3$/)
    assert.match(reused.phase, /nothing changed/)
  })

  test('a video timeline still renders an MP4 (unchanged path)', { skip: !hasFfmpeg }, async () => {
    const [, { jobId }] = await post('/api/render', { timeline: { outputWidth: 160, outputHeight: 284, previewWidth: 160, fps: 30, tracks: [{ id: 'v', type: 'video', clips: [{ id: 'c', type: 'color', duration: 1, startTime: 0, endTime: 1, timelinePosition: 0, backgroundColor: '#000000' }] }] } })
    const job = await finish(jobId)
    assert.equal(job.status, 'completed', job.error)
    assert.match(job.outputUrl, /\.mp4$/)
  })
})

describe('createAnalyser', () => {
  const floats = (values) => {
    const b = Buffer.alloc(values.length * 4)
    values.forEach((v, i) => b.writeFloatLE(v, i * 4))
    return b
  }

  test('RMS dB and peaks per window, whatever the chunk boundaries', () => {
    const a = createAnalyser(4)
    // window 1: constant 0.5 (RMS 0.5 = -6.0 dB), window 2: silence, window 3: partial (two samples of -1)
    const all = floats([0.5, -0.5, 0.5, -0.5, 0, 0, 0, 0, -1, -1])
    a.push(all.subarray(0, 7)) // splits a float in two
    a.push(all.subarray(7, 21))
    a.push(all.subarray(21))
    const { db, peaks } = a.end()
    assert.deepEqual(db, [-6, -90, 0])
    assert.deepEqual(peaks, [0.5, 0, 1])
  })

  test('the default window is 20 ms at 8 kHz', () => {
    assert.equal(ANALYSIS_WINDOW / ANALYSIS_RATE, 0.02)
  })
})

describe('POST /api/clip/audio-analysis', () => {
  test('needs a sign-in and one of our uploads', async () => {
    assert.equal((await post('/api/clip/audio-analysis', { url: '/api/upload/files/voice.wav' }, { auth: false }))[0], 401)
    assert.equal((await post('/api/clip/audio-analysis', { url: 'https://elsewhere.example/a.wav' }))[0], 400)
    assert.equal((await post('/api/clip/audio-analysis', { url: '/api/upload/files/missing.wav' }))[0], 404)
  })

  test('finds the pause in a recording and caches the result', { skip: !hasFfmpeg }, async () => {
    const [s, b] = await post('/api/clip/audio-analysis', { url: 'https://editor.example/api/upload/files/pause.wav' })
    assert.equal(s, 200)
    assert.equal(b.step, 0.02)
    assert.ok(Math.abs(b.duration - 6) < 0.05, `duration ${b.duration}`)
    assert.equal(b.db.length, b.peaks.length)
    const at = (t) => b.db[Math.floor(t / b.step)]
    assert.ok(at(1) > -30, `tone is loud: ${at(1)}`)
    assert.equal(at(3), -90, 'the pause is silent')
    assert.ok(at(5) > -30)
    assert.ok(Math.max(...b.peaks.slice(0, 50)) > 0.1)
    assert.ok(fs.existsSync(path.join(uploads, 'pause.audio.json')))
    // a second call is served from the cache (even with the file gone)
    fs.renameSync(path.join(uploads, 'pause.wav'), path.join(uploads, 'pause-moved.wav'))
    fs.writeFileSync(path.join(uploads, 'pause.wav'), '')
    const [s2, again] = await post('/api/clip/audio-analysis', { url: '/api/upload/files/pause.wav' })
    assert.equal(s2, 200)
    assert.deepEqual(again.db, b.db)
  })
})
