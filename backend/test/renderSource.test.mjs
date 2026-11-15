// Renders read the uploaded original (or its master), never the 480p copy the
// preview plays: a 1080x1920 phone clip must not reach a Shorts render as 270x480.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let hasFfmpeg = true
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }) } catch { hasFfmpeg = false }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-source-'))
const uploads = path.join(dir, 'uploads')
fs.mkdirSync(uploads, { recursive: true })
process.env.UPLOAD_DIR = uploads
process.env.UPLOADS_DIR = uploads
process.env.WORK_DIR = path.join(dir, 'work')
process.env.RENDERED_DIR = path.join(dir, 'rendered')
process.env.EDITOR_TOKEN_SECRET = 'test-secret'
const express = (await import('express')).default
const { uploadRouter } = await import('../src/routes/upload.js')
const { downloadMedia } = await import('../src/utils/download.js')
const { cachedDownload } = await import('../src/routes/render.js')
const { masterReason, renderSource, renderUrlOf, uploadNameOf, pendingMasters, masterName, proxyName } = await import('../src/utils/uploadFiles.js')
const { uploadBase } = await import('../src/utils/pinnedUploads.js')

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

const size = (file) => execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]).toString().trim()

async function upload(file, name, hash = null) {
  const form = new FormData()
  form.append('file', new Blob([fs.readFileSync(file)], { type: 'video/mp4' }), name)
  const r = await fetch(`${base}/api/upload${hash ? `?hash=${hash}` : ''}`, { method: 'POST', headers: { Authorization: `Bearer ${mint('badadib')}` }, body: form })
  return r.json()
}
async function encoded(filename) {
  for (let i = 0; i < 150; i++) {
    const { state } = await (await fetch(`${base}/api/upload/status/${filename}`)).json()
    if (state === 'done' || state === 'failed') return state
    await new Promise(r => setTimeout(r, 200))
  }
  return 'timeout'
}

test('masterReason: only HDR, oversized or unusual footage gets a render copy', () => {
  assert.equal(masterReason({ videoCodec: 'h264', width: 1080, height: 1920 }), null)
  assert.equal(masterReason({ videoCodec: 'hevc', width: 1920, height: 1080 }), null)
  assert.equal(masterReason({ videoCodec: 'h264', width: 2160, height: 3840 }), 'large')
  assert.equal(masterReason({ videoCodec: 'hevc', width: 1080, height: 1920, transfer: 'arib-std-b67' }), 'hdr')
  assert.equal(masterReason({ videoCodec: 'msmpeg4v3', width: 640, height: 480 }), 'codec')
  assert.equal(masterReason({}), null, 'unreadable: no master')
  assert.equal(masterReason({ videoCodec: null }), null, 'audio only')
})

test('renderUrlOf: upload URLs ask for the render source, anything else is unchanged', () => {
  assert.equal(renderUrlOf('/api/upload/files/a.mp4'), '/api/upload/files/a.mp4?for=render')
  assert.equal(renderUrlOf('https://editor-a.example/api/upload/files/a.mov?v=480p'), 'https://editor-a.example/api/upload/files/a.mov?for=render')
  assert.equal(renderUrlOf('/rendered/clip-1.mp4'), '/rendered/clip-1.mp4')
  assert.equal(renderUrlOf('https://cdn.example/x.m3u8'), 'https://cdn.example/x.m3u8')
  assert.equal(uploadNameOf('https://b.example/api/upload/files/x_dn-light.m4a'), 'x_dn-light.m4a')
  assert.equal(uploadNameOf('/elsewhere/x.mp4'), null)
})

test('renderSource: master, then original, then the 480p file of an old upload', async () => {
  const d = fs.mkdtempSync(path.join(dir, 'rs-'))
  const put = (n) => fs.writeFileSync(path.join(d, n), n)
  assert.equal(await renderSource(d, 'none.mp4'), null)
  put(proxyName('old.mov'))
  assert.deepEqual(await renderSource(d, 'old.mov'), { path: path.join(d, 'old_480p.mp4'), kind: 'proxy', final: true })
  put('new.mov'); put(proxyName('new.mov'))
  assert.equal((await renderSource(d, 'new.mov')).kind, 'original')
  // a master on its way: the original serves, but is not final
  assert.deepEqual(await renderSource(d, 'new.mov', { pendingMaster: true }), { path: path.join(d, 'new.mov'), kind: 'original', final: false })
  // HDR while its master is made: the tone-mapped 480p file stands in
  assert.deepEqual(await renderSource(d, 'new.mov', { pendingMaster: true, hdr: true }), { path: path.join(d, 'new_480p.mp4'), kind: 'proxy', final: false })
  put(masterName('new.mov'))
  assert.deepEqual(await renderSource(d, 'new.mov'), { path: path.join(d, 'new_master.mp4'), kind: 'master', final: true })
  // a derived file asked for by name is just that file
  assert.equal((await renderSource(d, 'new_480p.mp4')).path, path.join(d, 'new_480p.mp4'))
})

