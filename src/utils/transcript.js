// The transcript of a show (edit by text, filler removal, chapter ideas): the
// spoken words of every recording, pinned to the recording, not to the clock.
// Like chapters (utils/chapters.js), a word is kept with its time IN ITS FILE
// (the library item it came from), so cuts, trims, silence cutting and undo
// move or hide it with no bookkeeping: a word shows where its moment of the
// recording is on the timeline now, and not at all when that moment was cut.
//
// transcript: { v: 1, language, sources: { [libraryId]: { w: [[text, start, end]], covered: [[from, to]] } } }
//   w        the words, by start, seconds in that file
//   covered  the stretches of the file that were listened to (words or not)
// The speaker of a word is the track its clip is on (each voice its own track).
// A retimed clip (utils/clipSpeed.js: speed, ramp) maps its words through its
// time map, so at 2x they come twice as fast; a freeze frame has no words.

import { voiceTracksOf } from './captionSources'
import { t as tr } from '../i18n'
import { sourceAt, clipTimeAt, isFrozen } from './clipSpeed'

const EPS = 0.001
const MAX_WORD_CHARS = 40
// Stored per word: about 25 bytes, so a three-hour show of two voices stays far below the draft limit
export const MAX_TRANSCRIPT_WORDS = 80000

const round3 = (t) => Math.round(t * 1000) / 1000
const pos = (c) => c.timelinePosition || 0
const len = (c) => Math.max(0, c.endTime - c.startTime)

export const emptyTranscript = () => ({ v: 1, language: null, sources: {} })

/** Ranges [[a, b]] sorted and joined where they touch (within `join` seconds). */
export function mergeRanges(ranges, join = 0.05) {
  const list = (ranges || []).filter(r => Array.isArray(r) && r[1] > r[0]).map(r => [r[0], r[1]]).sort((x, y) => x[0] - y[0])
  const out = []
  for (const [a, b] of list) {
    const last = out[out.length - 1]
    if (last && a <= last[1] + join) last[1] = Math.max(last[1], b)
    else out.push([a, b])
  }
  return out.map(([a, b]) => [round3(a), round3(b)])
}

/** `ranges` without `minus` (both merged lists), pieces under `min` seconds dropped. */
export function subtractRanges(ranges, minus, min = 0.5) {
  const out = []
  for (const [a0, b0] of ranges) {
    let a = a0
    for (const [c, d] of minus) {
      if (d <= a || c >= b0) continue
      if (c > a) out.push([a, Math.min(c, b0)])
      a = Math.max(a, d)
      if (a >= b0) break
    }
    if (b0 > a) out.push([a, b0])
  }
  return out.filter(([a, b]) => b - a >= min).map(([a, b]) => [round3(a), round3(b)])
}

const cleanText = (t) => String(t ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_WORD_CHARS)

/** A transcript as saved in a draft, checked (null when there is none). */
export function cleanTranscript(raw) {
  if (!raw || typeof raw !== 'object' || !raw.sources || typeof raw.sources !== 'object') return null
  const out = emptyTranscript()
  out.language = typeof raw.language === 'string' && /^[a-z]{2,3}$/.test(raw.language) ? raw.language : null
  let count = 0
  for (const [id, s] of Object.entries(raw.sources)) {
    if (!s || !Array.isArray(s.w) || typeof id !== 'string' || id.length > 100) continue
    const w = []
    for (const x of s.w) {
      if (count >= MAX_TRANSCRIPT_WORDS) break
      if (!Array.isArray(x)) continue
      const text = cleanText(x[0])
      const a = +x[1]
      const b = +x[2]
      if (!text || !Number.isFinite(a) || a < 0) continue
      w.push([text, round3(a), round3(Number.isFinite(b) && b > a ? b : a + 0.2)])
      count++
    }
    w.sort((p, q) => p[1] - q[1])
    out.sources[id] = { w, covered: mergeRanges((s.covered || []).filter(r => Array.isArray(r)).map(r => [+r[0], +r[1]]).filter(r => r.every(Number.isFinite))) }
  }
  return Object.keys(out.sources).length ? out : null
}

