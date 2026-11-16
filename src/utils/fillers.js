// Remove fillers and long pauses (the transcript's words, utils/transcript.js):
// finds "um", "uh", "you know" and their kind in the spoken language
// (src/data/fillerWords.json), and the pauses longer than a chosen length, for
// a review list; then works out what to cut: a filler goes with a little of
// the silence around it (the pause left is the longer one of its two sides),
// a long pause is shortened to the chosen length (not removed).
import FILLERS from '../data/fillerWords.json'

const SET_OFF = 0.35 // seconds of silence that set a word off like a comma
const PUNCT_END = /[,.;:!?…]["')\]]*$/
const PUNCT_BEFORE_END = /[,.;:!?…\-–]["')\]]*$/
const PHRASE_GAP = 0.6 // the words of a phrase follow each other this closely

/** A word as the table writes it: lower case, letters, digits, inner ' and - only. */
export const normalWord = (text) => String(text || '').toLowerCase().normalize('NFC').replace(/[^\p{L}\p{N}\p{M}'’-]+/gu, '').replace(/^['’-]+|['’-]+$/g, '').replace(/’/g, "'")

/** The languages with a filler list (besides the sounds every language shares). */
export const FILLER_LANGUAGES = Object.keys(FILLERS).filter(k => !k.startsWith('_') && k !== 'any')

/** The table for a language: { sounds: Set, phrases: [[word, ...]] } (longest phrases first). */
export function fillerTable(language) {
  const base = (language || '').toLowerCase().split('-')[0]
  const own = FILLERS[base] || { sounds: [], phrases: [] }
  const sounds = new Set([...FILLERS.any.sounds, ...own.sounds].map(normalWord))
  const phrases = [...FILLERS.any.phrases, ...own.phrases].map(p => p.split(/\s+/).map(normalWord).filter(Boolean)).filter(p => p.length)
  phrases.sort((a, b) => b.length - a.length)
  return { sounds, phrases, known: !!FILLERS[base] }
}

/**
 * The fillers among the placed words: [{ id, kind: 'filler', from, to, text,
 * start, end, speaker, sure }] (from..to word indexes). Sounds ("um") are
 * always fillers (`sure`); the words and phrases of the list ("like", "you
 * know") only when set off by a pause or a comma on both sides. One that
 * someone else talks over is left alone (cutting it would cut them too).
 */
export function findFillers(words, language) {
  const { sounds, phrases } = fillerTable(language)
  const byVoice = new Map()
  words.forEach((w, i) => {
    if (!byVoice.has(w.speakerIndex)) byVoice.set(w.speakerIndex, [])
    byVoice.get(w.speakerIndex).push(i)
  })
  const out = []
  for (const list of byVoice.values()) {
    for (let k = 0; k < list.length; k++) {
      const i = list[k]
      const w = words[i]
      const norm = normalWord(w.text)
      if (!norm) continue
      let span = 0
      let sure = false
      if (sounds.has(norm)) { span = 1; sure = true } else {
        for (const p of phrases) {
          if (k + p.length > list.length) continue
          let ok = true
          for (let m = 0; m < p.length && ok; m++) {
            const x = words[list[k + m]]
            ok = normalWord(x.text) === p[m] && (m === 0 || x.start - words[list[k + m - 1]].end <= PHRASE_GAP) && (m === p.length - 1 || !PUNCT_END.test(x.text))
          }
          if (!ok) continue
          const prev = k > 0 ? words[list[k - 1]] : null
          const lastW = words[list[k + p.length - 1]]
          const next = k + p.length < list.length ? words[list[k + p.length]] : null
          const before = !prev || PUNCT_BEFORE_END.test(prev.text) || w.start - prev.end >= SET_OFF
          const after = !next || PUNCT_END.test(lastW.text) || next.start - lastW.end >= SET_OFF
          // "Like I said" at the start is a word; a phrase needs to be set off on both sides
          if (before && after && (prev || next)) { span = p.length; break }
        }
      }
      if (!span) continue
      const idx = list.slice(k, k + span)
      const first = words[idx[0]]
      const last = words[idx[idx.length - 1]]
      // talked over: another voice has a word in this stretch
      const over = words.some((x) => x.speakerIndex !== w.speakerIndex && x.start < last.end - 0.05 && x.end > first.start + 0.05)
      if (!over) out.push({ id: `f:${first.start}:${w.speakerIndex}`, kind: 'filler', from: idx[0], to: idx[idx.length - 1], idx, text: idx.map(j => words[j].text).join(' '), start: first.start, end: last.end, speaker: w.speaker, sure })
      k += span - 1
    }
  }
  return out.sort((a, b) => a.start - b.start)
}

/** Stretches where no one speaks, longer than `minPause` seconds (between words, not before the first or after the last): [{ id, kind: 'pause', start, end }]. */
export function findPauses(words, minPause = 1.5) {
  const out = []
  let end = -Infinity
  for (const w of words) {
    if (end > -Infinity && w.start - end >= minPause) out.push({ id: `p:${Math.round(end * 100)}`, kind: 'pause', start: end, end: w.start })
    end = Math.max(end, w.end)
  }
  return out
}

const round3 = (t) => Math.round(t * 1000) / 1000

/**
 * What to cut ([[from, to]] timeline seconds) for the ticked items.
 * A filler: itself and of the silence on both sides as much as leaves the
 * longer of the two pauses (so "word, um, word" becomes "word, word" with the
 * breath it had, never a jump; a long pause there is shortened only when it
 * is ticked too). A pause: shortened to `keepPause`, the rest of it kept half
 * before and half after the cut.
 */
export function fillerCutRanges(words, items, { keepPause = 0.5 } = {}) {
  const ranges = []
  const keep = Math.max(0, keepPause)
  for (const it of items) {
    if (it.kind === 'pause') {
      if (it.end - it.start > keep + 0.05) ranges.push([round3(it.start + keep / 2), round3(it.end - keep / 2)])
      continue
    }
    const prev = words[it.from - 1]
    const next = words[it.to + 1]
    const gapBefore = prev ? Math.max(0, it.start - prev.end) : 0
    const gapAfter = next ? Math.max(0, next.start - it.end) : 0
    // the pause that stays: the longer of the two (a long one is the pause items' business)
    const left = Math.max(gapBefore, gapAfter)
    const keptBefore = Math.min(gapBefore, Math.max(left / 2, left - gapAfter))
    const keptAfter = Math.max(0, left - keptBefore)
    const a = prev ? Math.min(it.start, prev.end + keptBefore) : it.start
    const b = next ? Math.max(it.end, next.start - keptAfter) : it.end
    if (b - a > 0.02) ranges.push([round3(a), round3(b)])
  }
  return ranges.sort((x, y) => x[0] - y[0])
}
