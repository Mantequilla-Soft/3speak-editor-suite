// Render jobs wait in line instead of being turned away: up to maxConcurrent
// run, the rest queue (first come, first served) and start when a place is
// free. Every job is a JSON file (store dir), so a restart loses nothing:
// queued jobs queue again in their order, a job that was running when the
// server stopped starts again once (then it is marked failed with a reason).
import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'

export class QueueFullError extends Error {
  constructor(queued) {
    super('Server busy')
    this.queued = queued
  }
}

export const RESTART_LIMIT = 1 // a job interrupted by a restart starts again this many times
export const INTERRUPTED_ERROR = 'The server restarted twice while this video was rendering. Please render it again.'
const FINISHED = new Set(['completed', 'failed', 'aborted'])
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/

/** One JSON file per job in `dir` (written whole: tmp file, then rename). */
export function createJobStore(dir) {
  const file = (id) => path.join(dir, `${id}.json`)
  let ready = null
  const mkdir = () => (ready ||= fsp.mkdir(dir, { recursive: true }))
  // writes of one job in order, the last one wins
  const chains = new Map()
  const inOrder = (id, op) => {
    const next = (chains.get(id) || Promise.resolve()).then(op)
      .catch(err => console.warn(`[render-queue] job file ${id}: ${err.message}`))
    chains.set(id, next)
    next.finally(() => { if (chains.get(id) === next) chains.delete(id) })
    return next
  }
  return {
    dir,
    save(job) {
      if (!SAFE_ID.test(job.id)) return Promise.resolve()
      const data = JSON.stringify(job)
      return inOrder(job.id, async () => {
        await mkdir()
        const tmp = `${file(job.id)}.${process.pid}.tmp`
        await fsp.writeFile(tmp, data)
        await fsp.rename(tmp, file(job.id))
      })
    },
    remove(id) {
      if (!SAFE_ID.test(id)) return Promise.resolve()
      return inOrder(id, () => fsp.rm(file(id), { force: true }))
    },
    loadAll() {
      let names = []
      try { names = fs.readdirSync(dir) } catch { return [] }
      const out = []
      for (const n of names) {
        if (!n.endsWith('.json')) continue
        try {
          const job = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'))
          if (job && SAFE_ID.test(job.id || '') && `${job.id}.json` === n) out.push(job)
        } catch (err) {
          console.warn(`[render-queue] unreadable job file ${n}: ${err.message}`)
        }
      }
      return out
    },
    /** All saves written (tests, shutdown). */
    flush() { return Promise.all([...chains.values()]) }
  }
}

