import { Router } from 'express'
import { spawn, execFile } from 'child_process'
import { v4 as uuidv4 } from 'uuid'
import path from 'path'
import fs from 'fs/promises'
import { requireSignIn } from '../auth.js'
import { downloadMedia } from '../utils/download.js'
import { circleMaps, CIRCLE_WAVES } from '../services/audiogram.js'
import { renderStills } from '../services/audiogramPage.js'
import { imageDataUri } from './audiogram.js'
import { sttStatus, hasAssFilter, toWav, transcribeWav } from '../services/stt.js'
import { cleanVideoPodcastOptions, podcastPageState, podcastAss, podcastSubtitles, videoPodcastArgs, VIDEO_PODCAST_MAX_SECONDS } from '../services/videoPodcast.js'

/**
 * Video podcast jobs (the audio editor's "Video podcast", after an export):
 *   POST /api/video-podcast { url, title, line, style, fps, captions: { on, language, words? }, speakers }
 *     -> { jobId }; url is the exported MP3 (/rendered/<name>.mp3 on this backend,
 *        else fetched like a render's media); words: the episode's own word
 *        timings if the editor has them, else (on: true) speech to text here;
 *        speakers: [{ start, end, name }] (services/videoPodcast.js)
 *   GET  /api/video-podcast/status -> { maxSeconds, captions, burnIn }
 *   GET  /api/video-podcast/:jobId -> { status, progress, phase, outputUrl?, subtitles?, durationSec?, notice?, error? }
 *   POST /api/video-podcast/:jobId/abort
 * One episode at a time (an hour of video takes the CPU for a while), a few wait.
 * The MP4 (and its subtitles) land in the rendered folder (removed by the usual cleanup).
 */
const router = Router()
const RENDERED_DIR = process.env.RENDERED_DIR || '/app/rendered'
const WORK_DIR = process.env.WORK_DIR || '/app/work'
const FONTS_DIR = process.env.CAPTION_FONTS_DIR || '/usr/share/fonts/google'
const MAX_WAITING = 3
const jobs = new Map()
let running = 0
const waiting = []

async function localRendered(url) {
  try {
    const p = new URL(url, 'http://local').pathname
    const m = /^\/rendered\/([A-Za-z0-9_.-]+\.(mp3|m4a|wav))$/.exec(p)
    if (!m) return null
    const file = path.join(RENDERED_DIR, m[1])
    await fs.access(file)
    return file
  } catch {
    return null
  }
}

export function probeDuration(file) {
  return new Promise((resolve) => {
    execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], (err, out) => {
      const d = parseFloat(String(out))
      resolve(!err && Number.isFinite(d) && d > 0 ? d : null)
    })
  })
}

function run(job, args, onTime, timeoutMs) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [...args.slice(0, -1), '-progress', 'pipe:1', '-nostats', args.at(-1)], { stdio: ['ignore', 'pipe', 'pipe'] })
    job.proc = proc
    let tail = ''
    proc.stdout.on('data', d => {
      const m = /out_time_us=(\d+)/.exec(String(d))
      if (m) onTime(+m[1] / 1e6)
    })
    proc.stderr.on('data', d => { tail = (tail + d).slice(-600) })
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('The video podcast took too long')) }, timeoutMs)
    proc.on('close', code => {
      clearTimeout(timer)
      job.proc = null
      if (job.status === 'aborted') reject(new Error('Stopped'))
      else if (code === 0) resolve()
      else reject(new Error(`ffmpeg exit ${code}: ${tail.split('\n').filter(Boolean).pop() || ''}`))
    })
    proc.on('error', err => { clearTimeout(timer); reject(err) })
  })
}

