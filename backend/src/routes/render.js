import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import path from 'path'
import fs from 'fs/promises'
import { downloadMedia } from '../utils/download.js'
import { buildAndRunFFmpeg } from '../services/ffmpeg.js'

const router = Router()
const RENDERED_DIR = process.env.RENDERED_DIR || '/app/rendered'
const WORK_DIR = process.env.WORK_DIR || '/app/work'
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_JOBS || '2', 10)

// In-memory job store
const jobs = new Map()
// AbortControllers for active jobs
const abortControllers = new Map()
let activeJobs = 0

/**
 * POST /api/render
 * Body: { timeline: { tracks, outputWidth, outputHeight, fps }, mediaUrls }
 */
router.post('/', async (req, res) => {
  try {
    const { timeline } = req.body

    if (!timeline || !timeline.tracks || timeline.tracks.length === 0) {
      return res.status(400).json({ error: 'Invalid timeline: tracks required' })
    }

    if (activeJobs >= MAX_CONCURRENT) {
      return res.status(503).json({ error: 'Server busy', retryAfter: 30 })
    }

    const jobId = uuidv4()
    const jobDir = path.join(WORK_DIR, jobId)

    const job = {
      id: jobId,
      status: 'queued',
      progress: 0,
      phase: 'Queued',
      outputUrl: null,
      error: null,
      createdAt: Date.now(),
      timeline
    }

    jobs.set(jobId, job)

    processJob(jobId, jobDir).catch(err => {
      console.error(`[render] Job ${jobId} failed:`, err)
      const j = jobs.get(jobId)
      if (j && j.status !== 'aborted') {
        j.status = 'failed'
        j.error = err.message
        j.phase = 'Failed'
      }
    })

    res.json({ jobId })
  } catch (err) {
    console.error('[render] Error creating job:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * GET /api/render/:jobId
 */
router.get('/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId)
  if (!job) {
    return res.status(404).json({ error: 'Job not found' })
  }

  res.json({
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    phase: job.phase,
    outputUrl: job.outputUrl,
    error: job.error
  })
})

/**
 * POST /api/render/:jobId/abort
 */
router.post('/:jobId/abort', (req, res) => {
  const job = jobs.get(req.params.jobId)
  if (!job) {
    return res.status(404).json({ error: 'Job not found' })
  }

  if (job.status === 'completed' || job.status === 'failed' || job.status === 'aborted') {
    return res.json({ jobId: job.id, status: job.status, message: 'Job already finished' })
  }

  const ac = abortControllers.get(req.params.jobId)
  if (ac) {
    ac.abort()
  }

  job.status = 'aborted'
  job.phase = 'Aborted'
  job.error = 'Job aborted by user'

  console.log(`[render] Job ${req.params.jobId} aborted`)
  res.json({ jobId: job.id, status: 'aborted' })
})

/**
 * Process a render job:
 * 1. Download media
 * 2. Run FFmpeg
 * 3. Move output to rendered dir
 */
async function processJob(jobId, jobDir) {
  const job = jobs.get(jobId)
  if (!job) return

  const ac = new AbortController()
  abortControllers.set(jobId, ac)

  activeJobs++

  try {
    await fs.mkdir(jobDir, { recursive: true })
    await fs.mkdir(RENDERED_DIR, { recursive: true })

    job.status = 'processing'
    job.phase = 'Downloading media...'
    job.progress = 0.05

    const { timeline } = job

    // Collect all clips with URLs
    const allClips = []
    for (const track of timeline.tracks) {
      for (const clip of track.clips) {
        if (clip.url) allClips.push(clip)
      }
    }

    // Download all media
    const downloadedFiles = new Map()
    for (let i = 0; i < allClips.length; i++) {
      if (ac.signal.aborted) throw new Error('Job aborted')

      const clip = allClips[i]
      job.phase = `Downloading ${clip.name || 'media'} (${i + 1}/${allClips.length})...`
      job.progress = 0.05 + (i / allClips.length) * 0.25

      const localPath = await downloadMedia(clip.url, clip.id, jobDir)
      downloadedFiles.set(clip.id, localPath)

      // Static-background key: the clean plate image travels as its own file
      // (plus its noise map, which tells the mask how much each spot flickers)
      const isStatic = clip.chromaKey?.color === 'static'
      for (const [field, suffix] of [['plateUrl', 'plate'], ['noiseUrl', 'noise']]) {
        const u = isStatic ? clip.chromaKey[field] : null
        if (!u || typeof u !== 'string' || /^(blob|data):/.test(u)) continue
        try {
          downloadedFiles.set(`${clip.id}__${suffix}`, await downloadMedia(u, `${clip.id}__${suffix}`, jobDir))
        } catch (err) {
          console.warn(`[render] ${suffix} image for ${clip.id} could not be downloaded: ${err.message}`)
        }
      }
    }

    job.phase = 'Processing video...'
    job.progress = 0.3

    // Build and run FFmpeg
    const outputFilename = `${jobId}.mp4`
    const outputPath = path.join(RENDERED_DIR, outputFilename)

    await buildAndRunFFmpeg({
      timeline,
      downloadedFiles,
      outputPath,
      jobDir,
      signal: ac.signal,
      onProgress: (progress, phase) => {
        job.progress = 0.3 + progress * 0.65
        if (phase) job.phase = phase
      }
    })

    job.phase = 'Complete'
    job.progress = 1.0
    job.status = 'completed'
    job.outputUrl = `/rendered/${outputFilename}`

    // Clean up work dir
    await fs.rm(jobDir, { recursive: true, force: true })
  } catch (err) {
    if (job.status !== 'aborted') {
      job.status = 'failed'
      job.error = err.message
      job.phase = 'Failed'
    }

    await fs.rm(jobDir, { recursive: true, force: true }).catch(() => {})
    throw err
  } finally {
    activeJobs--
    abortControllers.delete(jobId)

    // Clean up job data after 1 hour
    setTimeout(() => {
      jobs.delete(jobId)
    }, 60 * 60 * 1000)
  }
}

export { router as renderRouter }

export function getRenderStats() {
  return {
    activeJobs,
    maxConcurrentJobs: MAX_CONCURRENT
  }
}
