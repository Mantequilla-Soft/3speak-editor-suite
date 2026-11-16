import { spawn } from 'child_process'
import path from 'path'
import fs from 'fs/promises'
import { transcribeWav, STT_LANGUAGES } from './stt.js'
import { verbatimPrompt } from '../utils/verbatimPrompts.js'

// The transcript of a show: the words of each recording (a "source": one
// uploaded file) with their times IN THAT FILE, so the editor can pin them to
// the recording and they follow every cut. Long recordings are listened to in
// chunks (CHUNK_SECONDS, with a little overlap so no word is lost at a seam);
// each finished chunk is handed out at once, so the editor shows the words
// while the rest is still being transcribed.

// TRANSCRIPT_CHUNK_SECONDS: longer chunks need more memory per whisper run, shorter ones lose a little context
export const CHUNK_SECONDS = Math.max(60, parseInt(process.env.TRANSCRIPT_CHUNK_SECONDS, 10) || 300)
export const OVERLAP_SECONDS = 2
const SAMPLE_SECONDS = 30 // listened to first to know the language ('auto')
const MAX_SOURCES = 16
const MAX_RANGES = 400
const ID = /^[A-Za-z0-9_.:-]{1,100}$/

const round3 = (t) => Math.round(t * 1000) / 1000

/** Ranges [[from, to]] seconds, cleaned, sorted and joined where they touch (within `join` s). */
export function mergeRanges(ranges, join = 0.5) {
  const list = (Array.isArray(ranges) ? ranges : [])
    .map(r => (Array.isArray(r) ? [Number(r[0]), Number(r[1])] : [NaN, NaN]))
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a && b > 0)
    .map(([a, b]) => [Math.max(0, a), b])
    .sort((x, y) => x[0] - y[0])
  const out = []
  for (const [a, b] of list) {
    const last = out[out.length - 1]
    if (last && a <= last[1] + join) last[1] = Math.max(last[1], b)
    else out.push([a, b])
  }
  return out.map(([a, b]) => [round3(a), round3(b)])
}

/**
 * The request's sources, checked: [{ id, url, ranges }] (ranges merged), or
 * { error }. `maxSeconds`: the most audio one job listens to.
 */
export function cleanSources(body, maxSeconds) {
  const raw = Array.isArray(body?.sources) ? body.sources : []
  if (!raw.length) return { error: 'Nothing to transcribe: add a recording first' }
  if (raw.length > MAX_SOURCES) return { error: `At most ${MAX_SOURCES} recordings at a time` }
  const sources = []
  for (const s of raw) {
    if (!s || typeof s !== 'object' || !ID.test(String(s.id || ''))) return { error: 'Each recording needs an id' }
    if (typeof s.url !== 'string' || !s.url || s.url.length > 2000) return { error: 'Each recording needs a url' }
    const ranges = mergeRanges(s.ranges).slice(0, MAX_RANGES)
    if (!ranges.length) continue
    sources.push({ id: s.id, url: s.url, ranges })
  }
  if (!sources.length) return { error: 'Nothing to transcribe: the recordings have no length' }
  const total = sources.reduce((n, s) => n + s.ranges.reduce((m, [a, b]) => m + (b - a), 0), 0)
  if (total > maxSeconds + 1) return { error: `A transcript listens to up to ${Math.round(maxSeconds / 3600 * 10) / 10} hours at a time` }
  return { sources, total }
}

/**
 * The chunks a range is listened to in: [{ from, to, keepFrom, keepTo }].
 * Equal pieces of at most `chunk` seconds; each is read `overlap` seconds
 * longer on both sides (inside the range), and keeps the words whose middle
 * falls in its own piece, so a word on a seam is kept exactly once.
 */
export function planChunks([a, b], chunk = CHUNK_SECONDS, overlap = OVERLAP_SECONDS) {
  const n = Math.max(1, Math.ceil((b - a) / chunk - 1e-9))
  const len = (b - a) / n
  const out = []
  for (let i = 0; i < n; i++) {
    const keepFrom = a + i * len
    const keepTo = i === n - 1 ? b : a + (i + 1) * len
    out.push({ from: round3(Math.max(a, keepFrom - overlap)), to: round3(Math.min(b, keepTo + overlap)), keepFrom: round3(keepFrom), keepTo: round3(keepTo) })
  }
  return out
}