async function process_(job, url) {
  const jobDir = path.join(WORK_DIR, `video-podcast-${job.id}`)
  await fs.mkdir(jobDir, { recursive: true })
  const o = job.options
  const ctrl = new AbortController()
  job.abort = () => ctrl.abort()
  try {
    job.status = 'processing'
    job.phase = 'Getting the episode...'
    const input = (await localRendered(url)) || await downloadMedia(url, 'audio', jobDir)
    const duration = await probeDuration(input)
    if (!duration) throw new Error('The episode could not be read')
    if (duration > VIDEO_PODCAST_MAX_SECONDS + 1) throw new Error(`The episode is ${Math.ceil(duration / 60)} minutes long; a video podcast can be up to ${Math.round(VIDEO_PODCAST_MAX_SECONDS / 3600)} hours`)
    job.durationSec = Math.round(duration * 1000) / 1000

    // The words: the editor's own, else speech to text here (when asked and possible)
    let words = o.captions.words
    let language = o.captions.language === 'auto' ? null : o.captions.language
    const transcribe = o.captions.on && !words.length
    const share = transcribe ? 0.45 : 0
    if (transcribe) {
      const stt = await sttStatus()
      if (!stt.available) {
        job.notice = 'Captions are not available on this server: made without them.'
      } else {
        job.phase = 'Listening for the words...'
        const wav = await toWav(input, path.join(jobDir, 'speech.wav'), ctrl.signal)
        const r = await transcribeWav(wav, { language: o.captions.language, durationSec: duration, signal: ctrl.signal, onProgress: (p) => { job.progress = 0.02 + p * share } })
        words = r.words
        language = r.language || language
        await fs.rm(wav, { force: true }).catch(() => {})
        if (!words.length) job.notice = 'No speech was found for captions.'
      }
    }
    if (job.status === 'aborted') throw new Error('Stopped')

    job.phase = 'Laying it out...'
    const image = await imageDataUri(o.style.background.image)
    const stills = await renderStills({
      state: podcastPageState({ title: o.title, line: o.line, style: o.style, image }),
      belowFile: path.join(jobDir, 'below.png'),
      aboveFile: path.join(jobDir, 'above.png')
    })
    let maps = null
    if (stills.box && CIRCLE_WAVES.includes(o.style.wave.type)) {
      const m = circleMaps(o.style.wave.type, stills.box.w)
      maps = { x: path.join(jobDir, 'xmap.pgm'), y: path.join(jobDir, 'ymap.pgm') }
      await fs.writeFile(maps.x, m.x)
      await fs.writeFile(maps.y, m.y)
    }
    // Captions and speaker names, burnt in by libass
    let ass = null
    const assText = podcastAss({ words, speakers: o.speakers, withCover: !!image, language })
    if (assText) {
      if (await hasAssFilter()) {
        ass = path.join(jobDir, 'podcast.ass')
        await fs.writeFile(ass, assText, 'utf8')
      } else {
        job.notice = 'This server can not draw captions or names: made without them.'
      }
    }
    const fontsDir = await fs.access(FONTS_DIR).then(() => FONTS_DIR, () => null)

    await fs.mkdir(RENDERED_DIR, { recursive: true })
    const name = `video-podcast-${job.id}`
    const part = path.join(RENDERED_DIR, `${name}.part.mp4`)
    job.phase = 'Drawing the video...'
    const base = 0.02 + share
    await run(job, videoPodcastArgs({ input, ...stills, maps, ass, fontsDir, output: part, duration, fps: o.fps, style: o.style }), (t) => {
      job.progress = Math.min(0.99, base + (1 - base) * (t / duration))
    }, Math.max(20 * 60 * 1000, duration * 2500))
    await fs.rename(part, path.join(RENDERED_DIR, `${name}.mp4`))

    // The words as subtitle files next to it, for 3Speak (burnt in already, so CC stays off)
    if (words.length) {
      const subs = podcastSubtitles(words, language)
      await fs.writeFile(path.join(RENDERED_DIR, `${name}.vtt`), subs.vtt, 'utf8')
      await fs.writeFile(path.join(RENDERED_DIR, `${name}.srt`), subs.srt, 'utf8')
      job.subtitles = { language, vttUrl: `/rendered/${name}.vtt`, srtUrl: `/rendered/${name}.srt`, cues: subs.cues.slice(0, 5000), burnedIn: !!ass }
    }
    Object.assign(job, { status: 'completed', progress: 1, phase: 'Complete', outputUrl: `/rendered/${name}.mp4` })
    console.log(`[video-podcast] ${job.id}: ${Math.round(duration)}s at ${o.fps} fps, ${words.length} words, ${o.speakers.length} speaker turns -> ${name}.mp4`)
  } catch (err) {
    if (job.status !== 'aborted') Object.assign(job, { status: 'failed', phase: 'Failed', error: err.message })
    console.warn(`[video-podcast] ${job.id} ${job.status}: ${err.message}`)
    fs.rm(path.join(RENDERED_DIR, `video-podcast-${job.id}.part.mp4`), { force: true }).catch(() => {})
  } finally {
    job.abort = null
    fs.rm(jobDir, { recursive: true, force: true }).catch(() => {})
    setTimeout(() => jobs.delete(job.id), 3 * 60 * 60 * 1000).unref?.()
  }
}

router.get('/status', async (req, res) => {
  res.set('Cache-Control', 'no-store')
  const [stt, burnIn] = await Promise.all([sttStatus(), hasAssFilter()])
  res.json({ maxSeconds: VIDEO_PODCAST_MAX_SECONDS, captions: !!stt.available, burnIn })
})

router.post('/', requireSignIn, (req, res) => {
  const url = req.body?.url
  if (typeof url !== 'string' || !url || url.length > 2000) return res.status(400).json({ error: 'url required' })
  if (waiting.length >= MAX_WAITING) return res.status(503).json({ error: 'Server busy', retryAfter: 60 })
  const options = cleanVideoPodcastOptions(req.body)
  const job = { id: uuidv4(), status: 'queued', progress: 0, phase: 'Waiting for a free slot...', options, proc: null, abort: null }
  jobs.set(job.id, job)
  const start = () => {
    if (job.status === 'aborted') { waiting.shift()?.(); return } // stopped while it waited
    running++
    process_(job, url).finally(() => {
      running--
      waiting.shift()?.()
    })
  }
  start.jobId = job.id
  if (running < 1) start()
  else waiting.push(start)
  res.json({ jobId: job.id })
})

router.get('/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId)
  if (!job) return res.status(404).json({ error: 'Job not found' })
  res.set('Cache-Control', 'no-store')
  const { status, progress, phase, outputUrl, subtitles, durationSec, notice, error } = job
  res.json({ status, progress, phase, ...(outputUrl ? { outputUrl } : {}), ...(subtitles ? { subtitles } : {}), ...(durationSec ? { durationSec } : {}), ...(notice ? { notice } : {}), ...(error ? { error } : {}) })
})

router.post('/:jobId/abort', requireSignIn, (req, res) => {
  const job = jobs.get(req.params.jobId)
  if (!job) return res.status(404).json({ error: 'Job not found' })
  if (job.status === 'completed' || job.status === 'failed') return res.json({ status: job.status })
  const wasQueued = job.status === 'queued'
  job.status = 'aborted'
  job.phase = 'Stopped'
  job.abort?.()
  job.proc?.kill('SIGKILL')
  if (wasQueued) {
    // never started: take it out of the line
    const i = waiting.findIndex(fn => fn.jobId === job.id)
    if (i >= 0) waiting.splice(i, 1)
  }
  res.json({ status: 'aborted' })
})

export { router as videoPodcastRouter }
