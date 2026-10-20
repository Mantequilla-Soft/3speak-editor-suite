// Silence detection for "Auto cut": plain loudness measurement, no AI.
// The clip's audio is decoded once at a low sample rate, turned into a loudness
// curve (dB per short window), and cut points are found on that curve, so the
// sliders in the popup update the preview instantly.

const SAMPLE_RATE = 8000 // plenty for loudness, keeps long clips light on memory
const WINDOW_SEC = 0.02 // 20 ms loudness windows
const FLOOR_DB = -90

// Anything bigger is not read into the browser at once
import { MAX_ANALYSE_BYTES } from './limits'

export const MAX_SOURCE_BYTES = MAX_ANALYSE_BYTES

/**
 * Decode a File/Blob or URL and return its loudness curve:
 * { db: Float32Array (one value per window), step: seconds per window, duration }
 */
export async function loadLoudness(source, { signal } = {}) {
  let buffer
  if (source instanceof Blob) {
    if (source.size > MAX_SOURCE_BYTES) throw new Error('too-large')
    buffer = await source.arrayBuffer()
  } else {
    const res = await fetch(source, { signal })
    if (!res.ok) throw new Error(`fetch ${res.status}`)
    if (Number(res.headers.get('content-length') || 0) > MAX_SOURCE_BYTES) {
      res.body?.cancel()
      throw new Error('too-large')
    }
    buffer = await res.arrayBuffer()
  }
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError')

  const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext
  const ctx = new Offline(1, SAMPLE_RATE, SAMPLE_RATE)
  const audio = await new Promise((resolve, reject) => {
    // Callback form for older Safari; promise form everywhere else
    const p = ctx.decodeAudioData(buffer, resolve, reject)
    if (p && p.then) p.then(resolve, reject)
  })

  const channels = []
  for (let c = 0; c < audio.numberOfChannels; c++) channels.push(audio.getChannelData(c))
  const perWindow = Math.max(1, Math.round(audio.sampleRate * WINDOW_SEC))
  const count = Math.ceil(audio.length / perWindow)
  const db = new Float32Array(count)
  for (let w = 0; w < count; w++) {
    const from = w * perWindow
    const to = Math.min(from + perWindow, audio.length)
    let sum = 0
    for (let i = from; i < to; i++) {
      let v = 0
      for (const ch of channels) v += ch[i]
      v /= channels.length
      sum += v * v
    }
    const rms = Math.sqrt(sum / Math.max(1, to - from))
    db[w] = rms > 0 ? Math.max(FLOOR_DB, 20 * Math.log10(rms)) : FLOOR_DB
  }
  return { db, step: perWindow / audio.sampleRate, duration: audio.duration }
}

/**
 * Suggest a silence threshold: a little above the room's noise floor
 * (the quietest tenth of the clip), within sensible bounds.
 */
export function suggestThreshold(loudness, from, to) {
  const { db, step } = loudness
  const a = Math.max(0, Math.floor(from / step))
  const b = Math.min(db.length, Math.ceil(to / step))
  const slice = Array.from(db.subarray(a, b)).sort((x, y) => x - y)
  if (!slice.length) return -40
  const floor = slice[Math.floor(slice.length * 0.1)]
  return Math.round(Math.min(-20, Math.max(-70, floor + 10)))
}

/**
 * Find the pauses between `from` and `to` (seconds in the source media) and
 * turn them into the parts to keep, also in source media seconds.
 *
 * mode 'split':  splits at pauses into parts of at least minPart seconds and
 *                cuts the pause at each split out; shorter pauses inside a
 *                part stay. Silence at the very start and end is trimmed.
 * mode 'remove': parts are what is said; every pause is cut out.
 * Either way keepStartMs of a removed pause stays after the words before it
 * and keepEndMs before the words after it, so words are not clipped.
 *
 * Returns { silences: [{start,end}], parts: [{start,end}] }.
 */
export function planCuts(loudness, { from, to, thresholdDb, minSilence, minPart, keepStartMs, keepEndMs, mode }) {
  // Seconds of each removed pause that stay: after the words before it, and before the words after it
  const padStart = (keepStartMs ?? 150) / 1000
  const padEnd = (keepEndMs ?? 150) / 1000
  const { db, step } = loudness
  const a = Math.max(0, Math.floor(from / step))
  const b = Math.min(db.length, Math.ceil(to / step))

  const silences = []
  let runStart = -1
  for (let w = a; w <= b; w++) {
    const quiet = w < b && db[w] < thresholdDb
    if (quiet && runStart < 0) runStart = w
    if (!quiet && runStart >= 0) {
      const start = Math.max(from, runStart * step)
      const end = Math.min(to, w * step)
      if (end - start >= minSilence) silences.push({ start, end })
      runStart = -1
    }
  }

  const parts = []
  if (mode === 'remove') {
    let cursor = from
    for (const s of silences) {
      // Leading/trailing silence of the clip is cut right up to the clip's edge
      const cutFrom = s.start <= from + 0.001 ? from : s.start + padStart
      const cutTo = s.end >= to - 0.001 ? to : s.end - padEnd
      if (cutTo - cutFrom < 0.05) continue
      if (cutFrom - cursor > 0.05) parts.push({ start: cursor, end: cutFrom })
      cursor = cutTo
    }
    if (to - cursor > 0.05) parts.push({ start: cursor, end: to })
  } else {
    // Choose the pauses to split at (by their middle), keeping parts >= minPart
    const chosen = []
    let last = from
    for (const s of silences) {
      if (s.start <= from + 0.001 || s.end >= to - 0.001) continue
      const mid = (s.start + s.end) / 2
      if (mid - last >= minPart) {
        chosen.push(s)
        last = mid
      }
    }
    // The last part must also be long enough: drop the final split if not
    while (chosen.length && to - (chosen[chosen.length - 1].start + chosen[chosen.length - 1].end) / 2 < minPart) chosen.pop()

    const lead = silences.find(s => s.start <= from + 0.001)
    const trail = silences.find(s => s.end >= to - 0.001)
    let start = lead ? Math.max(from, lead.end - padEnd) : from
    const end = trail ? Math.min(to, trail.start + padStart) : to
    for (const s of chosen) {
      const mid = (s.start + s.end) / 2
      parts.push({ start, end: Math.min(s.start + padStart, mid) })
      start = Math.max(s.end - padEnd, mid)
    }
    if (end - start > 0.05) parts.push({ start, end })
  }

  return { silences, parts }
}

/**
 * Scene-change cuts: split [from, to] where the picture changes, i.e. frames
 * whose scene score (from the backend, POST /api/clip/scenes) is threshold or
 * more (hard cuts score ~20-40), keeping parts >= minPart. Nothing is removed.
 * Returns { silences: [], cuts: [seconds], parts }.
 */
export function planSceneCuts(scores, { from, to, threshold, minPart }) {
  const cuts = []
  let last = from
  for (const [t, score] of scores) {
    if (score < threshold || t <= from + 0.05 || t >= to - 0.05) continue
    if (t - last >= minPart) {
      cuts.push(t)
      last = t
    }
  }
  while (cuts.length && to - cuts[cuts.length - 1] < minPart) cuts.pop()
  const parts = []
  let start = from
  for (const t of cuts) {
    parts.push({ start, end: t })
    start = t
  }
  parts.push({ start, end: to })
  return { silences: [], cuts, parts }
}
