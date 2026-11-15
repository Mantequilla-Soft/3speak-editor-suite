// Chapter ideas (the Chapters dialog's "Suggest"): places where a new part of
// the show likely starts, from three plain signals, no AI:
// - topic shifts in the transcript: TextTiling (Hearst 1997), the words of the
//   minutes before a point compared with the minutes after it; where they
//   share least, the talk moved on
// - long pauses (from the transcript, or from the loudness without one)
// - scene changes in the picture (the backend's scene scores)
// Signals that agree rank higher; suggestions keep a distance from each other
// and from the chapters already there. Each gets a title from the words that
// set its part apart from the rest of the show.
import STOPWORDS from '../data/stopwords.json'
import FILLERS from '../data/fillerWords.json'
import { normalWord, findPauses } from './fillers'

const NO_SPACES = new Set(['ja', 'zh', 'ko', 'th']) // whisper's "words" there are characters: no topic shifts
const round3 = (t) => Math.round(t * 1000) / 1000

const stopCache = new Map()
/** The words left out for a language: its stop words, every filler, and one- and two-letter words. */
export function stopWords(language) {
  const base = String(language || 'en').toLowerCase().split('-')[0]
  if (stopCache.has(base)) return stopCache.get(base)
  const set = new Set(String(STOPWORDS[base] || STOPWORDS.en).split(/\s+/).map(normalWord))
  for (const k of Object.keys(FILLERS)) {
    if (k.startsWith('_')) continue
    for (const w of [...FILLERS[k].sounds, ...FILLERS[k].phrases]) for (const part of w.split(/\s+/)) set.add(normalWord(part))
  }
  stopCache.set(base, set)
  return set
}

// A crude stem for comparing: the first 6 letters ("election", "elections" -> "electi")
const stem = (w) => (w.length > 6 ? w.slice(0, 6) : w)

