import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import path from 'path'
import fs from 'fs/promises'
import { requireSignIn } from '../auth.js'
import { cachedDownload } from './render.js'
import { renderAudioTimeline, audioTimelineEnd } from '../services/audioRender.js'
import { sttStatus, hasAssFilter, toWav, transcribeWav, STT_LANGUAGES } from '../services/stt.js'

// Auto captions: the spoken words of a Shorts timeline, with their times.
//   GET  /api/captions/status        { available, burnIn, languages, maxSeconds }
//   POST /api/captions/transcribe    { timeline: { tracks }, language } -> { jobId }
//        tracks = the voice tracks (the editor leaves music out), as for an audio render
//   GET  /api/captions/:jobId        { status, progress, phase, words, language, error }
// The timeline's sound is mixed exactly as an audio render mixes it, so the
// word times are timeline times.
const router = Router()
const WORK_DIR = process.env.WORK_DIR || '/app/work'
// Longest timeline transcribed (Shorts are up to 2 minutes; a little room for untrimmed edits)
export const MAX_CAPTION_SECONDS = Math.max(30, parseInt(process.env.CAPTIONS_MAX_SECONDS, 10) || 10 * 60)
// Transcriptions run one at a time (whisper takes WHISPER_THREADS cores); a few may wait
const MAX_WAITING = 4

const jobs = new Map()
let running = 0
const waiting = []

router.get('/status', async (req, res) => {
  res.set('Cache-Control', 'no-store')
  const [stt, burnIn] = await Promise.all([sttStatus(), hasAssFilter()])
  res.json({ ...stt, burnIn, languages: STT_LANGUAGES, maxSeconds: MAX_CAPTION_SECONDS })
})

router.post('/transcribe', requireSignIn, async (req, res) => {
  const stt = await sttStatus()
  if (!stt.available) return res.status(503).json({ error: 'Auto captions are not available on this server', code: 'unavailable' })
  const tracks = Array.isArray(req.body?.timeline?.tracks) ? req.body.timeline.tracks.filter(t => t?.type === 'audio') : []
  const length = audioTimelineEnd(tracks)
  if (!(length > 0)) return res.status(400).json({ error: 'There is no sound to caption: add a clip with speech first' })
  if (length > MAX_CAPTION_SECONDS + 1) return res.status(400).json({ error: `Auto captions work on up to ${Math.round(MAX_CAPTION_SECONDS / 60)} minutes` })
  if (waiting.length >= MAX_WAITING) return res.status(503).json({ error: 'Server busy', retryAfter: 20 })
  const language = STT_LANGUAGES.includes(req.body?.language) ? req.body.language : 'auto'

  const job = { id: uuidv4(), status: 'queued', progress: 0, phase: 'Waiting for a free slot...', words: null, language: null, error: null, length }
  jobs.set(job.id, job)
  const run = () => {
    running++
    transcribeJob(job, tracks, language)
      .catch(err => {
        console.error(`[captions] Job ${job.id} failed:`, err.message)
        job.status = 'failed'
        job.error = err.message
        job.phase = 'Failed'
      })
      .finally(() => {
        running--
        waiting.shift()?.()
        setTimeout(() => jobs.delete(job.id), 60 * 60 * 1000)
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
  const { id, status, progress, phase, words, language, error } = job
  res.json({ jobId: id, status, progress, phase, words, language, error })
})

async function transcribeJob(job, tracks, language) {
  const jobDir = path.join(WORK_DIR, `captions-${job.id}`)
  await fs.mkdir(jobDir, { recursive: true })
  try {
    job.status = 'processing'
    job.phase = 'Fetching the sound...'
    const downloadedFiles = new Map()
    const clips = tracks.flatMap(t => t.clips || []).filter(c => c?.url && typeof c.url === 'string')
    for (const clip of clips) downloadedFiles.set(clip.id, await cachedDownload(clip.url, jobDir))
    job.progress = 0.1

    job.phase = 'Mixing the sound...'
    const mix = path.join(jobDir, 'mix.mp3')
    await renderAudioTimeline({ timeline: { output: 'audio', tracks, master: { loudness: false } }, downloadedFiles, outputPath: mix, jobDir })
    const wav = await toWav(mix, path.join(jobDir, 'speech.wav'))
    job.progress = 0.2

    job.phase = 'Listening...'
    const t0 = Date.now()
    const result = await transcribeWav(wav, {
      language,
      durationSec: job.length,
      onProgress: (p) => { job.progress = 0.2 + p * 0.8 }
    })
    console.log(`[captions] Job ${job.id}: ${result.words.length} words (${result.language || '?'}) from ${job.length.toFixed(1)} s in ${Date.now() - t0} ms`)
    job.words = result.words
    job.language = result.language
    job.progress = 1
    job.phase = result.words.length ? 'Done' : 'No speech found'
    job.status = 'completed'
  } finally {
    await fs.rm(jobDir, { recursive: true, force: true }).catch(() => {})
  }
}

export { router as captionsRouter }
