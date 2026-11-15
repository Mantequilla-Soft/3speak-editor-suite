// Video podcast: a whole episode as a 16:9 video (options, the ASS of captions
// and speaker names, the ffmpeg graph through real ffmpeg, and the route).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let hasFfmpeg = true
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }) } catch { hasFfmpeg = false }
let hasAss = false
try { hasAss = /\sass\s+V->V/.test(execFileSync('ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8' })) } catch {}
// The stills need Chromium (playwright-core; CHROMIUM_PATH points at one locally)
let hasChromium = false
try {
  const { chromium } = await import('playwright-core')
  const { chromiumPath } = await import('../src/services/audiogramPage.js')
  const b = await chromium.launch({ executablePath: chromiumPath(), headless: false, args: ['--headless=new', '--no-sandbox'] })
  await b.close()
  hasChromium = true
} catch {}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-podcast-'))
const rendered = path.join(dir, 'rendered')
fs.mkdirSync(rendered, { recursive: true })
process.env.RENDERED_DIR = rendered
process.env.WORK_DIR = path.join(dir, 'work')
process.env.UPLOAD_DIR = path.join(dir, 'uploads')
process.env.EDITOR_TOKEN_SECRET = 'test-secret'
process.env.CAPTIONS_ENABLED = 'false' // no whisper in tests: words come with the request
const express = (await import('express')).default
const { videoPodcastRouter } = await import('../src/routes/videoPodcast.js')
const { cleanVideoPodcastOptions, cleanSpeakers, podcastAss, podcastSubtitles, podcastLayers, podcastPageState, videoPodcastArgs, PODCAST_LAYOUTS } = await import('../src/services/videoPodcast.js')
const { waveFilter } = await import('../src/services/audiogram.js')
const { waveBox } = await import('../src/services/audiogramPage.js')

const mint = (u) => {
  const mid = Buffer.from(JSON.stringify({ u, exp: Date.now() + 60000 })).toString('base64url')
  return `v1.${mid}.${crypto.createHmac('sha256', 'test-secret').update(mid).digest('hex')}`
}
let server, base
before(async () => {
  const app = express()
  app.use(express.json({ limit: '5mb' }))
  app.use('/api/video-podcast', videoPodcastRouter)
  server = app.listen(0)
  await new Promise(r => server.once('listening', r))
  base = `http://127.0.0.1:${server.address().port}`
  if (hasFfmpeg) execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=300:d=8', '-c:a', 'libmp3lame', path.join(rendered, 'episode.mp3')])
})
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }) })

const words = (n, from = 0) => Array.from({ length: n }, (_, i) => ({ text: `w${i}`, start: from + i * 0.4, end: from + i * 0.4 + 0.3 }))

test('options: a frame rate of 15 or 24, the look from the audiogram style, words and speakers checked', () => {
  const o = cleanVideoPodcastOptions({ title: '  The   show ', fps: 60, style: { wave: { type: 'ring', color: '#7f88ea' }, logo: 'mark' }, captions: { on: true, words: [{ text: 'hi', start: 1, end: 1.2 }, { text: '', start: 2, end: 3 }] }, speakers: [{ start: 0, end: 5, name: 'badadib' }] })
  assert.equal(o.title, 'The show')
  assert.equal(o.fps, 15)
  assert.equal(cleanVideoPodcastOptions({ fps: 24 }).fps, 24)
  assert.deepEqual(o.style.wave, { type: 'ring', color: '#7f88ea' })
  assert.equal(o.style.logo, 'mark')
  assert.equal(o.captions.on, true)
  assert.deepEqual(o.captions.words, [{ text: 'hi', start: 1, end: 1.2 }])
  assert.deepEqual(o.speakers, [{ start: 0, end: 5, name: 'badadib' }])
  assert.equal(cleanVideoPodcastOptions({}).captions.on, false)
})

test('speakers: in order, never overlapping, names cleaned, at most 8 people', () => {
  const s = cleanSpeakers([{ start: 4, end: 9, name: 'fan' }, { start: 0, end: 5, name: 'bada{\\b1}dib\n' }, { start: 9, end: 8, name: 'x' }, { start: 1, end: 2 }])
  assert.deepEqual(s, [{ start: 0, end: 4, name: 'bada b1 dib' }, { start: 4, end: 9, name: 'fan' }])
  const many = cleanSpeakers(Array.from({ length: 12 }, (_, i) => ({ start: i, end: i + 1, name: `p${i}` })))
  assert.equal(new Set(many.map(x => x.name)).size, 8)
})

test('the ASS: speaker labels in the 3Speak red, captions paged in chunks for long episodes', () => {
  const ass = podcastAss({ words: words(9000), speakers: [{ start: 0, end: 3, name: 'badadib' }], withCover: true })
  assert.match(ass, /^Style: Cap,Poppins/m)
  assert.match(ass, /^Style: Spk,Roboto,40,&H00FFFFFF,&H00FFFFFF,&H003329E3/m)
  assert.match(ass, /Dialogue: 1,0:00:00\.00,0:00:03\.00,Spk,,0,0,0,,\{\\an8\\pos\(1335,616\)\\fad\(120,120\)\}badadib/)
  const caps = ass.split('\n').filter(l => /,Cap,/.test(l))
  assert.ok(caps.length > 1500, `${caps.length} caption events`)
  assert.match(caps.at(-1), /w8999/, 'the last word is in it (past the 4000 of one caption set)')
  const noCaps = podcastAss({ words: [], speakers: [{ start: 0, end: 1, name: 'fan' }], withCover: false })
  assert.doesNotMatch(noCaps, /Style: Cap/)
  assert.match(noCaps, /\\an8\\pos\(960,594\)/)
  assert.equal(podcastAss({}), null)
  const subs = podcastSubtitles(words(9000))
  assert.match(subs.vtt, /^WEBVTT/)
  assert.match(subs.srt, /w8999/)
})

