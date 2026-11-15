// A render queue instead of "Server busy": jobs wait in line with their
// position, survive a restart (JSON file per job), and /api/health says what
// runs and what waits (the deploy waits for both to be 0).
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let hasFfmpeg = true
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }) } catch { hasFfmpeg = false }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-queue-'))
const uploads = path.join(dir, 'uploads')
fs.mkdirSync(uploads, { recursive: true })
process.env.UPLOAD_DIR = uploads
process.env.UPLOADS_DIR = uploads
process.env.RENDERED_DIR = path.join(dir, 'rendered')
process.env.WORK_DIR = path.join(dir, 'work')
process.env.EDITOR_TOKEN_SECRET = 'test-secret'
process.env.MAX_CONCURRENT_JOBS = '1'
process.env.MAX_QUEUED_JOBS = '1'
const express = (await import('express')).default
const { createRenderQueue, createJobStore, positionText, QueueFullError, INTERRUPTED_ERROR } = await import('../src/utils/renderQueue.js')
const { renderRouter, getRenderStats, RENDER_JOBS_DIR } = await import('../src/routes/render.js')

after(() => fs.rmSync(dir, { recursive: true, force: true }))

// A run() the test finishes by hand
function controlled() {
  const pending = new Map()
  const run = (job, { signal }) => new Promise((resolve, reject) => {
    pending.set(job.id, { resolve: () => { job.status = 'completed'; job.outputUrl = `/rendered/${job.id}.mp4`; resolve() }, fail: (m) => reject(new Error(m)) })
    if (signal.aborted) reject(new Error('Job aborted'))
    signal.addEventListener('abort', () => reject(new Error('Job aborted')))
  })
  const done = async (id) => { pending.get(id).resolve(); await new Promise(r => setImmediate(r)) }
  const fail = async (id, m) => { pending.get(id).fail(m); await new Promise(r => setImmediate(r)) }
  return { run, done, fail, pending }
}
const tick = () => new Promise(r => setImmediate(r))

describe('the queue', () => {
  test('jobs past the render places wait in line with their position, first come first served', async () => {
    const c = controlled()
    const q = createRenderQueue({ maxConcurrent: 1, maxQueued: 5, run: c.run })
    for (const id of ['a', 'b', 'c']) q.add({ id, timeline: {} })
    await tick()
    assert.equal(q.get('a').status, 'processing')
    assert.deepEqual(['b', 'c'].map(id => q.view(q.get(id))), [
      { jobId: 'b', status: 'queued', progress: 0, phase: 'You are next', outputUrl: null, error: null, position: 1 },
      { jobId: 'c', status: 'queued', progress: 0, phase: 'You are 2nd in line', outputUrl: null, error: null, position: 2 }
    ])
    assert.deepEqual(q.stats(), { activeJobs: 1, queuedJobs: 2, maxConcurrentJobs: 1, maxQueuedJobs: 5 })
    await c.done('a')
    assert.equal(q.get('a').status, 'completed')
    assert.equal(q.get('b').status, 'processing')
    assert.equal(q.view(q.get('c')).position, 1)
    await c.fail('b', 'ffmpeg exploded')
    assert.equal(q.get('b').status, 'failed')
    assert.equal(q.get('b').error, 'ffmpeg exploded')
    assert.equal(q.get('c').status, 'processing')
    await c.done('c')
    assert.deepEqual(q.stats(), { activeJobs: 0, queuedJobs: 0, maxConcurrentJobs: 1, maxQueuedJobs: 5 })
    q.close()
  })

  test('a full line is refused (the editor retries by itself)', () => {
    const c = controlled()
    const q = createRenderQueue({ maxConcurrent: 1, maxQueued: 1, run: c.run })
    q.add({ id: 'a' }); q.add({ id: 'b' })
    assert.throws(() => q.add({ id: 'c' }), QueueFullError)
    q.close()
  })

  test('an aborted job leaves the line, the ones behind move up; a running one stops', async () => {
    const c = controlled()
    const q = createRenderQueue({ maxConcurrent: 1, maxQueued: 5, run: c.run })
    for (const id of ['a', 'b', 'c']) q.add({ id })
    q.abort('b')
    assert.equal(q.get('b').status, 'aborted')
    assert.equal(q.position('c'), 1)
    q.abort('a')
    await tick(); await tick()
    assert.equal(q.get('a').status, 'aborted')
    assert.equal(q.get('c').status, 'processing')
    q.close()
  })

  test('position words', () => {
    assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 101].map(positionText), ['You are next', 'You are 2nd in line', 'You are 3rd in line', 'You are 4th in line', 'You are 11th in line', 'You are 12th in line', 'You are 13th in line', 'You are 21st in line', 'You are 22nd in line', 'You are 101st in line'])
    assert.equal(positionText(0), null)
  })
})