/** The words that carry meaning: [{ stem, form, i }] (i = index into the placed words). */
export function contentTokens(words, language) {
  const stop = stopWords(language)
  const out = []
  words.forEach((w, i) => {
    const form = normalWord(w.text).replace(/'s$/, '')
    if (form.length < 3 || stop.has(form) || /^\d+$/.test(form)) return
    out.push({ stem: stem(form), form, i })
  })
  return out
}

function cosine(a, b) {
  let dot = 0
  let na = 0
  let nb = 0
  for (const [k, v] of a) { na += v * v; const w = b.get(k); if (w) dot += v * w }
  for (const v of b.values()) nb += v * v
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}
const addInto = (acc, m) => { for (const [k, v] of m) acc.set(k, (acc.get(k) || 0) + v) }

/**
 * Topic shifts: [{ i (first word of the new part), time, depth }] by time.
 * Pseudo-sentences of `sentenceTokens` content words; blocks of about
 * `blockSeconds` of talk on each side of every gap between them are compared
 * (cosine of word counts); a gap's depth is how far its similarity dips below
 * the peaks on both sides. Only the clear dips are returned (depth above the
 * mean plus half a standard deviation).
 */
export function topicShifts(words, { language = 'en', blockSeconds = 90, sentenceTokens = 20 } = {}) {
  if (NO_SPACES.has(String(language).split('-')[0])) return []
  const tokens = contentTokens(words, language)
  const n = Math.floor(tokens.length / sentenceTokens)
  if (n < 6) return []
  const sentences = []
  for (let s = 0; s < n; s++) {
    const m = new Map()
    for (const t of tokens.slice(s * sentenceTokens, (s + 1) * sentenceTokens)) m.set(t.stem, (m.get(t.stem) || 0) + 1)
    sentences.push({ i: tokens[s * sentenceTokens].i, counts: m })
  }
  const span = words[sentences[n - 1].i].start - words[sentences[0].i].start
  const k = Math.max(2, Math.min(12, Math.round(blockSeconds / Math.max(1, span / n))))
  if (n < 2 * k) return []
  const scores = []
  for (let g = k; g <= n - k; g++) {
    const left = new Map()
    const right = new Map()
    for (let s = g - k; s < g; s++) addInto(left, sentences[s].counts)
    for (let s = g; s < g + k; s++) addInto(right, sentences[s].counts)
    scores.push({ g, score: cosine(left, right) })
  }
  const smooth = scores.map((x, j) => ({ g: x.g, score: (scores[Math.max(0, j - 1)].score + x.score + scores[Math.min(scores.length - 1, j + 1)].score) / 3 }))
  const depths = smooth.map((x, j) => {
    let l = x.score
    for (let a = j - 1; a >= 0 && smooth[a].score >= l; a--) l = smooth[a].score
    let r = x.score
    for (let b = j + 1; b < smooth.length && smooth[b].score >= r; b++) r = smooth[b].score
    return { g: x.g, depth: (l - x.score) + (r - x.score) }
  })
  // local minima only (the bottom of each dip)
  const minima = depths.filter((d, j) => d.depth > 0 && (j === 0 || smooth[j].score <= smooth[j - 1].score) && (j === depths.length - 1 || smooth[j].score <= smooth[j + 1].score))
  if (!minima.length) return []
  const mean = minima.reduce((s, d) => s + d.depth, 0) / minima.length
  const sd = Math.sqrt(minima.reduce((s, d) => s + (d.depth - mean) ** 2, 0) / minima.length)
  return minima
    .filter(d => d.depth >= mean + sd / 2 || minima.length <= 2)
    .map(d => ({ i: sentences[d.g].i, time: words[sentences[d.g].i].start, depth: round3(d.depth) }))
}

/** The best moment near `t` for a chapter to start: just before the words after the longest pause within `window` s (else t). */
export function snapToPause(words, t, window = 20) {
  let best = null
  let end = -Infinity
  for (const w of words) {
    if (w.start > t + window) break
    if (end > -Infinity && w.start >= t - window && w.start - end >= 0.4) {
      const gap = w.start - end
      if (!best || gap > best.gap + 0.3 || (Math.abs(gap - best.gap) <= 0.3 && Math.abs(w.start - t) < Math.abs(best.at - t))) best = { gap, at: w.start }
    }
    end = Math.max(end, w.end)
  }
  return best ? round3(best.at - Math.min(0.4, best.gap / 2)) : t
}

const cap = (s) => s.charAt(0).toLocaleUpperCase() + s.slice(1)

/**
 * A title for each part (boundaries `starts`, seconds, by time): its three
 * words that most set it apart from the other parts (how often there, against
 * in how many parts at all), in their most used form. null for a part without
 * such words.
 */
export function partTitles(words, starts, end, language = 'en') {
  const tokens = contentTokens(words, language)
  const parts = starts.map((s, j) => ({ from: s, to: j + 1 < starts.length ? starts[j + 1] : end, tf: new Map(), forms: new Map() }))
  let p = 0
  for (const t of tokens) {
    const time = words[t.i].start
    while (p + 1 < parts.length && time >= parts[p + 1].from) p++
    if (time < parts[p].from) continue
    const part = parts[p]
    part.tf.set(t.stem, (part.tf.get(t.stem) || 0) + 1)
    const f = part.forms.get(t.stem) || new Map()
    f.set(t.form, (f.get(t.form) || 0) + 1)
    part.forms.set(t.stem, f)
  }
  const df = new Map()
  for (const part of parts) for (const k of part.tf.keys()) df.set(k, (df.get(k) || 0) + 1)
  return parts.map(part => {
    const ranked = [...part.tf.entries()]
      .filter(([, c]) => c >= 2)
      .map(([k, c]) => [k, c * Math.log(1 + parts.length / df.get(k))])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
    if (!ranked.length) return null
    const forms = ranked.map(([k]) => [...part.forms.get(k).entries()].sort((a, b) => b[1] - a[1])[0][0])
    return cap(forms.join(', ')).slice(0, 60)
  })
}

/**
 * Chapter suggestions: [{ id, at, title, reason: 'start' | 'topic' | 'pause' | 'scene', reasons }] by time.
 *   words     the placed words (utils/transcript.js placeWords), may be empty
 *   end       the length of the show
 *   existing  the chapters there now ([{ at }]): suggestions keep away from them
 *   pauses    silences [{ start, end }] measured from the sound (used when there are no words)
 *   scenes    scene changes [{ t, score }] (timeline seconds; hard cuts score 20-40)
 */
export function suggestChapters({ words = [], end, existing = [], pauses = null, scenes = [], language = 'en', minGap = null } = {}) {
  if (!(end > 30)) return []
  const gap = minGap || Math.max(45, Math.min(300, end / 12))
  const cands = []
  for (const s of topicShifts(words, { language })) cands.push({ at: snapToPause(words, s.time), reason: 'topic', strength: 2 + s.depth })
  const silences = words.length ? findPauses(words, 2.5) : (pauses || []).filter(p => p.end - p.start >= 2.5)
  for (const p of silences) cands.push({ at: round3(p.end - Math.min(0.5, (p.end - p.start) / 2)), reason: 'pause', strength: 1 + Math.min(1, (p.end - p.start) / 8) })
  for (const s of scenes || []) if (s.score >= 25) cands.push({ at: round3(s.t), reason: 'scene', strength: 1 + Math.min(1, (s.score - 20) / 30) })
  // signals that agree (within 15 s) rank higher
  for (const c of cands) {
    const others = new Set(cands.filter(o => o.reason !== c.reason && Math.abs(o.at - c.at) <= 15).map(o => o.reason))
    c.reasons = [c.reason, ...others]
    c.score = c.strength + 0.75 * others.size
  }
  const taken = (existing || []).map(c => c.at)
  const picked = []
  const maxCount = Math.max(1, Math.floor(end / gap))
  for (const c of cands.sort((a, b) => b.score - a.score)) {
    if (picked.length >= maxCount) break
    if (c.at < 15 || c.at > end - 30) continue
    if (picked.some(p => Math.abs(p.at - c.at) < gap) || taken.some(t => Math.abs(t - c.at) < gap / 2)) continue
    picked.push(c)
  }
  picked.sort((a, b) => a.at - b.at)
  const out = picked.map(c => ({ at: c.at, reason: c.reason, reasons: c.reasons }))
  if (!taken.some(t => t < 1) && (out.length || taken.length)) out.unshift({ at: 0, reason: 'start', reasons: ['start'] })
  // titles from the parts the suggestions and the chapters already there make together
  const starts = [...new Set([...out.map(c => c.at), ...taken])].sort((a, b) => a - b)
  if (!starts.length || starts[0] > 0) starts.unshift(0)
  const titles = words.length ? partTitles(words, starts, end, language) : []
  const titleAt = new Map(starts.map((s, j) => [s, titles[j] || null]))
  return out.map(c => ({
    id: `sug_${Math.round(c.at * 10)}`,
    at: c.at,
    reason: c.reason,
    reasons: c.reasons,
    title: c.reason === 'start' ? 'Intro' : (titleAt.get(c.at) || `Part ${starts.indexOf(c.at) + 1}`)
  }))
}
