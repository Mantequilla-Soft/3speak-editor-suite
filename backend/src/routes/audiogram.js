import { Router } from 'express'
import { spawn } from 'child_process'
import { v4 as uuidv4 } from 'uuid'
import path from 'path'
import fs from 'fs/promises'
import dns from 'dns/promises'
import { requireSignIn } from '../auth.js'
import { downloadMedia } from '../utils/download.js'
import { audiogramArgs, cleanAudiogramOptions, cleanAudiogramStyle, pageState, uploadPathOf, circleMaps, CIRCLE_WAVES, AUDIOGRAM_MAX_SECONDS } from '../services/audiogram.js'
import { audiogramPageHtml, renderStills, defaultLayers, SIZES } from '../services/audiogramPage.js'
import { privateAddress } from '../utils/privateAddress.js'

/**
 * Audiogram jobs (the audio editor's Audiograms, after an export):
 *   POST /api/audiogram { url, start, duration, format, title, style }
 *     -> { jobId }; url is the exported MP3 (/rendered/<name>.mp3 on this
 *        backend, else fetched like a render's media); style is the look and
 *        the arrangement (services/audiogram.js cleanAudiogramStyle)
 *   GET /api/audiogram/page -> the page the editor shows as its live preview
 *   GET /api/audiogram/defaults -> { style, coverLayouts, maxSeconds }: the first look
 *       (no template yet), and the arrangement with a cover for when a picture comes in
 *   GET /api/audiogram/:jobId -> { status, progress, outputUrl? , error? }
 * The MP4 lands in the rendered folder (removed by the usual cleanup).
 */
const router = Router()
const RENDERED_DIR = process.env.RENDERED_DIR || '/app/rendered'
const WORK_DIR = process.env.WORK_DIR || '/app/work'
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/app/uploads'
const MAX_RUNNING = 2
const IMAGE_MAX_BYTES = 10 * 1024 * 1024
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

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif' }

/**
 * The picture as a data: URI (the page loads nothing itself): one of our
 * uploads from the disk, else an https picture on a public host. null when it
 * can't be had (the audiogram is made without it).
 */
export async function imageDataUri(url) {
  if (!url) return null
  const own = uploadPathOf(url)
  if (own) {
    const name = path.basename(own)
    try {
      const buf = await fs.readFile(path.join(UPLOAD_DIR, name))
      const type = MIME[path.extname(name).toLowerCase()]
      if (type && buf.length <= IMAGE_MAX_BYTES) return `data:${type};base64,${buf.toString('base64')}`
    } catch {}
    // not on this backend's disk: fetch it like any other picture (the other backend)
  }
  let u
  try { u = new URL(url) } catch { return null }
  if (u.protocol !== 'https:') return null
  const addrs = await dns.lookup(u.hostname, { all: true }).catch(() => [])
  if (!addrs.length || addrs.some(a => privateAddress(a.address))) return null
  const res = await fetch(u, { redirect: 'error', signal: AbortSignal.timeout(15000) }).catch(() => null)
  if (!res?.ok) return null
  const type = (res.headers.get('content-type') || '').split(';')[0].trim()
  if (!/^image\/(png|jpeg|webp|gif|avif)$/.test(type)) return null
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > IMAGE_MAX_BYTES) return null
  return `data:${type};base64,${buf.toString('base64')}`
}

function run(args, onTime, timeoutMs = 8 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [...args.slice(0, -1), '-progress', 'pipe:1', '-nostats', args.at(-1)], { stdio: ['ignore', 'pipe', 'pipe'] })
    let tail = ''
    proc.stdout.on('data', d => {
      const m = /out_time_us=(\d+)/.exec(String(d))
      if (m) onTime(+m[1] / 1e6)
    })
    proc.stderr.on('data', d => { tail = (tail + d).slice(-600) })
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('Audiogram timed out')) }, timeoutMs)
    proc.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${tail.split('\n').filter(Boolean).pop() || ''}`)) })
    proc.on('error', err => { clearTimeout(timer); reject(err) })
  })
}

async function process_(job, { url }) {
  const jobDir = path.join(WORK_DIR, `audiogram-${job.id}`)
  await fs.mkdir(jobDir, { recursive: true })
  const o = job.options
  try {
    job.phase = 'Getting the audio...'
    const input = (await localRendered(url)) || await downloadMedia(url, 'audio', jobDir)
    job.phase = 'Laying it out...'
    const image = await imageDataUri(o.style.background.image)
    const stills = await renderStills({
      state: pageState({ format: o.format, title: o.title, style: o.style, image }),
      belowFile: path.join(jobDir, 'below.png'),
      aboveFile: path.join(jobDir, 'above.png')
    })
    // a round waveform: the maps that bend its strip into the circle
    let maps = null
    if (stills.box && CIRCLE_WAVES.includes(o.style.wave.type)) {
      const m = circleMaps(o.style.wave.type, stills.box.w)
      maps = { x: path.join(jobDir, 'xmap.pgm'), y: path.join(jobDir, 'ymap.pgm') }
      await fs.writeFile(maps.x, m.x)
      await fs.writeFile(maps.y, m.y)
    }
    await fs.mkdir(RENDERED_DIR, { recursive: true })
    const name = `audiogram-${job.id}.mp4`
    const part = path.join(RENDERED_DIR, `${name}.part.mp4`)
    job.phase = 'Drawing the audiogram...'
    await run(audiogramArgs({ input, ...stills, maps, output: part, start: o.start, duration: o.duration, style: o.style }), (t) => {
      job.progress = Math.min(0.99, t / o.duration)
    })
    await fs.rename(part, path.join(RENDERED_DIR, name))
    Object.assign(job, { status: 'completed', progress: 1, phase: 'Complete', outputUrl: `/rendered/${name}` })
    console.log(`[audiogram] ${job.id}: ${o.format} ${o.duration}s${image ? ' with picture' : ''} -> ${name}`)
  } catch (err) {
    Object.assign(job, { status: 'failed', phase: 'Failed', error: err.message })
    console.warn(`[audiogram] ${job.id} failed: ${err.message}`)
  } finally {
    running--
    fs.rm(jobDir, { recursive: true, force: true }).catch(() => {})
    setTimeout(() => jobs.delete(job.id), 60 * 60 * 1000).unref?.()
  }
}

// The live preview page (same drawing as the video; state by postMessage)
let previewPage = null
router.get('/page', (req, res) => {
  previewPage ||= audiogramPageHtml({ preview: true })
  res.set('Cache-Control', 'public, max-age=300')
  res.type('html').send(previewPage)
})

router.get('/defaults', (req, res) => {
  res.json({
    style: cleanAudiogramStyle({}),
    coverLayouts: Object.fromEntries(Object.keys(SIZES).map(f => [f, defaultLayers(f, true)])),
    maxSeconds: AUDIOGRAM_MAX_SECONDS
  })
})

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
  process_(job, { url })
  res.json({ jobId: id })
})

router.get('/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId)
  if (!job) return res.status(404).json({ error: 'Job not found' })
  const { status, progress, phase, outputUrl, error } = job
  res.json({ status, progress, phase, ...(outputUrl ? { outputUrl } : {}), ...(error ? { error } : {}) })
})

export { router as audiogramRouter }