/** The words of a chunk that are its own (middle inside [keepFrom, keepTo); the range's last chunk keeps its end). */
export function ownWords(words, { keepFrom, keepTo }, last = false) {
  return (words || []).filter(w => {
    const mid = (w.start + w.end) / 2
    return mid >= keepFrom && (mid < keepTo || (last && mid <= keepTo + 0.5))
  })
}

/** A piece of a file as 16 kHz mono WAV (what whisper reads). */
export function extractWav(input, output, from, duration, signal) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-loglevel', 'error', '-y', '-ss', String(from), '-t', String(duration), '-i', input, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', output], { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    proc.stderr.on('data', d => { err = (err + d).slice(-500) })
    const stop = () => proc.kill('SIGTERM')
    signal?.addEventListener('abort', stop, { once: true })
    proc.on('error', reject)
    proc.on('close', code => {
      signal?.removeEventListener('abort', stop)
      code === 0 ? resolve(output) : reject(new Error(`Could not read the audio (${err.trim().split('\n').pop() || code})`))
    })
  })
}

/**
 * Runs a transcript job: job = { id, sources, total, language ('auto' or a
 * code), verbatim, chunks: [], ... }. Each finished chunk is pushed to
 * job.chunks as { source, from, to, words } (words in the source's seconds).
 * fetchSource(url) -> a local file path. Throws on failure (job.chunks keeps
 * what was done).
 */
export async function runTranscriptJob(job, { fetchSource, workDir, signal, transcribe = transcribeWav, extract = extractWav }) {
  const jobDir = path.join(workDir, `transcript-${job.id}`)
  await fs.mkdir(jobDir, { recursive: true })
  let done = 0
  const aborted = () => { if (signal?.aborted) throw new Error('Cancelled') }
  try {
    job.status = 'processing'
    let language = STT_LANGUAGES.includes(job.language) && job.language !== 'auto' ? job.language : null
    let n = 0
    for (const source of job.sources) {
      aborted()
      job.phase = 'Fetching the recording...'
      const input = await fetchSource(source.url, jobDir)
      // 'auto': a short piece first, so every chunk is read in the same language (and with its prompt)
      if (!language) {
        job.phase = 'Finding the language...'
        const [a, b] = source.ranges[0]
        const from = Math.max(a, Math.min(a + 30, b - SAMPLE_SECONDS))
        const wav = await extract(input, path.join(jobDir, 'sample.wav'), from, Math.min(SAMPLE_SECONDS, b - from), signal)
        const r = await transcribe(wav, { language: 'auto', durationSec: SAMPLE_SECONDS, signal })
        language = STT_LANGUAGES.includes(r.language) && r.language !== 'auto' ? r.language : 'auto'
        job.language = language === 'auto' ? null : language
      }
      const prompt = job.verbatim ? verbatimPrompt(language) : ''
      for (const range of source.ranges) {
        const plan = planChunks(range)
        for (let i = 0; i < plan.length; i++) {
          aborted()
          const c = plan[i]
          job.phase = `Listening... (${formatTime(done)} of ${formatTime(job.total)})`
          const wav = await extract(input, path.join(jobDir, `chunk-${n++}.wav`), c.from, c.to - c.from, signal)
          const base = done
          const r = await transcribe(wav, {
            language,
            prompt,
            durationSec: c.to - c.from,
            signal,
            onProgress: (p) => { job.progress = Math.min(0.99, (base + p * (c.keepTo - c.keepFrom)) / job.total) }
          })
          await fs.rm(wav, { force: true }).catch(() => {})
          const words = ownWords(r.words.map(w => ({ ...w, start: round3(w.start + c.from), end: round3(w.end + c.from) })), c, i === plan.length - 1)
          job.chunks.push({ source: source.id, from: c.keepFrom, to: c.keepTo, words })
          done += c.keepTo - c.keepFrom
          job.progress = Math.min(0.99, done / job.total)
        }
      }
    }
    job.progress = 1
    job.phase = 'Done'
    job.status = 'completed'
  } finally {
    await fs.rm(jobDir, { recursive: true, force: true }).catch(() => {})
  }
}

function formatTime(sec) {
  const s = Math.max(0, Math.round(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`
}
