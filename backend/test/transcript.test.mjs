// Transcripts of whole shows: chunk planning with seams that keep every word
// once, the verbatim prompt (so "um" and "uh" are written down), and the route
// end to end through real ffmpeg with a stand-in whisper-cli (a small script
// that "hears" one word a second and logs how it was called).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-'))
process.env.UPLOAD_DIR = path.join(dir, 'uploads')
process.env.WORK_DIR = path.join(dir, 'work')
process.env.RENDERED_DIR = path.join(dir, 'rendered')
process.env.EDITOR_TOKEN_SECRET = 'test-secret'
fs.mkdirSync(process.env.RENDERED_DIR, { recursive: true })

// The stand-in whisper: a word every second of the WAV it is given ("w0", "w1", ... in its own
// time), the language it was told (or "de" for auto), and one log line per call
const LOG = path.join(dir, 'whisper.log')
const FAKE = path.join(dir, 'whisper-cli')
fs.writeFileSync(FAKE, `#!/usr/bin/env node
const fs = require('fs')
const a = process.argv.slice(2)
const arg = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null }
const wav = arg('-f'), out = arg('-of'), lang = arg('-l'), prompt = arg('--prompt')
const seconds = (fs.statSync(wav).size - 44) / 32000
fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({ lang, prompt, seconds: Math.round(seconds * 10) / 10 }) + '\\n')
const transcription = []
for (let t = 0.2; t + 0.5 <= seconds; t += 1) transcription.push({ text: ' w' + Math.round(t - 0.2), offsets: { from: Math.round(t * 1000), to: Math.round((t + 0.5) * 1000) } })
fs.writeFileSync(out + '.json', JSON.stringify({ result: { language: lang === 'auto' ? 'de' : lang }, transcription }))
`, { mode: 0o755 })
const MODEL = path.join(dir, 'model.bin')
fs.writeFileSync(MODEL, 'x')
process.env.WHISPER_BIN = FAKE
process.env.WHISPER_MODEL = MODEL

const T = await import('../src/services/transcript.js')
const { whisperArgs } = await import('../src/services/stt.js')
const { verbatimPrompt } = await import('../src/utils/verbatimPrompts.js')
const express = (await import('express')).default
const { transcriptRouter } = await import('../src/routes/transcript.js')

let hasFfmpeg = true
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }) } catch { hasFfmpeg = false }

const mid = Buffer.from(JSON.stringify({ u: 'badadib', exp: Date.now() + 600000 })).toString('base64url')
const token = `v1.${mid}.${crypto.createHmac('sha256', 'test-secret').update(mid).digest('hex')}`
const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }

let server, base
before(async () => {
  const app = express()
  app.use(express.json())
  app.use('/api/transcript', transcriptRouter)
  server = app.listen(0)
  await new Promise(r => server.once('listening', r))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }) })

test('ranges are cleaned, sorted and joined', () => {
  assert.deepEqual(T.mergeRanges([[10, 20], [0, 5], [19.8, 30], [-3, 1], [8, 7], ['x', 2]]), [[0, 5], [10, 30]])
  assert.deepEqual(T.mergeRanges([[0, 5], [5.4, 6]]), [[0, 6]])
  assert.deepEqual(T.mergeRanges([[0, 5], [5.6, 6]]), [[0, 5], [5.6, 6]])
})

test('chunks: equal pieces up to 5 minutes, read with overlap, each word kept once', () => {
  assert.deepEqual(T.planChunks([0, 100]), [{ from: 0, to: 100, keepFrom: 0, keepTo: 100 }])
  const plan = T.planChunks([0, 610])
  assert.equal(plan.length, 3)
  assert.ok(plan.every(c => c.keepTo - c.keepFrom <= 300))
  assert.deepEqual(plan.map(c => [c.from, c.to]), [[0, 205.333], [201.333, 408.667], [404.667, 610]])
  // a word just before the seam at 203.333 (middle 203.2): the first chunk keeps it, the second does not
  const seam = { text: 'x', start: 203, end: 203.4 }
  assert.equal(T.ownWords([seam], plan[0]).length, 1)
  assert.equal(T.ownWords([seam], plan[1]).length, 0)
  const past = { text: 'y', start: 203.3, end: 203.7 }
  assert.equal(T.ownWords([past], plan[0]).length, 0)
  assert.equal(T.ownWords([past], plan[1]).length, 1)
})

test('sources are checked: ids, urls, length limit', () => {
  assert.match(T.cleanSources({}, 100).error, /Nothing/)
  assert.match(T.cleanSources({ sources: [{ id: 'a b', url: 'u', ranges: [[0, 1]] }] }, 100).error, /id/)
  assert.match(T.cleanSources({ sources: [{ id: 'a', ranges: [[0, 1]] }] }, 100).error, /url/)
  assert.match(T.cleanSources({ sources: [{ id: 'a', url: 'u', ranges: [[0, 200]] }] }, 100).error, /up to/)
  const ok = T.cleanSources({ sources: [{ id: 'lib_1_2', url: '/rendered/a.mp3', ranges: [[0, 10], [5, 20]] }, { id: 'b', url: 'u', ranges: [] }] }, 100)
  assert.deepEqual(ok, { sources: [{ id: 'lib_1_2', url: '/rendered/a.mp3', ranges: [[0, 20]] }], total: 20 })
})

