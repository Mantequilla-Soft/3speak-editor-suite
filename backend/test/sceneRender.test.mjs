import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

process.env.EDITOR_TOKEN_SECRET = 'test-secret'
const mid = Buffer.from(JSON.stringify({ u: 'alice', exp: Date.now() + 600000 })).toString('base64url')
const TOKEN = `v1.${mid}.${crypto.createHmac('sha256', 'test-secret').update(mid).digest('hex')}`

const express = (await import('express')).default
const { sceneRenderRouter, privateAddress } = await import('../src/routes/sceneRender.js')

test('remote pictures: private, loopback, link-local and mapped addresses are refused', () => {
  for (const ip of ['10.0.0.1', '127.0.0.1', '172.16.5.4', '172.31.255.1', '192.168.1.10', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
    assert.equal(privateAddress(ip), true, ip)
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700::1111']) assert.equal(privateAddress(ip), false, ip)
})

let server, base
before(async () => {
  const app = express()
  app.use(express.json())
  app.use('/api/scene-render', sceneRenderRouter)
  server = app.listen(0)
  await new Promise(r => server.once('listening', r))
  base = `http://127.0.0.1:${server.address().port}/api/scene-render`
})
after(() => server.close())

const post = async (body, auth = TOKEN) => { const r = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(body) }); return [r.status, await r.json()] }

test('a scene render needs a 3Speak sign-in', async () => {
  assert.equal((await post({ doc: { scenes: [{ type: 'hook', lines: ['x'] }] } }, null))[0], 401)
})

test('a render needs a doc with at least one known, complete scene (checked before any browser starts)', async () => {
  assert.equal((await post({}))[0], 400)
  assert.equal((await post({ doc: { scenes: [{ type: 'nope' }] } }))[0], 400)
  const [s, b] = await post({ doc: { scenes: [{ type: 'steps', duration: 3, lines: ['x'], steps: [{ title: 'only one' }] }] } })
  assert.equal(s, 400)
  assert.match(b.error, /steps/)
})

test('an unknown job is a 404', async () => {
  assert.equal((await fetch(base + '/nope')).status, 404)
})
