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
