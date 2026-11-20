// The landscape video editor is 3Speak Pro (src/proGate.js): POST /api/render refuses a 16:9, 4:3
// or 1:1 render of a free user with 403 pro_required; Shorts (9:16), audio and Ad Wizard mixes stay
// free; LANDSCAPE_EDITOR_PRO_ONLY=false switches it off; a failed Pro lookup lets the render through.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'landscape-pro-'))
process.env.UPLOAD_DIR = dir
process.env.UPLOADS_DIR = dir
process.env.WORK_DIR = dir
process.env.RENDERED_DIR = dir
process.env.RENDER_JOBS_DIR = path.join(dir, '.render-jobs')
process.env.EDITOR_TOKEN_SECRET = 'test-secret'
process.env.MAX_CONCURRENT_JOBS = '0' // jobs only queue: nothing runs ffmpeg here
process.env.MAX_QUEUED_JOBS = '1000'
process.env.CHECKER_URL = 'https://checker.test'
delete process.env.LANDSCAPE_EDITOR_PRO_ONLY
delete process.env.EDITOR_UPGRADE_URL

const express = (await import('express')).default
const { renderRouter } = await import('../src/routes/render.js')
const { proRouter } = await import('../src/routes/pro.js')
const gate = await import('../src/proGate.js')

const token = (u, pro = false) => {
  const mid = Buffer.from(JSON.stringify({ u, pro, exp: Date.now() + 60000 })).toString('base64url')
  return `v1.${mid}.${crypto.createHmac('sha256', 'test-secret').update(mid).digest('hex')}`
}

// The checker: premium per user; 'down' makes every lookup fail
const checker = { premium: { paula: true, lapsed: false }, expires: {}, down: false, calls: [] }
gate._test.setFetch(async (url) => {
  checker.calls.push(url)
  if (checker.down) throw new Error('connect ECONNREFUSED')
  const user = decodeURIComponent(url.split('/premium/')[1])
  return new Response(JSON.stringify({ username: user, premium: !!checker.premium[user], premium_expires_at: checker.expires[user] ?? null }), { status: 200 })
})

let server, base
before(async () => {
  const app = express()
  app.use(express.json())
  app.use('/api/render', renderRouter)
  app.use('/api/pro-status', proRouter)
  server = app.listen(0)
  await new Promise(r => server.once('listening', r))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => { server.close(); gate._test.resetFetch(); fs.rmSync(dir, { recursive: true, force: true }) })
beforeEach(() => {
  gate._test.clearCache()
  checker.down = false
  checker.calls = []
  delete process.env.LANDSCAPE_EDITOR_PRO_ONLY
})

const clip = { id: 'c1', type: 'video', url: '/api/upload/files/none.mp4', duration: 5, startTime: 0, endTime: 5, timelinePosition: 0 }
const video = (w, h, extra = {}) => ({ timeline: { tracks: [{ id: 'v', type: 'video', clips: [clip] }], outputWidth: w, outputHeight: h, fps: 30, ...extra } })
const audio = () => ({ timeline: { output: 'audio', tracks: [{ id: 'a', type: 'audio', clips: [{ id: 'a1', type: 'audio', url: '/api/upload/files/none.mp3', duration: 5, startTime: 0, endTime: 5, timelinePosition: 0, audioEnabled: true, volume: 100 }] }] } })
const render = async (user, body, pro = false) => {
  const r = await fetch(`${base}/api/render`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token(user, pro)}` }, body: JSON.stringify(body) })
  return { status: r.status, body: await r.json() }
}

test('a free user\'s 16:9 render is refused with 403 pro_required and the Pro page of that account', async () => {
  const r = await render('freddy', video(1920, 1080))
  assert.equal(r.status, 403)
  assert.deepEqual(r.body, {
    error: 'Pro required',
    code: 'pro_required',
    feature: 'landscape_editor',
    message: 'The landscape video editor is part of 3Speak Pro. Shorts and the audio editor stay free.',
    upgrade_url: 'https://3speak.tv/wallet/freddy#pro',
  })
})

test('4:3, 1:1 and a render without sizes (854x480 default) are landscape too', async () => {
  for (const body of [video(1440, 1080), video(1080, 1080), video(undefined, undefined), video(720, 1080)]) {
    assert.equal((await render('freddy', body)).status, 403, JSON.stringify(body.timeline.outputWidth))
  }
})

test('Shorts (9:16) and the audio editor stay free', async () => {
  for (const body of [video(1080, 1920), video(720, 1280), audio()]) {
    const r = await render('freddy', body)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.ok(r.body.jobId)
  }
  assert.equal(checker.calls.length, 0, 'no Pro lookup for free shapes')
})

test('Pro: from the token without a lookup, or from the checker when the token predates the upgrade', async () => {
  assert.equal((await render('tina', video(1920, 1080), true)).status, 200)
  assert.equal(checker.calls.length, 0)
  assert.equal((await render('paula', video(1920, 1080), false)).status, 200)
  assert.deepEqual(checker.calls, ['https://checker.test/premium/paula'])
  // cached: the second render does not ask again
  assert.equal((await render('paula', video(1440, 1080))).status, 200)
  assert.equal(checker.calls.length, 1)
})

test('an expired Pro row counts as free', async () => {
  checker.premium.expo = true
  checker.expires.expo = new Date(Date.now() - 60000).toISOString()
  assert.equal((await render('expo', video(1920, 1080))).status, 403)
})

test('a failed Pro lookup lets the render through (fail open) and is retried after a short pause', async () => {
  checker.down = true
  assert.equal((await render('freddy', video(1920, 1080))).status, 200)
  assert.equal((await render('freddy', video(1920, 1080))).status, 200)
  assert.equal(checker.calls.length, 1, 'the failure is cached, not asked per render')
})

test('a checker 500 is a failed lookup, not "free"', async () => {
  gate._test.setFetch(async () => new Response('{"premium":false,"error":"internal"}', { status: 500 }))
  try {
    assert.equal((await render('freddy', video(1920, 1080))).status, 200)
  } finally {
    gate._test.setFetch(async (url) => {
      checker.calls.push(url)
      if (checker.down) throw new Error('connect ECONNREFUSED')
      const user = decodeURIComponent(url.split('/premium/')[1])
      return new Response(JSON.stringify({ username: user, premium: !!checker.premium[user], premium_expires_at: checker.expires[user] ?? null }), { status: 200 })
    })
  }
})

test('LANDSCAPE_EDITOR_PRO_ONLY=false switches the rule off', async () => {
  process.env.LANDSCAPE_EDITOR_PRO_ONLY = 'false'
  assert.equal((await render('freddy', video(1920, 1080))).status, 200)
  assert.equal(checker.calls.length, 0)
})

test('EDITOR_UPGRADE_URL overrides the Pro page', async () => {
  process.env.EDITOR_UPGRADE_URL = 'https://preview.3speak.tv/wallet/{user}#pro'
  try {
    assert.equal((await render('freddy', video(1920, 1080))).body.upgrade_url, 'https://preview.3speak.tv/wallet/freddy#pro')
  } finally {
    delete process.env.EDITOR_UPGRADE_URL
  }
})

test('the Ad Wizard\'s 16:9 mix stays free, only with a scene render on this backend\'s disk', async () => {
  const id = crypto.randomUUID()
  fs.writeFileSync(path.join(dir, `scene-${id}.mp4`), 'x')
  const ad = (url, more = []) => ({ timeline: {
    tracks: [
      { id: 'v', type: 'video', clips: [{ id: 'scenes', type: 'video', url, duration: 5, startTime: 0, endTime: 5, timelinePosition: 0 }] },
      { id: 'm', type: 'audio', clips: [{ id: 'music', type: 'audio', url: 'https://cdn.example/song.mp3', duration: 5, startTime: 0, endTime: 5, timelinePosition: 0 }] },
      ...more,
    ],
    outputWidth: 1920, outputHeight: 1080, fps: 30,
  } })
  assert.equal((await render('freddy', ad(`https://editor.example/rendered/scene-${id}.mp4`))).status, 200)
  assert.equal((await render('freddy', ad(`/rendered/scene-${id}.mp4`))).status, 200)
  // a scene name that is not on disk, other footage, or a picture smuggled onto a sound track: Pro
  assert.equal((await render('freddy', ad(`/rendered/scene-${crypto.randomUUID()}.mp4`))).status, 403)
  assert.equal((await render('freddy', ad('/api/upload/files/movie.mp4'))).status, 403)
  assert.equal((await render('freddy', ad(`/rendered/scene-${id}.mp4`, [{ id: 'x', type: 'audio', clips: [{ id: 'x1', type: 'video', url: '/api/upload/files/movie.mp4' }] }]))).status, 403)
})