describe('after a restart', () => {
  test('queued jobs queue again in order, a running one starts over, finished ones still answer', async () => {
    const jobsDir = fs.mkdtempSync(path.join(dir, 'jobs-'))
    const c1 = controlled()
    const s1 = createJobStore(jobsDir)
    const q1 = createRenderQueue({ maxConcurrent: 1, maxQueued: 5, store: s1, run: c1.run })
    q1.add({ id: 'done1', timeline: { n: 0 } })
    await tick()
    await c1.done('done1')
    for (const id of ['run1', 'wait1', 'wait2']) q1.add({ id, timeline: { n: id } })
    await tick()
    assert.equal(q1.get('run1').status, 'processing')
    await s1.flush()
    const store = createJobStore(jobsDir)
    assert.deepEqual(fs.readdirSync(jobsDir).sort(), ['done1.json', 'run1.json', 'wait1.json', 'wait2.json'])
    q1.close()

    // the process is gone (q1 never finishes); a new one reads the folder
    const c2 = controlled()
    const q2 = createRenderQueue({ maxConcurrent: 1, maxQueued: 5, store, run: c2.run })
    assert.deepEqual(q2.restore(), { requeued: 2, restarted: 1, failed: 0, kept: 1 })
    await tick()
    assert.equal(q2.get('done1').status, 'completed')
    assert.equal(q2.get('run1').status, 'processing')
    assert.equal(q2.view(q2.get('run1')).restarted, true)
    assert.deepEqual(q2.get('run1').timeline, { n: 'run1' }) // the whole job came back
    assert.equal(q2.view(q2.get('wait1')).position, 1)
    assert.equal(q2.view(q2.get('wait2')).position, 2)
    await store.flush()

    // interrupted a second time: failed with a reason, the line moves on
    const q3 = createRenderQueue({ maxConcurrent: 1, maxQueued: 5, store: createJobStore(jobsDir), run: controlled().run })
    assert.deepEqual(q3.restore(), { requeued: 2, restarted: 0, failed: 1, kept: 1 })
    assert.equal(q3.get('run1').status, 'failed')
    assert.equal(q3.get('run1').error, INTERRUPTED_ERROR)
    await tick()
    assert.equal(q3.get('wait1').status, 'processing')
    q2.close(); q3.close()
  })

  test('finished jobs older than the keep time are deleted, unreadable files skipped', async () => {
    const jobsDir = fs.mkdtempSync(path.join(dir, 'jobs-'))
    fs.writeFileSync(path.join(jobsDir, 'old.json'), JSON.stringify({ id: 'old', status: 'completed', finishedAt: Date.now() - 2 * 3600e3 }))
    fs.writeFileSync(path.join(jobsDir, 'broken.json'), '{nope')
    fs.writeFileSync(path.join(jobsDir, 'other.json'), JSON.stringify({ id: 'not-the-file-name', status: 'queued' }))
    const store = createJobStore(jobsDir)
    const q = createRenderQueue({ maxConcurrent: 1, store, run: controlled().run })
    assert.deepEqual(q.restore(), { requeued: 0, restarted: 0, failed: 0, kept: 0 })
    await store.flush()
    await tick()
    assert.equal(fs.existsSync(path.join(jobsDir, 'old.json')), false)
    q.close()
  })
})

describe('POST /api/render and /api/health', () => {
  const mint = (u) => {
    const mid = Buffer.from(JSON.stringify({ u, exp: Date.now() + 60000 })).toString('base64url')
    return `v1.${mid}.${crypto.createHmac('sha256', 'test-secret').update(mid).digest('hex')}`
  }
  let server, base
  before(async () => {
    const app = express()
    app.use(express.json({ limit: '5mb' }))
    app.use('/api/render', renderRouter)
    app.get('/api/health', (req, res) => res.json({ status: 'ok', ...getRenderStats() }))
    server = app.listen(0)
    await new Promise(r => server.once('listening', r))
    base = `http://127.0.0.1:${server.address().port}`
  })
  after(() => server.close())
  const post = async (body) => {
    const r = await fetch(`${base}/api/render`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${mint('badadib')}` }, body: JSON.stringify(body) })
    return [r.status, await r.json()]
  }
  const timeline = (n) => ({ outputWidth: 160, outputHeight: 284, previewWidth: 160, fps: 30, tracks: [{ id: 'v', type: 'video', clips: [{ id: `c${n}`, type: 'color', duration: 1, startTime: 0, endTime: 1, timelinePosition: 0, backgroundColor: `#00000${n}` }] }] })
  async function finish(jobId) {
    for (let i = 0; i < 300; i++) {
      const job = await (await fetch(`${base}/api/render/${jobId}`)).json()
      if (['completed', 'failed', 'aborted'].includes(job.status)) return job
      await new Promise(r => setTimeout(r, 100))
    }
    throw new Error('render did not finish')
  }

  test('one renders, the next waits with its position, a third is told to come back; all of it on disk', { skip: !hasFfmpeg }, async () => {
    const [s1, a] = await post({ timeline: timeline(1) })
    const [s2, b] = await post({ timeline: timeline(2) })
    const [s3, c] = await post({ timeline: timeline(3) })
    assert.equal(s1, 200)
    assert.equal(s2, 200)
    assert.equal(b.status, 'queued')
    assert.equal(b.position, 1)
    assert.equal(b.phase, 'You are next')
    assert.equal(s3, 503)
    assert.equal(c.error, 'Server busy')
    assert.equal(c.retryAfter, 30)
    const health = await (await fetch(`${base}/api/health`)).json()
    assert.equal(health.activeJobs + health.queuedJobs, 2)
    assert.ok(fs.existsSync(path.join(RENDER_JOBS_DIR, `${b.jobId}.json`)))
    assert.equal(RENDER_JOBS_DIR, path.join(uploads, '.render-jobs')) // the uploads volume: survives a redeploy
    assert.equal((await finish(a.jobId)).status, 'completed')
    const jb = await finish(b.jobId)
    assert.equal(jb.status, 'completed', jb.error)
    assert.match(jb.outputUrl, /\.mp4$/)
    const after = await (await fetch(`${base}/api/health`)).json()
    assert.equal(after.activeJobs, 0)
    assert.equal(after.queuedJobs, 0)
  })

  test('an unknown job is a 404 (the editor stops asking)', async () => {
    const r = await fetch(`${base}/api/render/nope`)
    assert.equal(r.status, 404)
  })
})
