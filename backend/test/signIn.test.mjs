import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signin-'))
process.env.UPLOAD_DIR = dir
process.env.WORK_DIR = dir
process.env.RENDERED_DIR = dir
process.env.EDITOR_TOKEN_SECRET = 'test-secret'
const express = (await import('express')).default
const { uploadRouter } = await import('../src/routes/upload.js')
const { renderRouter } = await import('../src/routes/render.js')
const { clipRouter } = await import('../src/routes/clip.js')

const token = (u = 'alice', exp = Date.now() + 60000, secret = 'test-secret') => {
  const mid = Buffer.from(JSON.stringify({ u, exp })).toString('base64url')
  return `v1.${mid}.${crypto.createHmac('sha256', secret).update(mid).digest('hex')}`
}
let server, base
before(async () => {
  const app = express()
  app.use(express.json())
  app.use('/api/upload', uploadRouter)
  app.use('/api/render', renderRouter)
  app.use('/api/clip', clipRouter)
  server = app.listen(0)
  await new Promise(r => server.once('listening', r))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }) })

const call = (method, p, { auth, json } = {}) => fetch(base + p, {
  method,
  headers: { ...(json ? { 'Content-Type': 'application/json' } : {}), ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
  body: json ? JSON.stringify(json) : undefined,
})

const STARTERS = [
  ['POST', '/api/upload'], ['POST', '/api/upload/chunked/init', { name: 'a.mp4', size: 10 }], ['PUT', '/api/upload/chunked/x/0'],
  ['POST', '/api/upload/chunked/x/complete', {}], ['POST', '/api/render', { timeline: { tracks: [] } }], ['POST', '/api/render/x/abort', {}],
  ['POST', '/api/clip/prepare', {}], ['POST', '/api/clip/reverse'], ['POST', '/api/clip/denoise', {}], ['POST', '/api/clip/scenes', {}],
]

test('nothing starts without a 3Speak sign-in', async () => {
  for (const [m, p, json] of STARTERS) {
    const r = await call(m, p, { json })
    assert.equal(r.status, 401, `${m} ${p}`)
    assert.equal((await r.json()).code, 'sign-in')
  }
})

test('forged, expired and other-secret tokens are refused', async () => {
  for (const bad of [token('alice', Date.now() - 1), token('alice', Date.now() + 60000, 'nope'), 'v1.e30.00', 'garbage']) {
    assert.equal((await call('POST', '/api/render', { auth: bad, json: { timeline: { tracks: [] } } })).status, 401)
  }
})

test('with a valid sign-in the request gets past the gate (and meets the route\'s own checks)', async () => {
  const t = token()
  for (const [m, p, json] of STARTERS) {
    const r = await call(m, p, { auth: t, json })
    assert.notEqual(r.status, 401, `${m} ${p} was refused with a valid token`)
  }
})

test('reading results stays open: files and job status', async () => {
  assert.equal((await call('GET', '/api/upload/files/none.mp4')).status, 404)
  assert.equal((await call('GET', '/api/render/none')).status, 404)
  assert.equal((await call('GET', '/api/clip/prepare/none')).status, 404)
})