/**
 * A finished chunk from the backend ({ source, from, to, words }) merged in:
 * the words of that stretch replace what was there, the stretch counts as
 * listened to.
 */
export function addChunk(transcript, chunk, language = null) {
  const t = transcript || emptyTranscript()
  const id = String(chunk.source)
  const prev = t.sources[id] || { w: [], covered: [] }
  const from = +chunk.from
  const to = +chunk.to
  const kept = prev.w.filter(x => x[1] < from - EPS || x[1] >= to - EPS)
  const fresh = (chunk.words || []).map(x => [cleanText(x.text), round3(+x.start), round3(+x.end)]).filter(x => x[0] && Number.isFinite(x[1]))
  const w = [...kept, ...fresh].sort((p, q) => p[1] - q[1])
  return {
    ...t,
    language: language || t.language,
    sources: { ...t.sources, [id]: { w, covered: mergeRanges([...prev.covered, [from, to]]) } }
  }
}

/** Words in the whole transcript. */
export const wordCount = (transcript) => Object.values(transcript?.sources || {}).reduce((n, s) => n + s.w.length, 0)

/**
 * The clips whose sound is speech, with their speaker: [{ clip, trackId,
 * speaker, speakerIndex }]. Voice tracks (not music or sound effects, not
 * template parts, not muted) and video clips playing their own sound; each
 * track is one speaker, named after it.
 */
export function speechClips(tracks) {
  const out = []
  voiceTracksOf(tracks).forEach((t, i) => {
    const speaker = String(t.name || '').trim() || tr('transcript.speaker.numbered', { n: i + 1 })
    for (const clip of t.clips) {
      if (!clip.libraryId || len(clip) <= 0 || isFrozen(clip)) continue
      out.push({ clip, trackId: t.id, speaker, speakerIndex: i })
    }
  })
  return out
}

/**
 * What still has to be listened to: [{ libraryId, clipId, ranges }] (seconds
 * in the file), the parts of every recording on the timeline (a second more on
 * each side) that the transcript does not cover yet.
 */
export function neededRanges(tracks, transcript, pad = 1) {
  const bySource = new Map()
  for (const { clip } of speechClips(tracks)) {
    const e = bySource.get(clip.libraryId) || { libraryId: clip.libraryId, clipId: clip.id, ranges: [] }
    // in the file's own seconds (a retimed clip shows more or less of its file than its length)
    e.ranges.push([Math.max(0, sourceAt(clip, clip.startTime) - pad), sourceAt(clip, clip.endTime) + pad])
    bySource.set(clip.libraryId, e)
  }
  const out = []
  for (const e of bySource.values()) {
    const covered = transcript?.sources?.[e.libraryId]?.covered || []
    const ranges = subtractRanges(mergeRanges(e.ranges, 0.5), covered)
    if (ranges.length) out.push({ ...e, ranges })
  }
  return out
}

/** Seconds of recording still to listen to. */
export const neededSeconds = (needed) => (needed || []).reduce((n, e) => n + e.ranges.reduce((m, [a, b]) => m + (b - a), 0), 0)

