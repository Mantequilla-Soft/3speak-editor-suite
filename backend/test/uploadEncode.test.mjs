// Uploads: only real video gets a 480p copy (which replaces the original).
// A browser voice recording is .webm too but holds no picture: it must stay
// as uploaded, or the render (which copies the original) can't find it.
// And a render still finds an upload whose original was already replaced.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let hasFfmpeg = true
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }) } catch { hasFfmpeg = false }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-encode-'))
const uploads = path.join(dir, 'uploads')
fs.mkdirSync(uploads, { recursive: true })
process.env.UPLOAD_DIR = uploads
process.env.UPLOADS_DIR = uploads
process.env.EDITOR_TOKEN_SECRET = 'test-secret'
const express = (await import('express')).default
const { uploadRouter } = await import('../src/routes/upload.js')
const { downloadMedia } = await import('../src/utils/download.js')

const mint = (u) => {
  const mid = Buffer.from(JSON.stringify({ u, exp: Date.now() + 60000 })).toString('base64url')
  return `v1.${mid}.${crypto.createHmac('sha256', 'test-secret').update(mid).digest('hex')}`
}
let server, base
before(async () => {
  const app = express()
  app.use('/api/upload', uploadRouter)
  server = app.listen(0)
  await new Promise(r => server.once('listening', r))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }) })

async function upload(file, name, type) {
  const form = new FormData()
  form.append('file', new Blob([fs.readFileSync(file)], { type }), name)
  const r = await fetch(`${base}/api/upload`, { method: 'POST', headers: { Authorization: `Bearer ${mint('alice')}` }, body: form })
  return r.json()
}

test('a voice recording (.webm, audio only) is kept as uploaded: no 480p copy', { skip: !hasFfmpeg }, async () => {
  const src = path.join(dir, 'voice.webm')
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=440:d=2', '-c:a', 'libopus', src])
  const body = await upload(src, 'Recording_x.webm', 'audio/webm')
  assert.equal(body.encodes, false)
  await new Promise(r => setTimeout(r, 1500))
  assert.ok(fs.existsSync(path.join(uploads, body.filename)), 'original still there')
  assert.ok(!fs.existsSync(path.join(uploads, body.filename.replace(/\.webm$/, '_480p.mp4'))))
})

test('a video .webm still gets its 480p copy', { skip: !hasFfmpeg }, async () => {
  const src = path.join(dir, 'clip.webm')
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=d=1:s=320x240:r=10', '-c:v', 'libvpx', '-b:v', '200k', src])
  const body = await upload(src, 'clip.webm', 'video/webm')
  assert.equal(body.encodes, true)
})

test('a render copy falls back to the 480p file once the original was replaced', async () => {
  const work = path.join(dir, 'work')
  fs.mkdirSync(work, { recursive: true })
  fs.writeFileSync(path.join(uploads, 'gone_480p.mp4'), 'encoded')
  const out = await downloadMedia('/api/upload/files/gone.webm', 'c1', work)
  assert.equal(path.basename(out), 'c1.mp4')
  assert.equal(fs.readFileSync(out, 'utf8'), 'encoded')
  // a ?v=480p suffix (the editor's playable-copy URL) is not part of the name
  const out2 = await downloadMedia('/api/upload/files/gone.webm?v=480p', 'c2', work)
  assert.equal(fs.readFileSync(out2, 'utf8'), 'encoded')
  await assert.rejects(downloadMedia('/api/upload/files/nothing.webm', 'c3', work), /ENOENT/)
})

// MediaRecorder WebM has no Cues: the browser then reads through the file to
// seek, and clips from late in a long recording started late in the preview
const hasCues = (file) => fs.readFileSync(file).includes(Buffer.from([0x1c, 0x53, 0xbb, 0x6b]))
const pcm = (file) => crypto.createHash('md5').update(execFileSync('ffmpeg', ['-loglevel', 'error', '-i', file, '-f', 's16le', '-ac', '1', '-'], { maxBuffer: 64 << 20 })).digest('hex')

test('a browser voice recording without a seek index gets one on upload, same audio', { skip: !hasFfmpeg }, async () => {
  const src = path.join(dir, 'live.webm')
  // -live 1: no Cues, like a MediaRecorder recording
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=300:d=20', '-c:a', 'libopus', '-live', '1', '-f', 'webm', src])
  assert.equal(hasCues(src), false, 'test file has no index')
  const body = await upload(src, 'Recording_long.webm', 'audio/webm')
  assert.equal(body.encodes, false)
  const stored = path.join(uploads, body.filename)
  assert.equal(hasCues(stored), true, 'index added')
  assert.ok(fs.readFileSync(stored).indexOf(Buffer.from([0x1c, 0x53, 0xbb, 0x6b])) < 4096, 'index at the front')
  assert.equal(pcm(stored), pcm(src), 'the same samples')
  assert.ok(Math.abs(body.duration - 20) < 0.1)
  assert.deepEqual(fs.readdirSync(uploads).filter(f => f.includes('.seek.part')), [], 'no part file left')
})

test('a broken file is kept as it is (no seek index, no crash)', { skip: !hasFfmpeg }, async () => {
  const { addSeekIndex } = await import('../src/routes/upload.js')
  const bad = path.join(uploads, 'bad.webm')
  fs.writeFileSync(bad, 'not a webm at all')
  assert.equal(await addSeekIndex(bad), false)
  assert.equal(fs.readFileSync(bad, 'utf8'), 'not a webm at all')
  assert.deepEqual(fs.readdirSync(uploads).filter(f => f.includes('.seek.part')), [])
})
