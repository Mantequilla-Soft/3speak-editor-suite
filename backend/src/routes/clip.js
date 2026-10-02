import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import path from 'path'
import fs from 'fs/promises'
import { spawn } from 'child_process'
import { selectVariantUrl } from '../utils/m3u8Parser.js'
import multer from 'multer'

const router = Router()
const RENDERED_DIR = process.env.RENDERED_DIR || '/app/rendered'
const UPLOADS_DIR = process.env.UPLOADS_DIR || '/app/uploads'
const upload = multer({ dest: UPLOADS_DIR })

// In-memory job store
const jobs = new Map()

/**
 * POST /api/clip/prepare
 * Body: { url, clipStart, clipEnd }
 */
router.post('/prepare', async (req, res) => {
  try {
    const { url, clipStart, clipEnd } = req.body

    if (!url || !url.includes('.m3u8')) {
      return res.status(400).json({ error: 'HLS URL required' })
    }
    if (clipStart == null || clipEnd == null || clipEnd <= clipStart) {
      return res.status(400).json({ error: 'Valid clipStart and clipEnd required' })
    }

    const jobId = uuidv4()
    const job = {
      id: jobId,
      status: 'processing',
      progress: 0,
      phase: 'Parsing playlist...',
      outputUrl: null,
      error: null,
      createdAt: Date.now()
    }

    jobs.set(jobId, job)

    processClipJob(jobId, url, clipStart, clipEnd).catch(err => {
      console.error(`[clip] Job ${jobId} failed:`, err)
      const j = jobs.get(jobId)
      if (j) {
        j.status = 'failed'
        j.error = err.message
        j.phase = 'Failed'
      }
    })

    res.json({ jobId })
  } catch (err) {
    console.error('[clip] Error creating job:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * GET /api/clip/prepare/:jobId
 */
router.get('/prepare/:jobId', (req, res) => {
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

async function processClipJob(jobId, hlsUrl, clipStart, clipEnd) {
  const job = jobs.get(jobId)
  if (!job) return

  try {
    // Step 1: Parse m3u8 and select 480p variant
    job.phase = 'Selecting video quality...'
    job.progress = 0.1
    const variantUrl = await selectVariantUrl(hlsUrl)

    // Step 2: Download + trim with FFmpeg
    job.phase = 'Downloading and trimming...'
    job.progress = 0.2

    await fs.mkdir(RENDERED_DIR, { recursive: true })

    const outputFilename = `clip-${jobId}.mp4`
    const outputPath = path.join(RENDERED_DIR, outputFilename)
    const duration = clipEnd - clipStart

    await runFFmpegClip(variantUrl, outputPath, clipStart, duration, (progress) => {
      job.progress = 0.2 + progress * 0.75
    })

    job.status = 'completed'
    job.progress = 1.0
    job.phase = 'Complete'
    job.outputUrl = `/rendered/${outputFilename}`

    console.log(`[clip] Job ${jobId} complete: ${outputFilename}`)
  } catch (err) {
    job.status = 'failed'
    job.error = err.message
    job.phase = 'Failed'
    throw err
  } finally {
    // Clean up job data after 1 hour
    setTimeout(() => {
      jobs.delete(jobId)
    }, 60 * 60 * 1000)
  }
}

/**
 * Run FFmpeg to download from HLS variant and trim in one pass.
 *
 * Uses input-level seek (-ss before -i) for fast HLS segment skipping,
 * then RE-ENCODES audio and video to guarantee proper sync.
 *
 * Why not -c copy?  Input-level seek lands on the nearest keyframe, and
 * audio/video keyframes rarely align in HLS streams.  Stream-copying
 * preserves that misalignment, producing an MP4 whose audio starts
 * several seconds into the file.  Re-encoding resets both streams to
 * start at exactly t=0.
 */
function runFFmpegClip(inputUrl, outputPath, seekTime, duration, onProgress) {
  return new Promise((resolve, reject) => {
    const args = []
    // Only add -ss when seeking past the start — -ss 0 on HLS streams can
    // confuse FFmpeg's segment parser when the first segment has non-zero PTS,
    // occasionally producing a single-frame (freeze-frame) output.
    if (seekTime > 0) {
      args.push('-ss', seekTime.toString())
    }
    args.push(
      '-i', inputUrl,
      '-t', duration.toString(),
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '23',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ar', '44100',
      '-movflags', '+faststart',
      '-y',
      outputPath
    )

    console.log(`[clip] ffmpeg ${args.join(' ')}`)
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] })

    let stderr = ''
    proc.stderr.on('data', (d) => {
      stderr += d.toString()
      // Parse FFmpeg progress from "time=HH:MM:SS.ms"
      const timeMatch = d.toString().match(/time=(\d+):(\d+):(\d+)\.(\d+)/)
      if (timeMatch && duration > 0) {
        const currentTime = parseInt(timeMatch[1]) * 3600 +
                           parseInt(timeMatch[2]) * 60 +
                           parseInt(timeMatch[3]) +
                           parseInt(timeMatch[4]) / 100
        onProgress(Math.min(currentTime / duration, 1.0))
      }
    })

    proc.on('close', (code) => {
      if (code === 0) {
        onProgress(1.0)
        resolve()
      } else {
        reject(new Error(`FFmpeg clip failed (exit ${code}): ${stderr.slice(-500)}`))
      }
    })

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn ffmpeg: ${err.message}`))
    })

    // 10 minute timeout
    setTimeout(() => {
      proc.kill('SIGTERM')
      reject(new Error('Clip preparation timed out'))
    }, 10 * 60 * 1000)
  })
}

/**
 * POST /api/clip/reverse
 * Accepts either:
 *   - multipart form with 'file' field (for blob: URLs uploaded from browser)
 *   - multipart form with 'url' field (for remote URLs)
 * Plus 'startTime' and 'endTime' fields.
 */
router.post('/reverse', upload.single('file'), async (req, res) => {
  try {
    const startTime = parseFloat(req.body.startTime)
    const endTime = parseFloat(req.body.endTime)
    const url = req.body.url || null
    const uploadedFile = req.file || null

    if (!url && !uploadedFile) {
      return res.status(400).json({ error: 'URL or file required' })
    }
    if (isNaN(startTime) || isNaN(endTime) || endTime <= startTime) {
      return res.status(400).json({ error: 'Valid startTime and endTime required' })
    }

    // Determine the input path: uploaded file, local path, or remote URL
    let inputPath
    if (uploadedFile) {
      inputPath = uploadedFile.path
    } else if (url.startsWith('/rendered/')) {
      inputPath = path.join(RENDERED_DIR, url.split('/').pop())
    } else if (url.startsWith('/api/upload/files/')) {
      inputPath = path.join(UPLOADS_DIR, url.split('/').pop())
    } else {
      inputPath = url
    }

    const jobId = uuidv4()
    const job = {
      id: jobId,
      status: 'processing',
      progress: 0,
      phase: 'Reversing clip...',
      outputUrl: null,
      error: null,
      createdAt: Date.now()
    }

    jobs.set(jobId, job)

    processReverseJob(jobId, inputPath, startTime, endTime, uploadedFile?.path).catch(err => {
      console.error(`[reverse] Job ${jobId} failed:`, err)
      const j = jobs.get(jobId)
      if (j) {
        j.status = 'failed'
        j.error = err.message
        j.phase = 'Failed'
      }
    })

    res.json({ jobId })
  } catch (err) {
    console.error('[reverse] Error creating job:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * GET /api/clip/reverse/:jobId
 */
router.get('/reverse/:jobId', (req, res) => {
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

async function processReverseJob(jobId, inputPath, startTime, endTime, uploadedFilePath) {
  const job = jobs.get(jobId)
  if (!job) return

  try {
    await fs.mkdir(RENDERED_DIR, { recursive: true })

    const outputFilename = `reversed-${jobId}.mp4`
    const outputPath = path.join(RENDERED_DIR, outputFilename)
    const duration = endTime - startTime

    job.phase = 'Reversing video...'
    job.progress = 0.1

    await runFFmpegReverse(inputPath, outputPath, startTime, duration, (progress) => {
      job.progress = 0.1 + progress * 0.85
    })

    job.status = 'completed'
    job.progress = 1.0
    job.phase = 'Complete'
    job.outputUrl = `/rendered/${outputFilename}`

    console.log(`[reverse] Job ${jobId} complete: ${outputFilename}`)
  } catch (err) {
    job.status = 'failed'
    job.error = err.message
    job.phase = 'Failed'
    throw err
  } finally {
    // Clean up uploaded file
    if (uploadedFilePath) {
      fs.unlink(uploadedFilePath).catch(() => {})
    }
    setTimeout(() => {
      jobs.delete(jobId)
    }, 60 * 60 * 1000)
  }
}

function runFFmpegReverse(inputUrl, outputPath, seekTime, duration, onProgress) {
  return new Promise((resolve, reject) => {
    const args = []
    if (seekTime > 0) {
      args.push('-ss', seekTime.toString())
    }
    args.push(
      '-i', inputUrl,
      '-t', duration.toString(),
      '-vf', 'reverse',
      '-af', 'areverse',
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '23',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ar', '44100',
      '-movflags', '+faststart',
      '-y',
      outputPath
    )

    console.log(`[reverse] ffmpeg ${args.join(' ')}`)
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] })

    let stderr = ''
    proc.stderr.on('data', (d) => {
      stderr += d.toString()
      const timeMatch = d.toString().match(/time=(\d+):(\d+):(\d+)\.(\d+)/)
      if (timeMatch && duration > 0) {
        const currentTime = parseInt(timeMatch[1]) * 3600 +
                           parseInt(timeMatch[2]) * 60 +
                           parseInt(timeMatch[3]) +
                           parseInt(timeMatch[4]) / 100
        onProgress(Math.min(currentTime / duration, 1.0))
      }
    })

    proc.on('close', (code) => {
      if (code === 0) {
        onProgress(1.0)
        resolve()
      } else {
        reject(new Error(`FFmpeg reverse failed (exit ${code}): ${stderr.slice(-500)}`))
      }
    })

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn ffmpeg: ${err.message}`))
    })

    setTimeout(() => {
      proc.kill('SIGTERM')
      reject(new Error('Reverse processing timed out'))
    }, 10 * 60 * 1000)
  })
}

export { router as clipRouter }
