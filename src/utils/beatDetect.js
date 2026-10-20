// Beat detection for "Beat sync": plain signal processing, no AI.
//   onsets  how sharply the energy rises every 10 ms (full band + bass band,
//           so kicks count double)
//   tempo   autocorrelation of the onsets, between 60 and 200 BPM, leaning
//           towards the 80-160 BPM most music sits in
//   phase   where a grid of that tempo lines up with the most onsets; each
//           beat is then nudged onto the nearest onset peak
// Assumes a steady tempo (true for nearly all library / produced music).

import { MAX_ANALYSE_BYTES } from './limits'

const SAMPLE_RATE = 11025
const HOP = 0.01 // seconds per onset frame

export function detectBeatsFromSamples(samples, sampleRate, hintBpm = 0) {
  const hop = Math.round(sampleRate * HOP)
  const frames = Math.floor(samples.length / hop) - 1
  if (frames < 300) return null // under ~3 s: too short for a tempo

  // Energy per frame, full band and a ~150 Hz low-pass (kick / bass)
  const a = 1 - Math.exp((-2 * Math.PI * 150) / sampleRate)
  let low = 0
  const eFull = new Float32Array(frames)
  const eLow = new Float32Array(frames)
  for (let f = 0; f < frames; f++) {
    let sf = 0, sl = 0
    for (let i = f * hop; i < (f + 2) * hop; i++) {
      const x = samples[i]
      low += a * (x - low)
      sf += x * x
      sl += low * low
    }
    eFull[f] = Math.log(1e-9 + sf)
    eLow[f] = Math.log(1e-9 + sl)
  }

  // Onset strength: rises only, minus the local average
  const raw = new Float32Array(frames)
  for (let f = 1; f < frames; f++) {
    raw[f] = Math.max(0, eFull[f] - eFull[f - 1]) + Math.max(0, eLow[f] - eLow[f - 1])
  }
  const onset = new Float32Array(frames)
  const half = 25 // 0.25 s each side
  let sum = 0
  for (let f = 0; f < Math.min(frames, half); f++) sum += raw[f]
  for (let f = 0; f < frames; f++) {
    if (f + half < frames) sum += raw[f + half]
    if (f - half - 1 >= 0) sum -= raw[f - half - 1]
    const n = Math.min(frames, f + half + 1) - Math.max(0, f - half)
    onset[f] = Math.max(0, raw[f] - sum / n)
  }

  // Tempo: autocorrelation over 0.3 .. 1.0 s, weighted towards ~120 BPM.
  // A real beat period also lines up at twice its length, a misread (e.g. a
  // triplet feel) does not: each lag also scores half of its double.
  // `hintBpm` (a library song's known tempo) skips the search.
  const minLag = Math.round(0.3 / HOP)
  const maxLag = Math.round(1.0 / HOP)
  const acf = new Float32Array(2 * maxLag + 3)
  for (let lag = minLag; lag < acf.length; lag++) {
    let r = 0
    for (let f = 0; f + lag < frames; f++) r += onset[f] * onset[f + lag]
    acf[lag] = r / Math.max(1, frames - lag)
  }
  const scores = new Float32Array(maxLag + 2)
  let bestLag = minLag
  for (let lag = minLag; lag <= maxLag + 1; lag++) {
    const w = Math.exp(-0.5 * Math.pow(Math.log2((lag * HOP) / 0.5) / 0.9, 2))
    scores[lag] = (acf[lag] + 0.5 * acf[2 * lag]) * w
    if (lag <= maxLag && scores[lag] > scores[bestLag]) bestLag = lag
  }
  // Sub-frame tempo (parabola through the peak)
  const l = scores[bestLag - 1] || 0, c = scores[bestLag], rr = scores[bestLag + 1] || 0
  const shift = l - 2 * c + rr !== 0 ? (0.5 * (l - rr)) / (l - 2 * c + rr) : 0
  let period = (bestLag + Math.max(-0.5, Math.min(0.5, shift))) * HOP
  if (hintBpm > 0) {
    // Fold a known tempo into the 60-200 BPM search range, then trust it
    let p = 60 / hintBpm
    while (p < 0.3) p *= 2
    while (p > 1.0) p /= 2
    period = p
  }

  // Phase: the grid offset that hits the most onset
  const periodFrames = period / HOP
  let bestPhase = 0, bestPhaseScore = -1
  for (let phase = 0; phase < periodFrames; phase++) {
    let s = 0
    for (let t = phase; t < frames; t += periodFrames) s += onset[Math.round(t)] || 0
    if (s > bestPhaseScore) { bestPhaseScore = s; bestPhase = phase }
  }

  // Beats on that grid, each nudged onto the strongest onset within 40 ms
  const beats = []
  for (let t = bestPhase; t < frames; t += periodFrames) {
    const centre = Math.round(t)
    let best = centre
    for (let f = Math.max(0, centre - 4); f <= Math.min(frames - 1, centre + 4); f++) {
      if (onset[f] > onset[best]) best = f
    }
    beats.push(Number((best * HOP).toFixed(3)))
  }
  return { bpm: Number((60 / period).toFixed(1)), period, beats }
}

/**
 * Timeline seconds of the beats of every audio clip that shows its beats
 * (clip.showBeats, clip.beats.times in media seconds, as Beat sync stores them).
 */
export function timelineBeats(tracks) {
  const out = []
  for (const track of tracks || []) {
    for (const clip of track.clips) {
      if (!clip.showBeats || !clip.beats?.times) continue
      const pos = clip.timelinePosition || 0
      for (const b of clip.beats.times) {
        if (b >= clip.startTime && b < clip.endTime) out.push(pos + (b - clip.startTime))
      }
    }
  }
  return out.sort((a, b) => a - b)
}

/** Decode a File/Blob or URL and detect its beats (media seconds). */
export async function detectBeats(source, { signal, hintBpm = 0 } = {}) {
  let buffer
  if (source instanceof Blob) {
    if (source.size > MAX_ANALYSE_BYTES) throw new Error('too-large')
    buffer = await source.arrayBuffer()
  } else {
    const res = await fetch(source, { signal })
    if (Number(res.headers.get('content-length') || 0) > MAX_ANALYSE_BYTES) {
      res.body?.cancel()
      throw new Error('too-large')
    }
    buffer = await res.arrayBuffer()
  }
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
  const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext
  const ctx = new Offline(1, SAMPLE_RATE, SAMPLE_RATE)
  const audio = await new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(buffer, resolve, reject)
    if (p && p.then) p.then(resolve, reject)
  })
  // Mono mix
  const mono = new Float32Array(audio.length)
  for (let ch = 0; ch < audio.numberOfChannels; ch++) {
    const d = audio.getChannelData(ch)
    for (let i = 0; i < d.length; i++) mono[i] += d[i] / audio.numberOfChannels
  }
  return detectBeatsFromSamples(mono, audio.sampleRate, hintBpm)
}
