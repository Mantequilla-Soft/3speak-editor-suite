import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import path from 'path'
import fs from 'fs/promises'
import { requireSignIn } from '../auth.js'
import { cachedDownload } from './render.js'
import { sttStatus, STT_LANGUAGES } from '../services/stt.js'
import { cleanSources, runTranscriptJob } from '../services/transcript.js'

// The transcript of a show, for editing by text, removing fillers, chapter
// ideas and audiogram captions (services/transcript.js):
//   GET    /api/transcript/status      { available, languages, maxSeconds, chunkSeconds }
//   POST   /api/transcript             { sources: [{ id, url, ranges: [[from, to]] }], language, verbatim }
//                                      -> { jobId }; times in each source's own seconds
//   GET    /api/transcript/:jobId?from=n
//          { status, progress, phase, language, chunks: [{ source, from, to, words }] (from the n-th on), next, error }
//   DELETE /api/transcript/:jobId      stops it (the chunks done so far stay readable)
// A url is one of the editor's uploads, a render of this backend
// (/rendered/<name>.mp3, an exported episode) or any media URL a render takes.
const router = Router()
const WORK_DIR = process.env.WORK_DIR || '/app/work'
const RENDERED_DIR = process.env.RENDERED_DIR || '/app/rendered'
// The most audio one job listens to (an hour-long show with two or three voices)
export const MAX_TRANSCRIPT_SECONDS = Math.max(60, parseInt(process.env.TRANSCRIPT_MAX_SECONDS, 10) || 4 * 60 * 60)
const MAX_WAITING = 4
const KEEP_MS = 60 * 60 * 1000

const jobs = new Map()
let running = 0
const waiting = []

/** A render of this backend as its file (no download), else null. */
export async function localRendered(url) {
  try {
    const p = new URL(url, 'http://local').pathname
    const m = /^\/rendered\/([A-Za-z0-9_.-]+\.(mp3|mp4|m4a|wav))$/.exec(p)
    if (!m) return null
    const file = path.join(RENDERED_DIR, m[1])
    await fs.access(file)
    return file
  } catch {
    return null
  }
}

const fetchSource = async (url, jobDir) => (await localRendered(url)) || cachedDownload(url, jobDir)

router.get('/status', async (req, res) => {
  res.set('Cache-Control', 'no-store')
  res.json({ ...(await sttStatus()), languages: STT_LANGUAGES, maxSeconds: MAX_TRANSCRIPT_SECONDS })
})

router.post('/', requireSignIn, async (req, res) => {
  const stt = await sttStatus()
  if (!stt.available) return res.status(503).json({ error: 'Transcripts are not available on this server', code: 'unavailable' })
  const clean = cleanSources(req.body, MAX_TRANSCRIPT_SECONDS)
  if (clean.error) return res.status(400).json({ error: clean.error })
  if (waiting.length >= MAX_WAITING) return res.status(503).json({ error: 'Server busy', retryAfter: 20 })
  const language = STT_LANGUAGES.includes(req.body?.language) ? req.body.language : 'auto'
  const controller = new AbortController()
  const job = {
    id: uuidv4(), status: 'queued', progress: 0, phase: 'Waiting for a free slot...', error: null,
    sources: clean.sources, total: clean.total, language, verbatim: req.body?.verbatim !== false, chunks: [], controller
  }
  jobs.set(job.id, job)
  const run = () => {
    if (controller.signal.aborted) { setTimeout(() => jobs.delete(job.id), KEEP_MS).unref?.(); waiting.shift()?.(); return }
    running++
    runTranscriptJob(job, { fetchSource, workDir: WORK_DIR, signal: controller.signal })
      .catch(err => {
        if (!controller.signal.aborted) console.error(`[transcript] Job ${job.id} failed:`, err.message)
        job.status = controller.signal.aborted ? 'cancelled' : 'failed'
        job.error = controller.signal.aborted ? null : err.message
        job.phase = controller.signal.aborted ? 'Stopped' : 'Failed'
      })
      .finally(() => {
        running--
        const words = job.chunks.reduce((n, c) => n + c.words.length, 0)
        console.log(`[transcript] Job ${job.id}: ${words} words (${job.language || '?'}) from ${Math.round(job.total)} s, ${job.status}`)
        waiting.shift()?.()
        setTimeout(() => jobs.delete(job.id), KEEP_MS).unref?.()
      })
  }
  if (running < 1) run()
  else waiting.push(run)
  res.json({ jobId: job.id })
})

router.get('/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId)
  if (!job) return res.status(404).json({ error: 'Job not found' })
  res.set('Cache-Control', 'no-store')
  const from = Math.max(0, parseInt(req.query.from, 10) || 0)
  const { id, status, progress, phase, language, error } = job
  res.json({ jobId: id, status, progress, phase, language, error, chunks: job.chunks.slice(from), next: job.chunks.length })
})

router.delete('/:jobId', requireSignIn, (req, res) => {
  const job = jobs.get(req.params.jobId)
  if (!job) return res.status(404).json({ error: 'Job not found' })
  job.controller.abort()
  if (job.status === 'queued') { job.status = 'cancelled'; job.phase = 'Stopped' }
  res.json({ ok: true })
})

export { router as transcriptRouter }
