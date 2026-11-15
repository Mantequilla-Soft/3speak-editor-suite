import { spawn, execFile } from 'child_process'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { parseWhisperJson } from '../utils/captions.js'

// Speech to text for auto captions: whisper.cpp's CLI, run in the backend's own
// container (the image builds it with a model, see backend/Dockerfile). The
// other STT service the editor knows (VITE_STT_WS_URL, the teleprompter's Vosk
// server) is English only, one stream at a time, and gives no word times, so
// it is not used here.
//   WHISPER_BIN      the whisper-cli binary          (default /opt/whisper/whisper-cli)
//   WHISPER_MODEL    a ggml model file               (default /opt/whisper/ggml-base.bin)
//   WHISPER_THREADS  CPU threads per transcription   (default 2)
//   CAPTIONS_ENABLED false switches auto captions off on this backend
// Without the binary or the model, auto captions report themselves unavailable
// and the editor says so instead of offering the button.
export const sttConfig = () => ({
  bin: process.env.WHISPER_BIN || '/opt/whisper/whisper-cli',
  model: process.env.WHISPER_MODEL || '/opt/whisper/ggml-base.bin',
  threads: Math.max(1, Math.min(8, parseInt(process.env.WHISPER_THREADS, 10) || 2)),
  enabled: process.env.CAPTIONS_ENABLED !== 'false'
})

// The languages whisper knows that the editor offers (plus 'auto')
export const STT_LANGUAGES = ['auto', 'en', 'es', 'pt', 'de', 'fr', 'it', 'nl', 'pl', 'ru', 'uk', 'tr', 'ar', 'hi', 'bn', 'id', 'ja', 'ko', 'zh', 'vi', 'th', 'sv', 'no', 'da', 'fi', 'cs', 'ro', 'hu', 'el', 'he', 'fa', 'ms', 'tl', 'sw']

async function exists(p) {
  try { await fs.access(p); return true } catch { return false }
}

/** { available, reason?, model } for GET /api/captions/status. */
export async function sttStatus() {
  const cfg = sttConfig()
  if (!cfg.enabled) return { available: false, reason: 'disabled' }
  const [bin, model] = await Promise.all([exists(cfg.bin), exists(cfg.model)])
  if (!bin || !model) return { available: false, reason: !bin ? 'no-binary' : 'no-model' }
  return { available: true, model: path.basename(cfg.model).replace(/^ggml-|\.bin$/g, '') }
}

// Can this ffmpeg burn ASS subtitles (libass)? Asked once.
let assFilter = null
export function hasAssFilter() {
  if (!assFilter) {
    assFilter = new Promise((resolve) => {
      execFile('ffmpeg', ['-hide_banner', '-filters'], { maxBuffer: 4 << 20 }, (err, out) => {
        resolve(!err && /^\s*\S+\s+ass\s+V->V/m.test(String(out)))
      })
    })
  }
  return assFilter
}

/**
 * The whisper-cli arguments: one segment per word (-ml 1 -sow), JSON out.
 * `prompt` (optional): text whisper continues from; the transcript uses one
 * full of "um" and "uh" so they are written down instead of tidied away.
 */
export function whisperArgs({ model, threads }, wavPath, outPrefix, language = 'auto', prompt = '') {
  const lang = STT_LANGUAGES.includes(language) ? language : 'auto'
  const args = ['-m', model, '-f', wavPath, '-t', String(threads), '-l', lang, '-ml', '1', '-sow', '-oj', '-of', outPrefix, '-np', '-pp']
  const p = typeof prompt === 'string' ? prompt.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 300) : ''
  return p ? [...args, '--prompt', p] : args
}

/** 16 kHz mono WAV of any audio file (what whisper reads). */
export function toWav(input, output, signal) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-loglevel', 'error', '-y', '-i', input, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', output], { stdio: ['ignore', 'ignore', 'pipe'] })
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
 * Transcribe a 16 kHz WAV: resolves { words: [{ text, start, end }], language }.
 * Runs at low CPU priority; onProgress(0..1) follows whisper's own progress.
 */
export async function transcribeWav(wavPath, { language = 'auto', prompt = '', durationSec = 60, onProgress = () => {}, signal } = {}) {
  const cfg = sttConfig()
  const outPrefix = wavPath.replace(/\.wav$/, '')
  const args = whisperArgs(cfg, wavPath, outPrefix, language, prompt)
  await new Promise((resolve, reject) => {
    const proc = spawn(cfg.bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    try { os.setPriority(proc.pid, 10) } catch { /* not allowed here: normal priority */ }
    let tail = ''
    const onData = (d) => {
      tail = (tail + d).slice(-800)
      const m = [...String(d).matchAll(/progress\s*=\s*(\d+)%/g)].pop()
      if (m) onProgress(Math.min(0.99, Number(m[1]) / 100))
    }
    proc.stdout.on('data', onData)
    proc.stderr.on('data', onData)
    // Generous: the base model runs several times faster than real time on 2 threads
    const timer = setTimeout(() => proc.kill('SIGTERM'), Math.max(120, durationSec * 4) * 1000)
    const stop = () => proc.kill('SIGTERM')
    signal?.addEventListener('abort', stop, { once: true })
    proc.on('error', (err) => { clearTimeout(timer); reject(new Error(`Speech recognition could not start: ${err.message}`)) })
    proc.on('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', stop)
      if (code === 0) resolve()
      else reject(new Error(`Speech recognition failed (exit ${code}): ${tail.trim().split('\n').pop() || ''}`))
    })
  })
  const json = JSON.parse(await fs.readFile(`${outPrefix}.json`, 'utf8'))
  return { words: parseWhisperJson(json), language: json?.result?.language || (language !== 'auto' ? language : null) }
}
