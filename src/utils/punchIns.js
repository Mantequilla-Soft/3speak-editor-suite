// Automatic punch-ins: quick zoom-ins on a talking-head clip at the start of
// each sentence and on loud words, as ordinary scale keyframes (keyframes.js)
// tagged 'punch', so one click takes them all off again. No model: the
// moments come from the auto captions' word times when there are captions,
// else from the loudness of the clip's sound (silenceDetect.js's curve).

import { suggestThreshold } from './silenceDetect'
import { normalizeKeyframes, propAt } from './keyframes'
import { clearKeyframes } from './motionEdits'
import { clipTimeAt, sourceAt } from './clipSpeed'

export const PUNCH = {
  zoom: 1.15, // how far in (x the scale it has there)
  rampIn: 0.15, // seconds to zoom in
  rampOut: 0.3, // ... and back out
  holdMax: 2.2, // longest hold
  minGap: 2, // seconds between two punch-ins at least
  sentenceGap: 0.6 // a pause this long (or . ! ?) starts a new sentence
}

const pos = (c) => c.timelinePosition || 0

/** Timeline times where a sentence starts, from caption words (timeline seconds) */
export function sentenceStarts(words, from, to) {
  const out = []
  let prev = null
  for (const w of words || []) {
    if (!(w.start >= from && w.start < to)) { prev = w; continue }
    const ends = prev && /[.!?…]["')\]]*$/.test(String(prev.text || '').trim())
    if (!prev || prev.end < from || w.start - prev.end >= PUNCH.sentenceGap || ends) out.push(w.start)
    prev = w
  }
  return out
}

// Loudest dB in [a, b) media seconds of a loudness curve
function peakDb(loudness, a, b) {
  const { db, step } = loudness
  let best = -Infinity
  for (let i = Math.max(0, Math.floor(a / step)); i < Math.min(db.length, Math.ceil(b / step)); i++) best = Math.max(best, db[i])
  return best
}

const percentile = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : -Infinity
}

/** Timeline times of loud words: the loudest tenth, clearly louder than the rest */
export function loudWords(words, loudness, toMedia, from, to) {
  const inside = (words || []).filter(w => w.start >= from && w.start < to && w.end > w.start)
  if (!loudness || inside.length < 4) return []
  const peaks = inside.map(w => peakDb(loudness, toMedia(w.start), toMedia(w.end)))
  const high = percentile(peaks, 0.9)
  const mid = percentile(peaks, 0.5)
  return inside.filter((w, i) => peaks[i] >= high && peaks[i] >= mid + 4).map(w => w.start)
}

/**
 * Without captions: where speech starts after a pause (a phrase) and where it
 * jumps clearly louder, in media seconds between a and b.
 * Returns [{ at, strong }] (strong = a phrase start).
 */
export function loudnessMoments(loudness, a, b) {
  const { db, step } = loudness
  const thr = suggestThreshold(loudness, a, b)
  const i0 = Math.max(0, Math.floor(a / step))
  const i1 = Math.min(db.length, Math.ceil(b / step))
  const out = []
  // Phrase starts: sound after at least sentenceGap of quiet
  let quietFor = Infinity
  for (let i = i0; i < i1; i++) {
    if (db[i] < thr) { quietFor += step; continue }
    if (quietFor >= PUNCH.sentenceGap) out.push({ at: i * step, strong: true })
    quietFor = 0
  }
  // Loud jumps: 100 ms windows clearly above the loud parts' usual level
  const win = Math.max(1, Math.round(0.1 / step))
  const levels = []
  for (let i = i0; i + win <= i1; i += win) {
    let m = -Infinity
    for (let j = i; j < i + win; j++) m = Math.max(m, db[j])
    levels.push({ at: i * step, m })
  }
  const voiced = levels.filter(l => l.m >= thr).map(l => l.m)
  const high = percentile(voiced, 0.93)
  const mid = percentile(voiced, 0.5)
  for (let k = 1; k < levels.length; k++) {
    const l = levels[k]
    if (l.m >= high && l.m >= mid + 5 && levels[k - 1].m < l.m - 3) out.push({ at: l.at, strong: false })
  }
  return out.sort((x, y) => x.at - y.at)
}

