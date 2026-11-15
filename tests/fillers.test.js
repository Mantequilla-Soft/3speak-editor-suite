// Remove fillers and long pauses: the filler table per language (a data file),
// "like" only as a filler when set off, talked-over fillers left alone, pauses
// over a length, and the cuts: a filler with a natural pause left, a long
// pause shortened (not removed). The review dialog lists and ticks them.
import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import FILLERS from '../src/data/fillerWords.json'
import { findFillers, findPauses, fillerCutRanges, fillerTable, normalWord, FILLER_LANGUAGES } from '../src/utils/fillers'
import { cutLength } from '../src/utils/ripple'
import FillerReviewDialog from '../src/components/FillerReviewDialog'

// words one after another (0.3 s each, `gap` s between), on one speaker unless given
function say(text, { gap = 0.1, speaker = 0, at = 0 } = {}) {
  let t = at
  return text.split(' ').map(w => {
    const out = { text: w, start: Math.round(t * 1000) / 1000, end: Math.round((t + 0.3) * 1000) / 1000, speaker: speaker ? 'Guest' : 'badadib', speakerIndex: speaker }
    t += 0.3 + gap
    return out
  })
}
const texts = (words, items) => items.map(it => words.slice(it.from, it.to + 1).map(w => w.text).join(' '))

describe('the filler table', () => {
  it('has at least en, de, es, fr, pt, it, nl and pl, and sounds every language shares', () => {
    for (const lang of ['en', 'de', 'es', 'fr', 'pt', 'it', 'nl', 'pl']) {
      expect(FILLER_LANGUAGES).toContain(lang)
      expect(FILLERS[lang].sounds.length + FILLERS[lang].phrases.length).toBeGreaterThan(5)
    }
    expect(fillerTable('xx').sounds.has('um')).toBe(true)
    expect(fillerTable('xx').known).toBe(false)
    expect(fillerTable('de-AT').sounds.has('ähm')).toBe(true)
    // written plainly (lower case, no punctuation) so the matcher finds them
    for (const k of FILLER_LANGUAGES) for (const w of [...FILLERS[k].sounds, ...FILLERS[k].phrases]) expect(w.split(' ').map(normalWord).join(' ')).toBe(w)
  })
  it('normalises words as whisper writes them', () => {
    expect(normalWord('Um,')).toBe('um')
    expect(normalWord('"Like,"')).toBe('like')
    expect(normalWord('uh-huh.')).toBe('uh-huh')
    expect(normalWord('Äh…')).toBe('äh')
  })
})

describe('finding fillers', () => {
  it('sounds always; "like" and "you know" only when set off', () => {
    const words = say('Um, so I like pizza. It was, like, huge. You know, it is good. Things like that.')
    const f = findFillers(words, 'en')
    expect(texts(words, f)).toEqual(['Um,', 'like,', 'You know,'])
    expect(f[0].sure).toBe(true)
    expect(f[1].sure).toBe(false)
  })
  it('"Like I said" is a word, and so is "like" between words', () => {
    const words = say('Like I said we like it')
    expect(findFillers(words, 'en')).toEqual([])
  })
  it('a pause sets a word off like a comma', () => {
    const words = [...say('it was'), ...say('like', { at: 1.2 }), ...say('huge', { at: 2 })]
    expect(texts(words, findFillers(words, 'en'))).toEqual(['like'])
  })
  it('German, Spanish, French fillers', () => {
    const de = say('Das ist, ähm, also, ganz einfach.')
    expect(texts(de, findFillers(de, 'de'))).toEqual(['ähm,', 'also,'])
    const es = say('Bueno, eh, o sea, es así.')
    expect(texts(es, findFillers(es, 'es'))).toEqual(['Bueno,', 'eh,', 'o sea,'])
    const fr = say('Alors euh, en fait, oui.')
    expect(texts(fr, findFillers(fr, 'fr'))).toEqual(['euh,', 'en fait,'])
  })
  it('one that someone else talks over is left alone (cutting it would cut them)', () => {
    const host = say('So um then', { gap: 0.2 })
    const guest = [{ text: 'yes', start: host[1].start + 0.05, end: host[1].end, speaker: 'Guest', speakerIndex: 1 }]
    const words = [...host, ...guest].sort((a, b) => a.start - b.start)
    expect(findFillers(words, 'en')).toEqual([])
  })
})

describe('pauses and cuts', () => {
  it('finds the stretches no one speaks in, between words', () => {
    const words = [...say('one two'), ...say('three', { at: 3 }), ...say('four', { at: 3.5, speaker: 1 }), ...say('five', { at: 6 })]
    const p = findPauses(words, 1.5)
    expect(p.map(x => [x.start, x.end])).toEqual([[0.7, 3], [3.8, 6]])
    expect(findPauses(words, 2.5)).toEqual([])
  })
  it('a long pause is shortened to the length chosen, the rest kept on both sides', () => {
    const [r] = fillerCutRanges([], [{ kind: 'pause', start: 10, end: 13 }], { keepPause: 0.5 })
    expect(r).toEqual([10.25, 12.75])
    expect(fillerCutRanges([], [{ kind: 'pause', start: 10, end: 10.4 }], { keepPause: 0.5 })).toEqual([])
  })
  it('a filler goes with the silence around it, leaving the longer of its two pauses', () => {
    const words = [...say('word'), ...say('um', { at: 0.5 }), ...say('next', { at: 1.6 })]
    // gaps: 0.2 before "um", 0.8 after it: the pause left is the longer one, 0.8
    const f = findFillers(words, 'en')
    const [r] = fillerCutRanges(words, f, { keepPause: 0.5 })
    expect(r[0]).toBeGreaterThanOrEqual(0.3)
    expect(r[0]).toBeLessThanOrEqual(0.5)
    expect(r[1]).toBeLessThanOrEqual(1.6)
    const left = (r[0] - 0.3) + (1.6 - r[1])
    expect(left).toBeCloseTo(0.8, 3)
    expect(cutLength([r])).toBeCloseTo(1.3 - 0.8, 3)
    // with the long pause after it ticked too, that pause is shortened as well
    const both = fillerCutRanges(words, [...f, ...findPauses(words, 0.6)], { keepPause: 0.3 })
    expect(cutLength(both)).toBeGreaterThan(cutLength([r]))
  })
})

describe('the review dialog', () => {
  const player = { playing: null, play: () => {}, stop: () => {} }
  it('lists the fillers and pauses, all ticked, with what the cut saves', () => {
    const words = [...say('Hello um, welcome.'), ...say('Today', { at: 4 })]
    const tr = { words, job: null, status: { available: true }, language: 'en', missingSeconds: 0, transcribe: () => {} }
    const html = renderToStaticMarkup(createElement(FillerReviewDialog, { tr, player, onApply: () => {}, onClose: () => {} }))
    expect(html).toContain('Remove fillers and pauses')
    expect(html).toContain('Fillers in English')
    expect(html).toMatch(/1 filler, 1 pause ticked/)
    expect(html).toContain('<strong>um,</strong>')
    expect(html).toMatch(/Pause<\/span> 2\.\ds/)
  })
  it('without a transcript it offers to make one', () => {
    const tr = { words: [], job: null, status: { available: true }, language: null, missingSeconds: 600, transcribe: () => {} }
    const html = renderToStaticMarkup(createElement(FillerReviewDialog, { tr, player, onApply: () => {}, onClose: () => {} }))
    expect(html).toContain('Transcribe the show first')
  })
})
