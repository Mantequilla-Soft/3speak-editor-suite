// The one audio template per user: sign-in, validation, replace, forever, and
// that the cleanup keeps the files it uses while it exists.
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'templates-'))
process.env.UPLOAD_DIR = dir
process.env.EDITOR_TOKEN_SECRET = 'test-secret'
const express = (await import('express')).default
const { templatesRouter, TEMPLATES_DIR, cleanTemplate, MAX_TEMPLATE_BYTES } = await import('../src/routes/templates.js')
const { pinnedUploads, uploadBase } = await import('../src/utils/pinnedUploads.js')

const mint = (u, { exp = Date.now() + 60000, secret = 'test-secret' } = {}) => {
  const mid = Buffer.from(JSON.stringify({ u, exp })).toString('base64url')
  return `v1.${mid}.${crypto.createHmac('sha256', secret).update(mid).digest('hex')}`
}
let server, base
before(async () => {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/api/templates', templatesRouter)
  server = app.listen(0)
  await new Promise(r => server.once('listening', r))
  base = `http://127.0.0.1:${server.address().port}/api/templates`
})
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }) })

const call = async (p, { user = 'alice', token, method = 'GET', body } = {}) => {
  const auth = token || (user ? `Bearer ${mint(user)}` : null)
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) }, body: body && JSON.stringify(body) })
  return [r.status, await r.json().catch(() => null)]
}
const slot = (name, extra = {}) => ({ url: `https://editor.example/api/upload/files/${name}.mp3`, name, duration: 12, startTime: 0, endTime: 8, ...extra })
const template = (extra = {}) => ({
  slots: { intro: slot('intro-1'), outro: slot('outro-1', { fadeOut: 2 }), bed: slot('bed-1', { volume: 15 }) },
  master: { loudness: true },
  silence: { enabled: true, thresholdDb: -42, minSilence: 0.7, keepStartMs: 180, keepEndMs: 220 },
  autoApply: true,
  ...extra
})

describe('sign-in', () => {
  test('no token, a forged token or an expired token: 401', async () => {
    assert.equal((await call('/audio', { user: null }))[0], 401)
    assert.equal((await call('/audio', { token: `Bearer ${mint('alice', { secret: 'nope' })}` }))[0], 401)
    assert.equal((await call('/audio', { token: `Bearer ${mint('alice', { exp: Date.now() - 1 })}` }))[0], 401)
  })

  test('only known kinds', async () => {
    assert.equal((await call('/video'))[0], 404)
    assert.equal((await call('/..%2F..%2Fetc', { method: 'PUT', body: { template: template() } }))[0], 404)
  })
})

describe('one template per user, kept for good', () => {
  test('none yet: null', async () => {
    assert.deepEqual(await call('/audio', { user: 'bob' }), [200, { template: null }])
  })

  test('save, read back, no expiry, the files it uses listed', async () => {
    const [s, b] = await call('/audio', { method: 'PUT', body: { template: template() } })
    assert.equal(s, 200)
    assert.equal(b.template.user, 'alice')
    assert.equal(b.template.kind, 'audio')
    assert.equal(b.template.expiresAt, undefined)
    assert.deepEqual(b.template.files.sort(), ['bed-1.mp3', 'intro-1.mp3', 'outro-1.mp3'])
    assert.equal(b.template.slots.bed.volume, 15)
    assert.equal(b.template.slots.bed.loop, true)
    assert.equal(b.template.slots.outro.fadeOut, 2)
    assert.deepEqual(b.template.silence, { enabled: true, thresholdDb: -42, minSilence: 0.7, keepStartMs: 180, keepEndMs: 220 })
    const [, again] = await call('/audio')
    assert.deepEqual(again.template.slots, b.template.slots)
    assert.ok(fs.existsSync(path.join(TEMPLATES_DIR, 'alice', 'audio.json')))
  })

  test('saving again replaces it: still one file, the old files are no longer listed', async () => {
    await call('/audio', { method: 'PUT', body: { template: template({ slots: { intro: slot('intro-2') } }) } })
    const [, b] = await call('/audio')
    assert.deepEqual(Object.keys(b.template.slots), ['intro'])
    assert.deepEqual(b.template.files, ['intro-2.mp3'])
    assert.deepEqual(fs.readdirSync(path.join(TEMPLATES_DIR, 'alice')), ['audio.json'])
  })

  test('users never see each other\'s template', async () => {
    await call('/audio', { user: 'carol', method: 'PUT', body: { template: template({ slots: { outro: slot('carol-out') } }) } })
    const [, a] = await call('/audio')
    const [, c] = await call('/audio', { user: 'carol' })
    assert.deepEqual(a.template.files, ['intro-2.mp3'])
    assert.deepEqual(c.template.files, ['carol-out.mp3'])
  })

  test('delete', async () => {
    assert.deepEqual(await call('/audio', { user: 'carol', method: 'DELETE' }), [200, { ok: true }])
    assert.deepEqual(await call('/audio', { user: 'carol' }), [200, { template: null }])
  })
})

