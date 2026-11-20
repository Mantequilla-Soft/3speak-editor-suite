import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import path from 'path'
import fs from 'fs/promises'
import { downloadMedia } from '../utils/download.js'
import { buildAndRunFFmpeg, RENDER_CACHE_DIR } from '../services/ffmpeg.js'
import { renderAudioTimeline, audioTimelineEnd } from '../services/audioRender.js'
import crypto from 'crypto'
import { requireSignIn } from '../auth.js'
import { landscapeRenderRefusal } from '../proGate.js'
import { renderUrlOf } from '../utils/uploadFiles.js'
import { emojiDownloads, emojiKey, writeSubtitleFiles } from '../services/captionBurn.js'
import { createRenderQueue, createJobStore, QueueFullError } from '../utils/renderQueue.js'

const router = Router()
const RENDERED_DIR = process.env.RENDERED_DIR || '/app/rendered'
const WORK_DIR = process.env.WORK_DIR || '/app/work'
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_JOBS || '2', 10)
// Longest audio-mode render (the editor's own limit is the same, src/utils/limits.js)
export const MAX_AUDIO_RENDER_SECONDS = 3 * 60 * 60

// Jobs wait in line when every render place is taken (utils/renderQueue.js),
// up to MAX_QUEUED_JOBS; each is a JSON file under RENDER_JOBS_DIR, so a
// restart or a redeploy loses none (the uploads volume, like the drafts)
const MAX_QUEUED = parseInt(process.env.MAX_QUEUED_JOBS || '20', 10)
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/app/uploads'
export const RENDER_JOBS_DIR = process.env.RENDER_JOBS_DIR || path.join(UPLOAD_DIR, '.render-jobs')
const queue = createRenderQueue({
  maxConcurrent: MAX_CONCURRENT,
  maxQueued: MAX_QUEUED,
  store: createJobStore(RENDER_JOBS_DIR),
  run: (job, { signal }) => processJob(job, path.join(WORK_DIR, job.id), signal).catch(err => {
    console.error(`[render] Job ${job.id} failed:`, err)
    throw err
  })
})

/** At boot: jobs from before the restart queue again (a running one starts over). */
export function restoreRenderJobs() {
  const c = queue.restore()
  if (c.requeued || c.restarted || c.failed) console.log(`[render] after the restart: ${c.requeued} queued again, ${c.restarted} started again, ${c.failed} failed (interrupted twice)`)
  return c
}

// Re-renders reuse what did not change (all kept for the usual cleanup age,
// refreshed when used):
// - downloads, by URL: a source is fetched once, not per render
// - the whole output, by the timeline: an unchanged edit returns the last render
// (unchanged clips inside a changed edit: see the clip cache in ffmpeg.js)
const DOWNLOAD_CACHE_DIR = path.join(RENDER_CACHE_DIR, 'downloads')
const sha = (v) => crypto.createHash('sha256').update(v).digest('hex').slice(0, 40)

async function touch(p) {
  const now = new Date()
  await fs.utimes(p, now, now).catch(() => {})
}

// An upload URL is fetched as its render source (?for=render: the original or
// its master, never the 480p editing proxy; see utils/uploadFiles.js), and
// cached under that URL. `state.final` turns false when a download was a
// stand-in (a master still being made): it is used once, not cached.
export async function cachedDownload(url, jobDir, state = {}) {
  const source = renderUrlOf(url)
  const key = sha(source)
  await fs.mkdir(DOWNLOAD_CACHE_DIR, { recursive: true })
  const hit = (await fs.readdir(DOWNLOAD_CACHE_DIR)).find(f => f.startsWith(key) && !f.endsWith('.part'))
  if (hit) {
    const p = path.join(DOWNLOAD_CACHE_DIR, hit)
    await touch(p)
    return p
  }
  // Download into the job's folder under the key, then move it in whole
  const info = {}
  const file = await downloadMedia(source, key, jobDir, info)
  if (info.final === false) {
    state.final = false
    console.log(`[render] ${source}: render copy not ready yet, using the ${info.kind || 'original'} for now (not cached)`)
    // Its own name, so the processed-clip cache (keyed by the input's name) never reuses it either
    const standIn = path.join(path.dirname(file), `${key}-standin-${Date.now()}${path.extname(file)}`)
    return fs.rename(file, standIn).then(() => standIn, () => file)
  }
  const cached = path.join(DOWNLOAD_CACHE_DIR, path.basename(file))
  try {
    await fs.rename(file, cached)
    return cached
  } catch {
    return file // another device or a race: use the job's own copy
  }
}