test('the verbatim prompt goes to whisper, only when there is one', () => {
  const a = whisperArgs({ model: 'm', threads: 1 }, 'a.wav', 'a', 'en', verbatimPrompt('en'))
  assert.equal(a[a.length - 2], '--prompt')
  assert.match(a[a.length - 1], /Umm/)
  assert.ok(!whisperArgs({ model: 'm', threads: 1 }, 'a.wav', 'a', 'en', '').includes('--prompt'))
  assert.equal(verbatimPrompt('xx'), '')
  for (const lang of ['en', 'de', 'es', 'fr', 'pt', 'it', 'nl', 'pl']) assert.ok(verbatimPrompt(lang).length > 10, lang)
})

async function waitFor(jobId) {
  let next = 0
  const chunks = []
  for (let i = 0; i < 300; i++) {
    const s = await (await fetch(`${base}/api/transcript/${jobId}?from=${next}`)).json()
    chunks.push(...s.chunks)
    next = s.next
    if (s.status === 'completed' || s.status === 'failed' || s.status === 'cancelled') return { ...s, chunks }
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error('timed out')
}

test('a 10-minute recording is transcribed in 3 chunks: every word once, in the file\'s own seconds', { skip: !hasFfmpeg, timeout: 120000 }, async () => {
  const show = path.join(process.env.RENDERED_DIR, 'show.mp3')
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=220:d=610:r=16000', '-c:a', 'libmp3lame', '-b:a', '32k', show])
  fs.writeFileSync(LOG, '')
  assert.equal((await fetch(`${base}/api/transcript`, { method: 'POST' })).status, 401)
  const r = await fetch(`${base}/api/transcript`, { method: 'POST', headers: auth, body: JSON.stringify({ sources: [{ id: 'lib_1', url: '/rendered/show.mp3', ranges: [[0, 610]] }], language: 'auto' }) })
  assert.equal(r.status, 200)
  const done = await waitFor((await r.json()).jobId)
  assert.equal(done.status, 'completed', done.error)
  assert.equal(done.language, 'de')
  assert.equal(done.chunks.length, 3)
  const words = done.chunks.flatMap(c => c.words)
  // one word a second, none lost or doubled at the seams (the stand-in hears on its own grid, so a seam may shift a word)
  const starts = words.map(w => w.start)
  assert.ok(Math.abs(words.length - 609) <= 2, `${words.length} words`)
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] > 0.5 && starts[i] - starts[i - 1] < 1.5, `gap at ${starts[i]}`)
  // the language was found on a short sample, then every chunk ran in it with the German prompt
  const calls = fs.readFileSync(LOG, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.equal(calls[0].lang, 'auto')
  assert.equal(calls[0].prompt, null)
  assert.ok(calls[0].seconds <= 30.1)
  assert.deepEqual(calls.slice(1).map(c => c.lang), ['de', 'de', 'de'])
  assert.ok(calls.slice(1).every(c => /Ähm/.test(c.prompt)))
})

test('only the parts in use are transcribed; a stopped job keeps what it did', { skip: !hasFfmpeg, timeout: 60000 }, async () => {
  fs.writeFileSync(LOG, '')
  const r = await fetch(`${base}/api/transcript`, { method: 'POST', headers: auth, body: JSON.stringify({ sources: [{ id: 'lib_1', url: '/rendered/show.mp3', ranges: [[100, 110], [400, 405]] }], language: 'en', verbatim: false }) })
  const done = await waitFor((await r.json()).jobId)
  assert.equal(done.status, 'completed')
  assert.deepEqual(done.chunks.map(c => [c.from, c.to]), [[100, 110], [400, 405]])
  const words = done.chunks.flatMap(c => c.words)
  assert.ok(words.every(w => (w.start >= 100 && w.end <= 110) || (w.start >= 400 && w.end <= 405)))
  const calls = fs.readFileSync(LOG, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.deepEqual(calls.map(c => c.lang), ['en', 'en'])
  assert.ok(calls.every(c => c.prompt === null))

  const missing = await fetch(`${base}/api/transcript`, { method: 'POST', headers: auth, body: JSON.stringify({ sources: [{ id: 'x', url: '/rendered/nope.mp3', ranges: [[0, 5]] }] }) })
  const failed = await waitFor((await missing.json()).jobId)
  assert.equal(failed.status, 'failed')
  assert.ok(failed.error)
  assert.equal((await fetch(`${base}/api/transcript/nope`)).status, 404)
})
