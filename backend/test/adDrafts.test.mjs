import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-drafts-'))
process.env.UPLOAD_DIR = dir
process.env.EDITOR_TOKEN_SECRET = 'test-secret'
const express = (await import('express')).default
const { adDraftsRouter, AD_DRAFTS_DIR } = await import('../src/routes/adDrafts.js')

const mint = u => {
  const mid = Buffer.from(JSON.stringify({ u, exp: Date.now() + 60000 })).toString('base64url')
  return `v1.${mid}.${crypto.createHmac('sha256', 'test-secret').update(mid).digest('hex')}`
}
let server, base
before(async () => {
  const app = express()
  app.use(express.json())
  app.use('/api/ad-drafts', adDraftsRouter)
  server = app.listen(0)
  await new Promise(r => server.once('listening', r))
  base = `http://127.0.0.1:${server.address().port}/api/ad-drafts`
})
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }) })

const call = async (p, { user = 'alice', method = 'GET', body } = {}) => {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${mint(user)}` } : {}) }, body: body && JSON.stringify(body) })
  return [r.status, await r.json().catch(() => null)]
}
const state = n => ({ version: 1, format: 'portrait', scenes: [{ type: 'hook', duration: 2 }], logo: '/api/upload/files/logo-' + n + '.png' })
const id = () => crypto.randomUUID()

test('no sign-in, no drafts', async () => {
  assert.equal((await call('', { user: null }))[0], 401)
})

test('save, list, load: 90 days, files a draft uses, summary fields', async () => {
  const a = id()
  const [s, b] = await call('/' + a, { method: 'PUT', body: { name: 'First', state: state(1) } })
  assert.equal(s, 200)
  assert.equal(b.draft.format, 'portrait'); assert.equal(b.draft.first, 'hook'); assert.equal(b.limits.maxDrafts, 5); assert.equal(b.limits.ttlDays, 90)
  assert.equal(Math.round((b.draft.expiresAt - b.draft.updatedAt) / 86400000), 90)
  const [, one] = await call('/' + a)
  assert.deepEqual(one.files, ['logo-1.png'])
  assert.ok(fs.existsSync(path.join(AD_DRAFTS_DIR, 'alice', `${a}.json`)))
})

test('the 6th draft is refused unless it replaces one; drafts are per user', async () => {
  const ids = [id(), id(), id(), id()]
  for (const x of ids) assert.equal((await call('/' + x, { method: 'PUT', body: { name: x, state: state(2) } }))[0], 200)
  const extra = id()
  const [s6, b6] = await call('/' + extra, { method: 'PUT', body: { name: 'six', state: state(3) } })
  assert.equal(s6, 409); assert.equal(b6.error, 'limit'); assert.equal(b6.drafts.length, 5)
  assert.equal((await call('/' + extra, { method: 'PUT', body: { name: 'six', state: state(3), replace: ids[0] } }))[0], 200)
  const [, list] = await call('')
  assert.equal(list.drafts.length, 5)
  assert.ok(!list.drafts.some(d => d.id === ids[0]))
  assert.equal((await call('', { user: 'bob' }))[1].drafts.length, 0)
  assert.equal((await call('/' + extra, { user: 'bob' }))[0], 404)
})

test('bad ids and bad state are refused; delete works', async () => {
  assert.equal((await call('/../../etc', { method: 'PUT', body: { state: state(1) } }))[0], 404)
  assert.equal((await call('/not-a-uuid'))[0], 400)
  assert.equal((await call('/' + id(), { method: 'PUT', body: { state: { version: 2, scenes: [] } } }))[0], 400)
  assert.equal((await call('/' + id(), { method: 'PUT', body: { state: { version: 1 } } }))[0], 400)
  const [, list] = await call('')
  for (const d of list.drafts) assert.equal((await call('/' + d.id, { method: 'DELETE' }))[0], 200)
  assert.equal((await call(''))[1].drafts.length, 0)
})