/**
 * POST /api/render
 * Body: { timeline: { tracks, outputWidth, outputHeight, fps }, mediaUrls }
 * 403 { code: 'pro_required', feature: 'landscape_editor', upgrade_url }: a landscape render of a free user
 */
router.post('/', requireSignIn, async (req, res) => {
  try {
    const { timeline } = req.body

    if (!timeline || !timeline.tracks || timeline.tracks.length === 0) {
      return res.status(400).json({ error: 'Invalid timeline: tracks required' })
    }
    // Audio mode: an MP3 of the audio tracks, up to MAX_AUDIO_RENDER_SECONDS
    if (timeline.output === 'audio') {
      const length = audioTimelineEnd(timeline.tracks)
      if (!(length > 0)) return res.status(400).json({ error: 'Nothing to render: the audio tracks are empty or muted' })
      if (length > MAX_AUDIO_RENDER_SECONDS + 1) {
        return res.status(400).json({ error: `Audio is ${Math.ceil(length / 60)} minutes long; the limit is ${MAX_AUDIO_RENDER_SECONDS / 3600} hours` })
      }
    }

    // Landscape (16:9, 4:3, 1:1) is 3Speak Pro; Shorts, audio and Ad Wizard mixes stay free (proGate.js)
    const refusal = await landscapeRenderRefusal(req, timeline)
    if (refusal) return res.status(403).json(refusal)

    let job
    try {
      job = queue.add({ id: uuidv4(), timeline })
    } catch (err) {
      if (!(err instanceof QueueFullError)) throw err
      // The line is full too: the editor tries again by itself
      return res.status(503).json({ error: 'Server busy', retryAfter: 30, queuedJobs: err.queued })
    }
    res.json(queue.view(job))
  } catch (err) {
    console.error('[render] Error creating job:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * GET /api/render/:jobId
 */
router.get('/:jobId', (req, res) => {
  const job = queue.get(req.params.jobId)
  if (!job) {
    return res.status(404).json({ error: 'Job not found' })
  }

  res.json(queue.view(job))
})

/**
 * POST /api/render/:jobId/abort
 */
router.post('/:jobId/abort', requireSignIn, (req, res) => {
  const job = queue.get(req.params.jobId)
  if (!job) {
    return res.status(404).json({ error: 'Job not found' })
  }

  if (job.status === 'completed' || job.status === 'failed' || job.status === 'aborted') {
    return res.json({ jobId: job.id, status: job.status, message: 'Job already finished' })
  }

  queue.abort(job.id)

  console.log(`[render] Job ${req.params.jobId} aborted`)
  res.json({ jobId: job.id, status: 'aborted' })
})

/**
 * Process a render job:
 * 1. Download media
 * 2. Run FFmpeg
 * 3. Move output to rendered dir
 */
async function processJob(job, jobDir, signal) {
  const jobId = job.id
  const ac = { signal }

  try {
    // a job started again after a restart begins with a clean folder
    await fs.rm(jobDir, { recursive: true, force: true })
    await fs.mkdir(jobDir, { recursive: true })
    await fs.mkdir(RENDERED_DIR, { recursive: true })

    job.status = 'processing'
    job.phase = 'Downloading media...'
    job.progress = 0.05

    const { timeline } = job

    // Auto captions: the words as WebVTT / SRT next to the video (whether or
    // not they are burnt in), for 3Speak's own captions
    try {
      const subs = await writeSubtitleFiles(timeline, RENDERED_DIR, jobId)
      if (subs) job.subtitles = { language: subs.language, vttUrl: `/rendered/${subs.vtt}`, srtUrl: `/rendered/${subs.srt}`, cues: subs.cues, burnedIn: subs.burnedIn }
    } catch (err) {
      console.warn(`[render] Job ${jobId}: subtitle files failed: ${err.message}`)
    }

    // Nothing changed since an earlier render of this exact timeline
    const audioOnly = timeline.output === 'audio'
    const ext = audioOnly ? '.mp3' : '.mp4'
    const renderKey = sha(JSON.stringify(timeline))
    const cachedOutput = `cache-${renderKey}${ext}`
    try {
      await fs.access(path.join(RENDERED_DIR, cachedOutput))
      await touch(path.join(RENDERED_DIR, cachedOutput))
      console.log(`[render] Job ${jobId}: timeline unchanged, reusing ${cachedOutput}`)
      job.phase = 'Complete (nothing changed)'
      job.progress = 1.0
      job.status = 'completed'
      job.outputUrl = `/rendered/${cachedOutput}`
      job.reused = true
      await fs.rm(jobDir, { recursive: true, force: true })
      return
    } catch {}

    // Collect all clips with URLs
    const allClips = []
    for (const track of timeline.tracks) {
      for (const clip of track.clips) {
        if (clip.url) allClips.push(clip)
      }
    }

    // Download all media (dl.final: every file was the one renders keep using)
    const downloadedFiles = new Map()
    const dl = { final: true }
    for (let i = 0; i < allClips.length; i++) {
      if (ac.signal.aborted) throw new Error('Job aborted')

      const clip = allClips[i]
      job.phase = `Downloading ${clip.name || 'media'} (${i + 1}/${allClips.length})...`
      job.progress = 0.05 + (i / allClips.length) * 0.25

      const localPath = await cachedDownload(clip.url, jobDir, dl)
      downloadedFiles.set(clip.id, localPath)

      // Static-background key: the clean plate image travels as its own file
      // (plus its noise map, which tells the mask how much each spot flickers)
      const isStatic = clip.chromaKey?.color === 'static'
      for (const [field, suffix] of [['plateUrl', 'plate'], ['noiseUrl', 'noise']]) {
        const u = isStatic ? clip.chromaKey[field] : null
        if (!u || typeof u !== 'string' || /^(blob|data):/.test(u)) continue
        try {
          downloadedFiles.set(`${clip.id}__${suffix}`, await cachedDownload(u, jobDir, dl))
        } catch (err) {
          console.warn(`[render] ${suffix} image for ${clip.id} could not be downloaded: ${err.message}`)
        }
      }
    }

    // Background removal (person key): the matte the editor made travels as its own file
    for (const clip of allClips) {
      const u = clip.chromaKey?.color === 'person' ? clip.chromaKey.maskUrl : null
      if (!u || typeof u !== 'string' || /^(blob|data):/.test(u)) continue
      try {
        downloadedFiles.set(`${clip.id}__mask`, await cachedDownload(u, jobDir, dl))
      } catch (err) {
        console.warn(`[render] matte for ${clip.id} could not be downloaded: ${err.message}`)
      }
    }

    // Emoji accents of the captions (sticker images, by URL); a missing one is left out
    for (const { cp, url } of emojiDownloads(timeline)) {
      try {
        downloadedFiles.set(emojiKey(cp), await cachedDownload(url, jobDir, dl))
      } catch (err) {
        console.warn(`[render] emoji ${cp} could not be downloaded: ${err.message}`)
      }
    }

    job.phase = audioOnly ? 'Processing audio...' : 'Processing video...'
    job.progress = 0.3

    // Build and run FFmpeg
    const outputFilename = `${jobId}${ext}`
    const outputPath = path.join(RENDERED_DIR, outputFilename)

    await (audioOnly ? renderAudioTimeline : buildAndRunFFmpeg)({
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

    // Keep it under the timeline's fingerprint too, for an unchanged re-render
    // (not when a source was a stand-in: the next render reads the real one)
    if (dl.final) {
      await fs.copyFile(outputPath, path.join(RENDERED_DIR, `${cachedOutput}.part`))
        .then(() => fs.rename(path.join(RENDERED_DIR, `${cachedOutput}.part`), path.join(RENDERED_DIR, cachedOutput)))
        .catch(err => console.warn(`[render] Render cache write failed: ${err.message}`))
    }

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
  }
}

export { router as renderRouter }

// activeJobs = rendering now, queuedJobs = waiting (the deploy swaps a backend only when both are 0)
export function getRenderStats() {
  return queue.stats()
}

/** Tests: the queue itself. */
export const renderQueue = queue
