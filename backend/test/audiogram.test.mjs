// Audiogram: the share video of a piece of an exported episode (title wrap,
// option checks, and a real render through the route).
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let hasFfmpeg = true
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }) } catch { hasFfmpeg = false }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audiogram-'))
const rendered = path.join(dir, 'rendered')
fs.mkdirSync(rendered, { recursive: true })
process.env.RENDERED_DIR = rendered
process.env.WORK_DIR = path.join(dir, 'work')
process.env.UPLOAD_DIR = path.join(dir, 'uploads')
process.env.EDITOR_TOKEN_SECRET = 'test-secret'
const express = (await import('express')).default
const { audiogramRouter } = await import('../src/routes/audiogram.js')
const { wrapTitle, cleanAudiogramOptions, audiogramArgs, AUDIOGRAM_MAX_SECONDS } = await import('../src/services/audiogram.js')

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

describe('audiogram planning', () => {
  test('wrapTitle: lines that fit, long words broken, at most three lines', () => {
    assert.deepEqual(wrapTitle('My Podcast Episode 12: The one with the guest'), ['My Podcast Episode', '12: The one with the', 'guest'])
    assert.deepEqual(wrapTitle('x'.repeat(45)), ['x'.repeat(20), 'x'.repeat(20), 'x'.repeat(5)])
    assert.deepEqual(wrapTitle('one two three four five six seven eight nine ten eleven twelve thirteen'), ['one two three four', 'five six seven eight', 'nine ten eleven…'])
    assert.deepEqual(wrapTitle('  '), [])
  })

  test('cleanAudiogramOptions: 3 to 60 seconds from 0 on, square unless vertical', () => {
    assert.deepEqual(cleanAudiogramOptions({ start: 12.34567, duration: 30, format: 'vertical' }), { start: 12.346, duration: 30, format: 'vertical' })
    assert.equal(cleanAudiogramOptions({ start: 0, duration: 30, format: 'nope' }).format, 'square')
    for (const bad of [{ start: -1, duration: 10 }, { start: 0, duration: 2 }, { start: 0, duration: AUDIOGRAM_MAX_SECONDS + 1 }, { start: 'a', duration: 10 }, {}]) {
      assert.ok(cleanAudiogramOptions(bad).error, JSON.stringify(bad))
    }
  })

  test('audiogramArgs: cut from start, title from its file, the right size', () => {
    const args = audiogramArgs({ input: '/in.mp3', output: '/o.mp4', start: 5, duration: 15, format: 'vertical', titleFile: '/t.txt', font: 'font=Sans' })
    assert.deepEqual(args.slice(args.indexOf('-ss'), args.indexOf('-ss') + 6), ['-ss', '5', '-t', '15', '-i', '/in.mp3'])
    const graph = args[args.indexOf('-filter_complex') + 1]
    assert.match(graph, /color=c=0x0f0f0f:s=1080x1920/)
    assert.match(graph, /textfile='\/t\.txt'/)
    assert.equal(args.at(-1), '/o.mp4')
    assert.doesNotMatch(audiogramArgs({ input: '/a', output: '/b', start: 0, duration: 5, format: 'square', titleFile: '/t', hasTitle: false, font: 'font=Sans' })[8], /textfile/)
  })
})

test('the route renders an MP4 of the asked piece from our own export', { skip: !hasFfmpeg }, async () => {
  const [status, { jobId }] = await post({ url: 'https://elsewhere.example/rendered/episode.mp3?x=1', start: 4, duration: 6, format: 'square', title: 'Episode: "quotes", colons: and \\ backslashes' })
  assert.equal(status, 200)
  let job
  for (let i = 0; i < 300; i++) {
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

test('the route refuses bad options and unknown jobs', async () => {
  assert.equal((await post({ start: 0, duration: 10 }))[0], 400)
  assert.equal((await post({ url: '/rendered/episode.mp3', start: 0, duration: 120 }))[0], 400)
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