// First word starting at or after t (words sorted by start)
function firstFrom(w, t) {
  let lo = 0
  let hi = w.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (w[mid][1] < t) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * The words where they are on the timeline now, by time:
 * [{ text, start, end, speaker, speakerIndex, trackId, clipId, libraryId, src }]
 * (src = the word's start in its file). A word whose start was cut out is not
 * there; one cut short ends where its clip ends.
 */
export function placeWords(tracks, transcript) {
  if (!transcript?.sources) return []
  const out = []
  const seen = new Set()
  for (const { clip, trackId, speaker, speakerIndex } of speechClips(tracks)) {
    const s = transcript.sources[clip.libraryId]
    if (!s?.w?.length) continue
    const p = pos(clip)
    const clipEnd = p + len(clip)
    // the clip's stretch of its file, and file seconds -> timeline seconds through its time map
    const from = sourceAt(clip, clip.startTime)
    const to = sourceAt(clip, clip.endTime)
    const at = (x) => p + (clipTimeAt(clip, x) - clip.startTime)
    for (let k = firstFrom(s.w, from - EPS); k < s.w.length; k++) {
      const [text, a, b] = s.w[k]
      if (a >= to - 0.05) break
      const start = round3(at(a))
      const key = `${clip.libraryId}:${Math.round(start * 100)}`
      if (seen.has(key)) continue // the same recording twice at the same moment (a video and its own sound)
      seen.add(key)
      out.push({ text, start, end: round3(Math.min(clipEnd, Math.max(start + 0.05, at(Math.min(b, to))))), speaker, speakerIndex, trackId, clipId: clip.id, libraryId: clip.libraryId, src: a })
    }
  }
  return out.sort((x, y) => x.start - y.start || x.speakerIndex - y.speakerIndex)
}

const SENTENCE_END = /[.!?…]["')\]]*$/

/**
 * The placed words as paragraphs for the transcript view: [{ speaker,
 * speakerIndex, start, from, to }] (word indexes from..to inclusive). A new
 * paragraph when the speaker changes, after a pause of `gap` seconds, or after
 * a sentence once it is long.
 */
export function paragraphsOf(words, { gap = 2, maxWords = 70 } = {}) {
  const out = []
  let cur = null
  words.forEach((w, i) => {
    const prev = words[i - 1]
    const brk = !cur || w.speakerIndex !== cur.speakerIndex ||
      (prev && w.start - prev.end > gap) ||
      (i - cur.from >= maxWords && prev && SENTENCE_END.test(prev.text)) ||
      i - cur.from >= maxWords * 2
    if (brk) {
      if (cur) out.push(cur)
      cur = { speaker: w.speaker, speakerIndex: w.speakerIndex, start: w.start, from: i, to: i }
    } else {
      cur.to = i
    }
  })
  if (cur) out.push(cur)
  return out
}

/** The index of the word playing at `t` (or the last one before it), -1 before the first. */
export function wordAt(words, t) {
  let lo = 0
  let hi = words.length - 1
  let best = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (words[mid].start <= t + EPS) { best = mid; lo = mid + 1 } else hi = mid - 1
  }
  return best
}

/**
 * The timeline stretches to cut for the selected words (indexes into the
 * placed words): each run of selected words from its first word's start to
 * just before the next word (so the pause after the run goes with it, up to
 * 2 s, and the one before stays), never into the words around it. Merged.
 */
export function cutRangesForWords(words, indexes) {
  const sel = [...new Set(indexes)].filter(i => i >= 0 && i < words.length).sort((a, b) => a - b)
  const ranges = []
  let k = 0
  while (k < sel.length) {
    let j = k
    while (j + 1 < sel.length && sel[j + 1] === sel[j] + 1) j++
    const first = words[sel[k]]
    const last = words[sel[j]]
    const prev = words[sel[k] - 1]
    const next = words[sel[j] + 1]
    const runEnd = Math.max(...sel.slice(k, j + 1).map(i => words[i].end))
    const a = Math.max(prev ? Math.min(prev.end, first.start) : 0, first.start - 0.03)
    // up to the next word (a little before it), at most 2 s of the pause after the run
    const b = next ? Math.max(runEnd, Math.min(next.start - 0.03, runEnd + 2)) : last.end
    if (b - a > 0.02) ranges.push([round3(a), round3(Math.max(b, a + 0.02))])
    k = j + 1
  }
  return mergeRanges(ranges, 0.001)
}

/** "1:02:03.4" style times for the transcript view. */
export function transcriptTime(sec) {
  const s = Math.max(0, Math.floor(sec + 1e-6))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** The transcript as plain text, speaker by speaker (for copying). */
export function transcriptText(words, paragraphs) {
  return paragraphs.map(p => `${p.speaker} (${transcriptTime(p.start)}): ${words.slice(p.from, p.to + 1).map(w => w.text).join(' ')}`).join('\n\n')
}
