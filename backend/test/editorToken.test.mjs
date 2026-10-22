import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

process.env.EDITOR_TOKEN_SECRET = 'test-secret'
const { verifyEditorToken, referencedFiles } = await import('../src/routes/projects.js')

const mint = (claims, secret = 'test-secret') => {
  const mid = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `v1.${mid}.${crypto.createHmac('sha256', secret).update(mid).digest('hex')}`
}
const soon = () => Date.now() + 60000

test('a valid token names its user (with or without "Bearer ")', () => {
  assert.deepEqual(verifyEditorToken(mint({ u: 'alice', pro: true, exp: soon() })), { user: 'alice', pro: true })
  assert.deepEqual(verifyEditorToken('Bearer ' + mint({ u: 'bob', exp: soon() })), { user: 'bob', pro: false })
})

test('wrong secret, tampering, expiry, bad user and bad format are all refused', () => {
  assert.equal(verifyEditorToken(mint({ u: 'alice', exp: soon() }, 'other')), null)
  const t = mint({ u: 'alice', exp: soon() }).split('.')
  t[1] = Buffer.from(JSON.stringify({ u: 'mallory', exp: soon() })).toString('base64url')
  assert.equal(verifyEditorToken(t.join('.')), null)
  assert.equal(verifyEditorToken(mint({ u: 'alice', exp: Date.now() - 1 })), null)
  assert.equal(verifyEditorToken(mint({ u: '../etc', exp: soon() })), null)
  assert.equal(verifyEditorToken(mint({ u: 'Alice', exp: soon() })), null)
  for (const bad of ['', 'v1.x', 'v2.a.b', null, undefined]) assert.equal(verifyEditorToken(bad), null)
})

test('referencedFiles lists every upload a draft points at, once', () => {
  const json = JSON.stringify({ a: '/api/upload/files/a.png', b: ['https://x/api/upload/files/b.mp3', '/api/upload/files/a.png'], c: '/music/x.mp3' })
  assert.deepEqual(referencedFiles(json).sort(), ['a.png', 'b.mp3'])
})