test('the cleanup keeps a pinned upload\'s master with it', () => {
  assert.equal(uploadBase('abc_master.mp4'), 'abc')
  assert.equal(uploadBase('abc_master.part.mp4'), 'abc')
  assert.equal(uploadBase('abc_480p.mp4'), 'abc')
})

test('a 1080x1920 phone clip keeps its original: the preview gets 480p, renders the full size', { skip: !hasFfmpeg }, async () => {
  const src = path.join(dir, 'phone.mp4')
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=d=1:s=1080x1920:r=30', '-f', 'lavfi', '-i', 'sine=d=1', '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', src])
  const body = await upload(src, 'phone.mp4')
  assert.equal(body.encodes, true)
  assert.equal(await encoded(body.filename), 'done')
  const original = path.join(uploads, body.filename)
  assert.ok(fs.existsSync(original), 'original kept')
  assert.ok(!fs.existsSync(path.join(uploads, masterName(body.filename))), 'no master needed')
  assert.equal(size(path.join(uploads, proxyName(body.filename))), '270,480')

  // the preview URL serves the proxy, ?for=render the original
  const preview = await fetch(`${base}/api/upload/files/${body.filename}`)
  assert.equal(preview.headers.get('x-render-source'), null)
  const previewFile = path.join(dir, 'preview.mp4')
  fs.writeFileSync(previewFile, Buffer.from(await preview.arrayBuffer()))
  assert.equal(size(previewFile), '270,480')
  const render = await fetch(`${base}/api/upload/files/${body.filename}?for=render`)
  assert.equal(render.headers.get('x-render-source'), 'original')
  assert.equal(render.headers.get('x-render-final'), '1')

  // a render on this backend copies the original
  const work = fs.mkdtempSync(path.join(dir, 'w-'))
  const local = await downloadMedia(`/api/upload/files/${body.filename}?for=render`, 'c1', work)
  assert.equal(size(local), '1080,1920')
  // ... and on another backend it fetches it by URL (B renders A's upload)
  const remote = await cachedDownload(`${base}/api/upload/files/${body.filename}`, work)
  assert.equal(size(remote), '1080,1920')
  assert.match(path.dirname(remote), /cache[/\\]downloads$/, 'kept in the download cache')
})

test('a 4K portrait clip gets a 1080x1920 master that replaces the original', { skip: !hasFfmpeg }, async () => {
  const src = path.join(dir, 'big.mp4')
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=d=1:s=2160x3840:r=30', '-c:v', 'libx264', '-preset', 'ultrafast', src])
  const hash = crypto.createHash('sha256').update(fs.readFileSync(src)).digest('hex')
  const body = await upload(src, 'big.mp4', hash)
  assert.equal(await encoded(body.filename), 'done')
  const master = path.join(uploads, masterName(body.filename))
  assert.equal(size(master), '1080,1920')
  assert.ok(!fs.existsSync(path.join(uploads, body.filename)), 'the master took the original\'s place')
  const r = await fetch(`${base}/api/upload/files/${body.filename}?for=render`)
  assert.equal(r.headers.get('x-render-source'), 'master')
  // the same file again: reused by hash, although only the master and the 480p file are left
  const again = await fetch(`${base}/api/upload/by-hash/${hash}`)
  assert.equal(again.status, 200)
  const info = await again.json()
  assert.equal(info.reused, true)
  assert.equal(info.encodeState, 'done')
})

test('a stand-in (master still being made) is used once, not cached', async () => {
  const name = 'pending-1.mp4'
  fs.writeFileSync(path.join(uploads, name), 'original bytes')
  pendingMasters.set(name, { hdr: false })
  try {
    const work = fs.mkdtempSync(path.join(dir, 'w-'))
    const state = { final: true }
    const file = await cachedDownload(`${base}/api/upload/files/${name}`, work, state)
    assert.equal(state.final, false)
    assert.equal(fs.readFileSync(file, 'utf8'), 'original bytes')
    assert.match(path.basename(file), /-standin-/, 'its own name, so no processed-clip cache picks it up')
    assert.ok(file.startsWith(work), 'stays in the job folder')
    // the local copy says the same
    const info = {}
    await downloadMedia(`/api/upload/files/${name}`, 'c9', work, info)
    assert.equal(info.final, false)
  } finally {
    pendingMasters.delete(name)
  }
})