describe('validation', () => {
  test('a slot must be one of our uploads, never a local or outside file', async () => {
    for (const url of ['blob:https://x/1', 'data:audio/mp3;base64,AA', 'https://evil.example/song.mp3', 'file:///etc/passwd', '/api/upload/files/../../x']) {
      const [s] = await call('/audio', { method: 'PUT', body: { template: template({ slots: { intro: slot('x', { url }) } }) } })
      assert.equal(s, 400, url)
    }
  })

  test('nonsense numbers are clamped, an empty slot range is refused', () => {
    const t = cleanTemplate({ slots: { bed: slot('b', { volume: 900, fadeIn: -3, fadeOut: 99, loop: false }) } })
    assert.deepEqual([t.slots.bed.volume, t.slots.bed.fadeIn, t.slots.bed.fadeOut, t.slots.bed.loop], [200, 0, 30, false])
    assert.equal(cleanTemplate({ slots: { intro: slot('i', { startTime: 5, endTime: 5 }) } }), null)
    assert.equal(cleanTemplate(null), null)
    assert.equal(cleanTemplate('x'), null)
  })

  test('defaults: loudness on, duck off, auto apply on, no silence settings', () => {
    assert.deepEqual(cleanTemplate({}), { version: 1, slots: {}, master: { loudness: true, duck: false, duckDb: -12 }, silence: null, autoApply: true })
    assert.deepEqual(cleanTemplate({ master: { duck: true, duckDb: -18 } }).master, { loudness: true, duck: true, duckDb: -18 })
    assert.equal(cleanTemplate({ master: { duck: 'yes', duckDb: -40 } }).master.duck, false)
    assert.equal(cleanTemplate({ master: { duck: true, duckDb: -40 } }).master.duckDb, -12)
    assert.equal(cleanTemplate({ master: { loudness: false }, autoApply: false }).autoApply, false)
  })

  test('unknown slots are ignored', () => {
    assert.deepEqual(Object.keys(cleanTemplate({ slots: { ad: slot('a'), intro: slot('i') } }).slots), ['intro'])
  })

  test('too large: 413', async () => {
    const [s] = await call('/audio', { method: 'PUT', body: { template: { ...template(), junk: 'x'.repeat(MAX_TEMPLATE_BYTES) } } })
    assert.equal(s, 413)
  })
})

describe('cleanup keeps template files for good', () => {
  test('a template\'s files are pinned with their derived copies; expired drafts are not', async () => {
    const roots = { projects: path.join(dir, '.projects'), templates: TEMPLATES_DIR }
    fs.mkdirSync(path.join(roots.projects, 'alice'), { recursive: true })
    fs.writeFileSync(path.join(roots.projects, 'alice', 'old.json'), JSON.stringify({ id: 'old', expiresAt: Date.now() - 1, files: ['draft-only.mp3'] }))
    const pinned = await pinnedUploads(Date.now(), [roots.projects, roots.templates])
    assert.ok(pinned.has('intro-2'))
    assert.ok(!pinned.has('draft-only'))
    assert.ok(!fs.existsSync(path.join(roots.projects, 'alice', 'old.json')), 'the expired draft is gone')
    // a template file far in the future is still pinned (it has no expiry at all)
    assert.ok((await pinnedUploads(Date.now() + 10 * 365 * 86400000, [roots.templates])).has('intro-2'))
  })

  test('uploadBase ties derived files to their upload', () => {
    for (const f of ['intro-2.mp3', 'intro-2_dn-medium.m4a', 'intro-2.audio.json', 'intro-2.scenes.json', 'intro-2_480p.mp4']) {
      assert.equal(uploadBase(f), 'intro-2', f)
    }
  })
})

describe('the audiogram template (the look of the last audiogram)', () => {
  test('saved checked, read back, its picture kept by the cleanup', async () => {
    const [status, { template }] = await call('/audiogram', {
      user: 'carol',
      method: 'PUT',
      body: { template: { format: 'square', wave: { type: 'line', color: '#FFFFFF' }, background: { image: '/api/upload/files/my-cover.png', imageLayout: 'fill' }, line: 'Listen on *3speak.tv*', layouts: { square: { title: { x: 10, y: 20, w: 300, h: 100, z: 7 } } }, junk: 'dropped' } }
    })
    assert.equal(status, 200)
    assert.equal(template.kind, 'audiogram')
    assert.equal(template.format, 'square')
    assert.deepEqual(template.wave, { type: 'line', color: '#ffffff' })
    assert.deepEqual(template.layouts.square.title, { x: 10, y: 20, w: 300, h: 100, z: 7, on: true })
    assert.equal(template.junk, undefined)
    assert.deepEqual(template.files, ['my-cover.png'])
    assert.deepEqual((await call('/audiogram', { user: 'carol' }))[1].template.line, 'Listen on *3speak.tv*')
    assert.ok((await pinnedUploads(Date.now(), [TEMPLATES_DIR])).has('my-cover'))
    // the audio template of the same person is a different one
    assert.deepEqual(await call('/audio', { user: 'carol' }), [200, { template: null }])
  })
})