test('claimAdSceneRender points scene clips at the local file', () => {
  const id = crypto.randomUUID()
  fs.writeFileSync(path.join(dir, `scene-${id}.mp4`), 'x')
  const tl = { tracks: [{ type: 'video', clips: [{ type: 'video', url: `https://elsewhere.example/rendered/scene-${id}.mp4` }] }] }
  assert.equal(gate.claimAdSceneRender(tl, gate.proGateConfig()), true)
  assert.equal(tl.tracks[0].clips[0].url, `/rendered/scene-${id}.mp4`)
})

test('renderShape', () => {
  assert.equal(gate.renderShape({ output: 'audio' }), 'audio')
  assert.equal(gate.renderShape({ outputWidth: 1080, outputHeight: 1920 }), 'short')
  assert.equal(gate.renderShape({ outputWidth: 1920, outputHeight: 1080 }), 'landscape')
  assert.equal(gate.renderShape({ outputWidth: 1080, outputHeight: 1080 }), 'landscape')
  assert.equal(gate.renderShape({}), 'landscape')
})

const status = async (auth) => (await fetch(`${base}/api/pro-status`, { headers: auth ? { Authorization: `Bearer ${auth}` } : {} })).json()

test('GET /api/pro-status tells the editor what the render route will do', async () => {
  assert.deepEqual(await status(token('freddy')), { landscapeProOnly: true, landscapeAllowed: false, pro: false, reason: 'free', user: 'freddy', upgradeUrl: 'https://3speak.tv/wallet/freddy#pro' })
  assert.equal((await status(token('tina', true))).landscapeAllowed, true)
  assert.equal((await status(token('paula'))).pro, true)
  // no sign-in (the editor outside 3Speak): not allowed while the rule is on
  assert.deepEqual(await status(null), { landscapeProOnly: true, landscapeAllowed: false, pro: null, reason: 'sign-in', user: null, upgradeUrl: null })
  checker.down = true
  gate._test.clearCache()
  assert.deepEqual(await status(token('freddy')), { landscapeProOnly: true, landscapeAllowed: true, pro: null, reason: 'lookup_failed', user: 'freddy', upgradeUrl: 'https://3speak.tv/wallet/freddy#pro' })
  process.env.LANDSCAPE_EDITOR_PRO_ONLY = 'false'
  assert.equal((await status(null)).landscapeAllowed, true)
  assert.equal((await status(token('freddy'))).reason, 'disabled')
})
