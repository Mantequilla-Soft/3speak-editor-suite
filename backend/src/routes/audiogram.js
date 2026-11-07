import { Router } from 'express'
import { spawn } from 'child_process'
import { v4 as uuidv4 } from 'uuid'
import path from 'path'
import fs from 'fs/promises'
import { requireSignIn } from '../auth.js'
import { downloadMedia } from '../utils/download.js'
import { audiogramArgs, cleanAudiogramOptions, wrapTitle } from '../services/audiogram.js'

/**
 * Audiogram jobs (the audio editor's "Audiogram" after an export):
 *   POST /api/audiogram { url, start, duration, format: 'square' | 'vertical', title }
 *     -> { jobId }; url is the exported MP3 (/rendered/<name>.mp3 on this
 *        backend, else fetched like a render's media)
 *   GET /api/audiogram/:jobId -> { status, progress, outputUrl? , error? }
 * The MP4 lands in the rendered folder (removed by the usual cleanup).
 */
const router = Router()
const RENDERED_DIR = process.env.RENDERED_DIR || '/app/rendered'
const WORK_DIR = process.env.WORK_DIR || '/app/work'
const MAX_RUNNING = 2
const jobs = new Map()
let running = 0

// Our own export: the file itself (no download), else null
async function localRendered(url) {
  try {
    const p = new URL(url, 'http://local').pathname
    const m = /^\/rendered\/([A-Za-z0-9_.-]+\.mp3)$/.exec(p)
    if (!m) return null
    const file = path.join(RENDERED_DIR, m[1])
    await fs.access(file)
    return file
  } catch {
    return null
  }
}

function run(args, onTime, timeoutMs = 5 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [...args.slice(0, -1), '-progress', 'pipe:1', '-nostats', args.at(-1)], { stdio: ['ignore', 'pipe', 'pipe'] })
    let tail = ''
    proc.stdout.on('data', d => {
      const m = /out_time_us=(\d+)/.exec(String(d))
      if (m) onTime(+m[1] / 1e6)
    })
    proc.stderr.on('data', d => { tail = (tail + d).slice(-600) })
    const timer = setTimeout(() => { proc.kill('SIGTERM'); reject(new Error('Audiogram timed out')) }, timeoutMs)
    proc.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${tail.split('\n').filter(Boolean).pop() || ''}`)) })
    proc.on('error', err => { clearTimeout(timer); reject(err) })
  })
}

async function process_(job, { url, title }) {
  const jobDir = path.join(WORK_DIR, `audiogram-${job.id}`)
  await fs.mkdir(jobDir, { recursive: true })
  try {
    job.phase = 'Getting the audio...'
    const input = (await localRendered(url)) || await downloadMedia(url, 'audio', jobDir)
    const lines = wrapTitle(title)
    const titleFile = path.join(jobDir, 'title.txt')
    await fs.writeFile(titleFile, lines.join('\n'))
    await fs.mkdir(RENDERED_DIR, { recursive: true })
    const name = `audiogram-${job.id}.mp4`
    const part = path.join(RENDERED_DIR, `${name}.part.mp4`)
    job.phase = 'Drawing the audiogram...'
    await run(audiogramArgs({ input, output: part, ...job.options, titleFile, hasTitle: lines.length > 0 }), (t) => {
      job.progress = Math.min(0.99, t / job.options.duration)
    })
    await fs.rename(part, path.join(RENDERED_DIR, name))
    Object.assign(job, { status: 'completed', progress: 1, phase: 'Complete', outputUrl: `/rendered/${name}` })
    console.log(`[audiogram] ${job.id}: ${job.options.format} ${job.options.duration}s -> ${name}`)
  } catch (err) {
    Object.assign(job, { status: 'failed', phase: 'Failed', error: err.message })
    console.warn(`[audiogram] ${job.id} failed: ${err.message}`)
  } finally {
    running--
    fs.rm(jobDir, { recursive: true, force: true }).catch(() => {})
    setTimeout(() => jobs.delete(job.id), 60 * 60 * 1000).unref?.()
  }
}

router.post('/', requireSignIn, (req, res) => {
  const url = req.body?.url
  if (typeof url !== 'string' || !url || url.length > 2000) return res.status(400).json({ error: 'url required' })
  const options = cleanAudiogramOptions(req.body)
  if (options.error) return res.status(400).json({ error: options.error })
  if (running >= MAX_RUNNING) return res.status(503).json({ error: 'Server busy', retryAfter: 15 })
  const id = uuidv4()
  const job = { id, status: 'processing', progress: 0, phase: 'Starting...', options }
  jobs.set(id, job)
  running++
  process_(job, { url, title: String(req.body?.title || '').slice(0, 200) })
  res.json({ jobId: id })
})

router.get('/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId)
  if (!job) return res.status(404).json({ error: 'Job not found' })
  const { status, progress, phase, outputUrl, error } = job
  res.json({ status, progress, phase, ...(outputUrl ? { outputUrl } : {}), ...(error ? { error } : {}) })
})

export { router as audiogramRouter }