/** "You are next" / "You are 2nd in line" (position 1 = the next to start). */
export function positionText(position) {
  if (!(position >= 1)) return null
  if (position === 1) return 'You are next'
  const n = Math.floor(position)
  const suffix = (n % 100 >= 11 && n % 100 <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th')
  return `You are ${n}${suffix} in line`
}

/**
 * run(job, { signal }) does the work and fills in job.status / outputUrl /
 * error (it may also throw: the job then fails with that message).
 */
export function createRenderQueue({ maxConcurrent = 2, maxQueued = 20, store = null, run, keepFinishedMs = 60 * 60 * 1000, now = () => Date.now() }) {
  const jobs = new Map()
  const waiting = [] // job ids, in order
  const running = new Map() // id -> AbortController
  const timers = new Set()

  const save = (job) => (store ? store.save(job) : Promise.resolve())

  const forgetLater = (job, ms = keepFinishedMs) => {
    const t = setTimeout(() => {
      timers.delete(t)
      if (jobs.get(job.id) === job && FINISHED.has(job.status)) {
        jobs.delete(job.id)
        store?.remove(job.id)
      }
    }, Math.max(0, ms))
    t.unref?.()
    timers.add(t)
  }

  const finish = (job) => {
    job.finishedAt = now()
    delete job.position
    save(job)
    forgetLater(job)
  }

  const start = (job) => {
    const ac = new AbortController()
    running.set(job.id, ac)
    job.status = 'processing'
    job.startedAt = now()
    job.attempts = (job.attempts || 0) + 1
    if (!job.phase || job.phase === 'Queued' || /in line|You are next/.test(job.phase)) job.phase = 'Starting...'
    delete job.position
    save(job)
    new Promise(resolve => resolve(run(job, { signal: ac.signal })))
      .catch(err => {
        if (job.status !== 'aborted') {
          job.status = 'failed'
          job.error = err?.message || String(err)
          job.phase = 'Failed'
        }
      })
      .finally(() => {
        running.delete(job.id)
        if (!FINISHED.has(job.status)) {
          job.status = 'failed'
          job.error = job.error || 'The render stopped without a result'
          job.phase = 'Failed'
        }
        finish(job)
        pump()
      })
  }

  const pump = () => {
    while (running.size < maxConcurrent && waiting.length) {
      const job = jobs.get(waiting.shift())
      if (job && job.status === 'queued') start(job)
    }
    waiting.forEach((id, i) => {
      const j = jobs.get(id)
      if (j) j.phase = positionText(i + 1)
    })
  }

  const api = {
    jobs,
    /** Queue a new job ({ id, ...data }); throws QueueFullError when the line is full. */
    add(job) {
      if (running.size >= maxConcurrent && waiting.length >= maxQueued) throw new QueueFullError(waiting.length)
      Object.assign(job, { status: 'queued', progress: 0, phase: 'Queued', outputUrl: null, error: null, createdAt: job.createdAt || now(), attempts: 0 })
      jobs.set(job.id, job)
      waiting.push(job.id)
      save(job)
      pump()
      return job
    },
    get(id) { return jobs.get(id) || null },
    /** 1 = the next to start, 0 = not waiting. */
    position(id) { return waiting.indexOf(id) + 1 },
    abort(id) {
      const job = jobs.get(id)
      if (!job || FINISHED.has(job.status)) return job || null
      const i = waiting.indexOf(id)
      if (i >= 0) waiting.splice(i, 1)
      running.get(id)?.abort()
      job.status = 'aborted'
      job.phase = 'Aborted'
      job.error = 'Job aborted by user'
      if (i >= 0) { finish(job); pump() } // a running one finishes when its run() returns
      return job
    },
    /** What /api/render/:id answers. */
    view(job) {
      const position = job.status === 'queued' ? api.position(job.id) : 0
      return {
        jobId: job.id,
        status: job.status,
        progress: job.progress,
        phase: job.status === 'queued' ? positionText(position) || job.phase : job.phase,
        outputUrl: job.outputUrl,
        error: job.error,
        ...(position ? { position } : {}),
        ...(job.restarted ? { restarted: true } : {}),
        ...(job.subtitles && { subtitles: job.subtitles })
      }
    },
    stats() {
      return { activeJobs: running.size, queuedJobs: waiting.length, maxConcurrentJobs: maxConcurrent, maxQueuedJobs: maxQueued }
    },
    /**
     * After a restart: the jobs from the store. Finished ones answer status
     * polls until they expire, queued ones queue again in their order, and
     * one that was running starts again (RESTART_LIMIT times, then it fails).
     */
    restore() {
      if (!store) return { requeued: 0, restarted: 0, failed: 0, kept: 0 }
      const list = store.loadAll().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
      const count = { requeued: 0, restarted: 0, failed: 0, kept: 0 }
      for (const job of list) {
        if (jobs.has(job.id)) continue
        if (FINISHED.has(job.status)) {
          const left = keepFinishedMs - (now() - (job.finishedAt || job.createdAt || 0))
          if (left <= 0) { store.remove(job.id); continue }
          jobs.set(job.id, job)
          forgetLater(job, left)
          count.kept++
          continue
        }
        if (job.status === 'processing') {
          if ((job.attempts || 1) > RESTART_LIMIT) {
            Object.assign(job, { status: 'failed', phase: 'Failed', error: INTERRUPTED_ERROR })
            jobs.set(job.id, job)
            finish(job)
            count.failed++
            continue
          }
          job.restarted = true
          count.restarted++
        } else {
          count.requeued++
        }
        job.status = 'queued'
        job.progress = 0
        job.phase = 'Queued'
        jobs.set(job.id, job)
        waiting.push(job.id)
        save(job)
      }
      pump()
      return count
    },
    /** Tests: stop timers. */
    close() { for (const t of timers) clearTimeout(t); timers.clear() }
  }
  return api
}