test('the layout: a 16:9 page with the cover on the left, or one centred column', () => {
  const st = podcastPageState({ title: 't', line: 'l', style: { wave: { type: 'bars', color: '#e32933' }, logo: 'full' }, image: 'data:image/png;base64,AA' })
  assert.equal(st.width, 1920)
  assert.equal(st.height, 1080)
  assert.equal(st.layers.cover.on, true)
  assert.equal(podcastLayers(false).cover.on, false)
  for (const set of Object.values(PODCAST_LAYOUTS)) {
    for (const [id, l] of Object.entries(set)) {
      if (id === 'speaker') continue
      assert.ok(l.x >= 0 && l.y >= 0 && l.x + l.w <= 1920 && l.y + l.h <= 1080, `${id} inside the frame`)
    }
  }
  assert.match(waveFilter('bars', 870, 150, '#e32933', 15), /rate=15/)
  assert.match(waveFilter('line', 870, 150, '#e32933'), /rate=30/)
})

test('ffmpeg: the graph renders a 16:9 MP4 at 15 fps with the speaker label burnt in', { skip: !hasFfmpeg || !hasAss }, () => {
  const below = path.join(dir, 'below.png')
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x0a0b12:s=1920x1080', '-frames:v', '1', below])
  const ass = path.join(dir, 'p.ass')
  fs.writeFileSync(ass, podcastAss({ words: words(10, 4), speakers: [{ start: 0, end: 3, name: 'badadib' }], withCover: true }))
  const out = path.join(dir, 'vp.mp4')
  const style = { wave: { type: 'bars', color: '#e32933' }, logo: 'full' }
  const box = waveBox(PODCAST_LAYOUTS.cover.wave, 'bars')
  execFileSync('ffmpeg', videoPodcastArgs({ input: path.join(rendered, 'episode.mp3'), below, box, ass, output: out, duration: 8, fps: 15, style }))
  const p = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height,r_frame_rate:format=duration', '-of', 'json', out], { encoding: 'utf8' }))
  const v = p.streams.find(s => s.codec_name === 'h264')
  assert.equal(v.width, 1920)
  assert.equal(v.height, 1080)
  assert.equal(v.r_frame_rate, '15/1')
  assert.ok(p.streams.some(s => s.codec_name === 'aac'))
  assert.ok(Math.abs(+p.format.duration - 8) < 0.2, `duration ${p.format.duration}`)
  // the red label while badadib speaks (0-3 s), gone afterwards
  const px = (t) => [...execFileSync('ffmpeg', ['-loglevel', 'error', '-ss', String(t), '-i', out, '-frames:v', '1', '-vf', 'crop=4:4:1318:609', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']).subarray(0, 3)]
  const [r1, g1] = px(2)
  assert.ok(r1 > 150 && g1 < 90, `red label at 2 s: ${px(2)}`)
  const [r2] = px(6)
  assert.ok(r2 < 60, `no label at 6 s: ${px(6)}`)
})

const post = async (body) => {
  const r = await fetch(`${base}/api/video-podcast`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${mint('badadib')}` }, body: JSON.stringify(body) })
  return [r.status, await r.json()]
}

test('the route makes the video podcast of our own export, with its subtitles', { skip: !hasFfmpeg || !hasChromium }, async () => {
  const [status, { jobId }] = await post({
    url: 'https://elsewhere.example/rendered/episode.mp3',
    title: 'Episode one', fps: 15,
    style: { wave: { type: 'circle', color: '#e32933' } },
    captions: { on: true, words: words(12, 1), language: 'en' },
    speakers: [{ start: 0, end: 4, name: 'badadib' }, { start: 4, end: 8, name: 'fan' }]
  })
  assert.equal(status, 200)
  let job
  for (let i = 0; i < 1200; i++) {
    job = await (await fetch(`${base}/api/video-podcast/${jobId}`)).json()
    if (job.status === 'completed' || job.status === 'failed') break
    await new Promise(r => setTimeout(r, 100))
  }
  assert.equal(job.status, 'completed', job.error)
  assert.match(job.outputUrl, /^\/rendered\/video-podcast-[0-9a-f-]+\.mp4$/)
  assert.ok(Math.abs(job.durationSec - 8) < 0.2)
  assert.equal(job.subtitles.language, 'en')
  assert.equal(job.subtitles.burnedIn, hasAss)
  assert.ok(fs.existsSync(path.join(rendered, path.basename(job.subtitles.vttUrl))))
  const p = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'json', path.join(rendered, path.basename(job.outputUrl))], { encoding: 'utf8' }))
  assert.equal(p.streams.find(s => s.width).width, 1920)
  assert.equal(fs.readdirSync(rendered).filter(f => f.includes('.part')).length, 0, 'no part file left')
})

test('the route says what it can do, wants a url and a sign-in, and knows no unknown jobs', async () => {
  const s = await (await fetch(`${base}/api/video-podcast/status`)).json()
  assert.equal(s.captions, false)
  assert.equal(s.maxSeconds, 3 * 60 * 60)
  assert.equal((await post({}))[0], 400)
  const anon = await fetch(`${base}/api/video-podcast`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: '/rendered/episode.mp3' }) })
  assert.equal(anon.status, 401)
  assert.equal((await fetch(`${base}/api/video-podcast/nope`)).status, 404)
})
