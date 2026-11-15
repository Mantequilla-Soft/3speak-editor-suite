// A render queue instead of "Render failed" (src/utils/renderQueue.js): the
// editor waits for a busy server and stops at the first hard error.
import { describe, it, expect } from 'vitest'
import { submitRender, pollRender, retryDelay, isRetryable, isRenderActive, positionText, statusPhase } from '../src/utils/renderQueue.js'

const res = (status, data) => ({ status, ok: status >= 200 && status < 300, json: async () => data })
// A clock that only moves when the code sleeps
function clock() {
  let t = 0
  const waits = []
  return { now: () => t, sleep: async (ms) => { waits.push(ms); t += ms }, waits }
}
const replies = (...list) => { let i = 0; const calls = []; return { fn: () => { calls.push(i); const r = list[Math.min(i++, list.length - 1)]; return r instanceof Error ? Promise.reject(r) : Promise.resolve(r) }, calls } }

describe('submitting a render', () => {
  it('a busy server (503) is tried again with backoff and its retryAfter, then the job is in line', async () => {
    const c = clock()
    const r = replies(res(503, { error: 'Server busy', retryAfter: 30 }), res(503, { error: 'Server busy' }), new TypeError('Failed to fetch'), res(200, { jobId: 'j1', status: 'queued', position: 2 }))
    const waits = []
    const out = await submitRender({ send: r.fn, sleep: c.sleep, now: c.now, onWait: (w) => waits.push(w) })
    expect(out).toEqual({ jobId: 'j1', status: 'queued', position: 2 })
    expect(c.waits).toEqual([30000, 4000, 8000])
    expect(waits).toEqual([{ seconds: 30, busy: true }, { seconds: 4, busy: true }, { seconds: 8, busy: false }])
  })

  it('a hard error (400, 401, 413, 500) is reported at once, no retry', async () => {
    for (const status of [400, 401, 413, 500]) {
      const c = clock()
      const r = replies(res(status, { error: `nope ${status}` }))
      await expect(submitRender({ send: r.fn, sleep: c.sleep, now: c.now })).rejects.toThrow(`nope ${status}`)
      expect(r.calls).toHaveLength(1)
    }
  })

  it('gives up after about 10 minutes of busy, with a plain message', async () => {
    const c = clock()
    const r = replies(res(503, { error: 'Server busy' }))
    await expect(submitRender({ send: r.fn, sleep: c.sleep, now: c.now })).rejects.toThrow(/still busy/)
    expect(c.now()).toBeLessThanOrEqual(10 * 60 * 1000)
    expect(r.calls.length).toBeGreaterThan(10)
  })

  it('stops when cancelled', async () => {
    const ac = new AbortController()
    const r = replies(res(503, {}))
    const out = await submitRender({ send: r.fn, signal: ac.signal, sleep: async () => ac.abort() })
    expect(out).toBe(null)
    expect(r.calls).toHaveLength(1)
  })
})

describe('following a render', () => {
  it('shows the place in line, then the progress, and ends when it is done', async () => {
    const c = clock()
    const seen = []
    const r = replies(
      res(200, { status: 'queued', position: 2 }), res(200, { status: 'queued', position: 1 }),
      res(200, { status: 'processing', progress: 0.4, phase: 'Processing video...' }),
      res(200, { status: 'completed', outputUrl: '/rendered/j1.mp4' }))
    const out = await pollRender({ get: r.fn, sleep: c.sleep, now: c.now, onStatus: (d) => seen.push(statusPhase(d)) })
    expect(out.status).toBe('completed')
    expect(seen).toEqual(['You are 2nd in line', 'You are next', 'Processing video...'])
  })

  it('a failed job ends the polling (no loop)', async () => {
    const c = clock()
    const r = replies(res(200, { status: 'failed', error: 'ffmpeg exploded' }), res(200, { status: 'processing' }))
    const out = await pollRender({ get: r.fn, sleep: c.sleep, now: c.now })
    expect(out).toEqual({ status: 'failed', error: 'ffmpeg exploded' })
    expect(r.calls).toHaveLength(1)
  })

  it('a job the server does not know (404) or a refusal (403) stops it at once', async () => {
    for (const status of [404, 403]) {
      const r = replies(res(status, { error: 'Job not found' }))
      await expect(pollRender({ get: r.fn, sleep: async () => {} })).rejects.toThrow()
      expect(r.calls).toHaveLength(1)
    }
  })

  it('rides out a short outage (network errors, 502), gives up after 2 minutes without an answer', async () => {
    const c = clock()
    const seen = []
    const r = replies(new TypeError('Failed to fetch'), res(502, {}), res(200, { status: 'processing', progress: 0.5 }), res(200, { status: 'completed', outputUrl: '/x.mp4' }))
    const out = await pollRender({ get: r.fn, sleep: c.sleep, now: c.now, onStatus: (d) => seen.push(d.reconnecting ? 'reconnecting' : d.status) })
    expect(out.status).toBe('completed')
    expect(seen).toEqual(['reconnecting', 'reconnecting', 'processing'])

    const c2 = clock()
    const down = replies(new TypeError('Failed to fetch'))
    await expect(pollRender({ get: down.fn, sleep: c2.sleep, now: c2.now })).rejects.toThrow(/Lost contact/)
    expect(c2.now()).toBeGreaterThan(2 * 60 * 1000)
    expect(c2.now()).toBeLessThan(3 * 60 * 1000)
  })
})

describe('helpers', () => {
  it('retry delays double from 2 s up to 30 s, never below the server\'s retryAfter', () => {
    expect([1, 2, 3, 4, 5, 6, 9].map(a => retryDelay(a))).toEqual([2000, 4000, 8000, 16000, 30000, 30000, 30000])
    expect(retryDelay(1, 10)).toBe(10000)
    expect(retryDelay(1, 600)).toBe(30000)
  })
  it('what is retried, what counts as rendering', () => {
    expect([0, 429, 502, 503, 504].every(isRetryable)).toBe(true)
    expect([400, 401, 403, 404, 413, 500].some(isRetryable)).toBe(false)
    expect(['submitting', 'queued', 'processing'].every(isRenderActive)).toBe(true)
    expect(['completed', 'failed', 'aborted', undefined].some(isRenderActive)).toBe(false)
  })
  it('positions read like a person would say them', () => {
    expect([1, 2, 3, 4, 11, 21, 22, 23].map(positionText)).toEqual(['You are next', 'You are 2nd in line', 'You are 3rd in line', 'You are 4th in line', 'You are 11th in line', 'You are 21st in line', 'You are 22nd in line', 'You are 23rd in line'])
    expect(statusPhase({ status: 'queued' })).toMatch(/Waiting/)
  })
})