/**
 * Pick the moments (clip time): phrase / sentence starts first, then loud
 * words, never two closer than minGap, none in the clip's last second.
 */
export function pickMoments(strong, weak, startTime, endTime) {
  const ok = (t) => t >= startTime && t <= endTime - 1
  const chosen = []
  const fits = (t) => chosen.every(c => Math.abs(c - t) >= PUNCH.minGap)
  for (const t of [...strong].filter(ok).sort((a, b) => a - b)) if (fits(t)) chosen.push(t)
  for (const t of [...weak].filter(ok).sort((a, b) => a - b)) if (fits(t)) chosen.push(t)
  return chosen.sort((a, b) => a - b)
}

/**
 * Updates that put punch-ins on the clip at `moments` (clip time), replacing
 * earlier punch-ins. Each: zoom in over rampIn, hold, ease back out before
 * the next one (or after holdMax).
 */
export function punchInUpdates(clip, moments) {
  const plain = { ...clip, ...clearKeyframes(clip, 'punch') }
  const scale = [...((normalizeKeyframes(plain.keyframes) || {}).scale || [])]
  const k = (t, v, ease) => ({ t: Number(t.toFixed(4)), v: Number(v.toFixed(2)), ...(ease ? { ease: 'ease' } : {}), tag: 'punch' })
  const sorted = [...moments].sort((a, b) => a - b)
  sorted.forEach((m, i) => {
    const next = i + 1 < sorted.length ? sorted[i + 1] : clip.endTime
    const z = propAt(plain, 'scale', m)
    const holdEnd = Math.min(m + PUNCH.holdMax, next - PUNCH.rampOut - 0.1)
    if (holdEnd < m + PUNCH.rampIn + 0.3) return
    scale.push(k(m, z), k(m + PUNCH.rampIn, z * PUNCH.zoom), k(holdEnd, z * PUNCH.zoom, true), k(holdEnd + PUNCH.rampOut, z))
  })
  return { keyframes: normalizeKeyframes({ ...(normalizeKeyframes(plain.keyframes) || {}), scale }) || undefined }
}

export const hasPunchIns = (clip) => Object.values(normalizeKeyframes(clip?.keyframes) || {}).some(l => l.some(k => k.tag === 'punch'))
export const removePunchIns = (clip) => clearKeyframes(clip, 'punch')

/**
 * The punch-in moments of a clip (clip time). `words` = caption words
 * (timeline seconds) or null, `loudness` = the clip's sound's loudness curve
 * (media seconds) or null. Returns { moments, from: 'captions' | 'loudness' }.
 */
export function planPunchIns(clip, { words = null, loudness = null } = {}) {
  const start = pos(clip)
  const end = start + (clip.endTime - clip.startTime)
  const toClip = (t) => clip.startTime + (t - start) // timeline -> clip time
  const toMedia = (t) => sourceAt(clip, toClip(t))
  const spoken = (words || []).filter(w => w.start >= start && w.start < end)
  if (spoken.length) {
    const strong = sentenceStarts(words, start, end).map(toClip)
    const weak = loudWords(words, loudness, toMedia, start, end).map(toClip)
    return { moments: pickMoments(strong, weak, clip.startTime, clip.endTime), from: 'captions' }
  }
  if (!loudness) return { moments: [], from: 'loudness' }
  const [a, b] = [sourceAt(clip, clip.startTime), sourceAt(clip, clip.endTime)]
  const found = loudnessMoments(loudness, a, b)
  const strong = found.filter(f => f.strong).map(f => clipTimeAt(clip, f.at))
  const weak = found.filter(f => !f.strong).map(f => clipTimeAt(clip, f.at))
  return { moments: pickMoments(strong, weak, clip.startTime, clip.endTime), from: 'loudness' }
}
