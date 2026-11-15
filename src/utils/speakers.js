// Who is speaking when, for the video podcast's speaker names: each voice
// track's loudness over the timeline (from the same peaks the waveforms show,
// utils/peakCache.js), then the loudest voice that clearly stands out, held a
// moment so a cough or a "mm" from the other side does not flip the name.
import { t as tr } from '../i18n'

export const LEVEL_STEP = 0.25 // seconds per window

/** The voice tracks: audio, not music or sound effects, not muted, with clips (no template intro/outro). */
export function voiceTracks(tracks) {
  return (tracks || [])
    .filter(t => t.type === 'audio' && !t.music && !t.sfx && t.muted !== true)
    .map(t => ({ ...t, clips: t.clips.filter(c => c.audioEnabled !== false && !c.templateRole && c.url) }))
    .filter(t => t.clips.length > 0)
}

/**
 * Loudness of one track per window over [0, end): the loudest peak of its
 * clips in each window, times the clip's volume. `peaksOf(clip)` gives the
 * clip's file peaks ({ peaks, step }, media time) or null (then that clip
 * counts as silent).
 */
export function trackLevels(track, peaksOf, end, step = LEVEL_STEP) {
  const n = Math.max(0, Math.ceil(end / step))
  const out = new Float32Array(n)
  for (const clip of track.clips) {
    const env = peaksOf(clip)
    if (!env?.peaks?.length) continue
    const vol = Number.isFinite(+clip.volume) ? Math.max(0, +clip.volume) / 100 : 1
    if (!vol) continue
    const from = clip.timelinePosition || 0
    const to = from + (clip.endTime - clip.startTime)
    for (let i = Math.max(0, Math.floor(from / step)); i < Math.min(n, Math.ceil(to / step)); i++) {
      const t0 = Math.max(i * step, from)
      const t1 = Math.min((i + 1) * step, to)
      const a = Math.floor((t0 - from + clip.startTime) / env.step)
      const b = Math.max(a + 1, Math.floor((t1 - from + clip.startTime) / env.step))
      let max = 0
      for (let k = Math.max(0, a); k < Math.min(env.peaks.length, b); k++) if (env.peaks[k] > max) max = env.peaks[k]
      const v = Math.min(1, max * vol)
      if (v > out[i]) out[i] = v
    }
  }
  return out
}

/**
 * Speaker turns from the levels: [{ start, end, name }]. levels: [{ name,
 * values }] on the same windows. A voice speaks in a window when it is over
 * `threshold` and `margin` times louder than every other one; it takes over
 * after `switchAfter` seconds of that, and a turn ends after `gap` seconds of
 * nobody. Turns shorter than `minTurn` are dropped.
 */
export function speakerSegments(levels, { step = LEVEL_STEP, threshold = 0.06, margin = 1.5, switchAfter = 0.75, gap = 2, minTurn = 1 } = {}) {
  const list = (levels || []).filter(l => l?.values?.length)
  if (!list.length) return []
  const n = Math.max(...list.map(l => l.values.length))
  const need = Math.max(1, Math.round(switchAfter / step))
  const quiet = Math.max(1, Math.round(gap / step))
  const turns = []
  let cur = null // { who, start, last }
  let cand = -1
  let candRun = 0
  let silence = 0
  for (let i = 0; i < n; i++) {
    let best = -1
    let bestV = 0
    let second = 0
    list.forEach((l, k) => {
      const v = l.values[i] || 0
      if (v > bestV) { second = bestV; bestV = v; best = k } else if (v > second) second = v
    })
    const who = best >= 0 && bestV >= threshold && bestV >= second * margin ? best : -1
    if (who === -1) {
      silence++
      candRun = 0
      if (cur && silence >= quiet) { turns.push(cur); cur = null }
      continue
    }
    silence = 0
    if (cur && who === cur.who) { cur.last = i; candRun = 0; continue }
    candRun = who === cand ? candRun + 1 : 1
    cand = who
    if (!cur || candRun >= need) {
      if (cur) turns.push(cur)
      cur = { who, start: i - candRun + 1, last: i }
      candRun = 0
    }
  }
  if (cur) turns.push(cur)
  const out = []
  for (const t of turns) {
    const start = Math.max(0, t.start) * step
    const end = (t.last + 1) * step
    if (end - start < minTurn) continue
    const prev = out[out.length - 1]
    const name = list[t.who].name
    if (prev && prev.name === name && start - prev.end <= gap) prev.end = end
    else out.push({ start: Math.round(start * 100) / 100, end: Math.round(end * 100) / 100, name })
  }
  for (let i = 1; i < out.length; i++) if (out[i].start < out[i - 1].end) out[i - 1].end = out[i].start
  return out
}

/**
 * The speaker turns of a project: names = { trackId: name }. `getPeaks`
 * (utils/peakCache.js) is passed in; files it cannot read count as silent.
 */
export async function projectSpeakers(tracks, names, end, getPeaks) {
  const voices = voiceTracks(tracks)
  const envs = new Map()
  for (const t of voices) {
    for (const c of t.clips) {
      if (!envs.has(c.url)) envs.set(c.url, await getPeaks(c.url, { analysisUrl: c.serverUrl || null }).catch(() => null))
    }
  }
  const fallback = tr('transcript.speaker.default')
  const levels = voices.map(t => ({ name: String(names?.[t.id] || t.name || fallback).trim() || fallback, values: trackLevels(t, c => envs.get(c.url), end) }))
  return speakerSegments(levels)
}
