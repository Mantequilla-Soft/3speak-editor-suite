// Timeline waveforms: each media file is decoded ONCE, at 8 kHz mono, into a
// peak per 10 ms, and every clip (and Auto cut part) of that file reads its
// own range from it. Decoding a whole file at full rate per clip width (what
// the timeline used to do on every trim/zoom step) piled up hundreds of MB.
// Decodes run one at a time; a handful of files stay cached.

import { MAX_ANALYSE_BYTES } from './limits'

const SAMPLE_RATE = 8000
const STEP = 0.01 // seconds per peak
const MAX_FILES = 12

const cache = new Map() // url -> { peaks: Float32Array, step } | null (undecodable)
const inflight = new Map() // url -> Promise
let queue = Promise.resolve()

async function decodePeaks(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(String(res.status))
  // Too big to decode in the browser: placeholder bars instead of a crash
  if (Number(res.headers.get('content-length') || 0) > MAX_ANALYSE_BYTES) {
    res.body?.cancel()
    return null
  }
  const buffer = await res.arrayBuffer()
  const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext
  const ctx = new Offline(1, SAMPLE_RATE, SAMPLE_RATE)
  const audio = await new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(buffer, resolve, reject)
    if (p && p.then) p.then(resolve, reject)
  })
  const per = Math.max(1, Math.round(audio.sampleRate * STEP))
  const count = Math.ceil(audio.length / per)
  const peaks = new Float32Array(count)
  for (let ch = 0; ch < audio.numberOfChannels; ch++) {
    const d = audio.getChannelData(ch)
    for (let i = 0; i < count; i++) {
      let max = peaks[i]
      for (let j = i * per, end = Math.min(d.length, (i + 1) * per); j < end; j++) {
        const v = d[j] < 0 ? -d[j] : d[j]
        if (v > max) max = v
      }
      peaks[i] = max
    }
  }
  return { peaks, step: per / audio.sampleRate }
}

/** Peaks of a file (decoded once, shared); null when it cannot be decoded. */
export function getPeaks(url) {
  if (cache.has(url)) {
    const hit = cache.get(url)
    cache.delete(url)
    cache.set(url, hit) // most recently used last
    return Promise.resolve(hit)
  }
  if (inflight.has(url)) return inflight.get(url)
  const job = queue.then(() => decodePeaks(url)).catch(() => null).then(result => {
    inflight.delete(url)
    cache.set(url, result)
    while (cache.size > MAX_FILES) cache.delete(cache.keys().next().value)
    return result
  })
  queue = job
  inflight.set(url, job)
  return job
}

/** `bars` heights (10-90, like the timeline draws them) for media time [from, to]. */
export function peaksForRange(env, from, to, bars) {
  if (!env) return null
  const { peaks, step } = env
  const out = new Array(bars)
  const span = Math.max(step, to - from)
  for (let b = 0; b < bars; b++) {
    const a = Math.floor((from + (b / bars) * span) / step)
    const z = Math.max(a + 1, Math.floor((from + ((b + 1) / bars) * span) / step))
    let max = 0
    for (let i = Math.max(0, a); i < Math.min(peaks.length, z); i++) if (peaks[i] > max) max = peaks[i]
    out[b] = 10 + Math.min(1, max) * 80
  }
  return out
}
