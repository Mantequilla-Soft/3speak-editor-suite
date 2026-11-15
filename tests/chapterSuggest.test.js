// Chapter ideas: topic shifts in a transcript (TextTiling), long pauses, scene
// changes; agreeing signals rank higher, suggestions keep apart from each
// other and from the chapters already there, and get titles from their words.
import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { topicShifts, suggestChapters, snapToPause, partTitles, contentTokens, stopWords } from '../src/utils/chapterSuggest'
import ChapterSuggestions from '../src/components/ChapterSuggestions'
import ChaptersDialog from '../src/components/ChaptersDialog'

// a seeded random, so the made-up show is the same every run
function rng(seed) {
  let s = seed
  return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648 }
}
const GLUE = 'the and we it is so that you to of a in this really think about what'.split(' ')
const TOPICS = [
  'hive witnesses voting proposals blocks governance stake witnesses voting'.split(' '),
  'pasta tomato garlic sauce kitchen basil pasta cooking oven'.split(' '),
  'football match goal team players season coach football stadium'.split(' ')
]
// three minutes per topic, about 2.5 words a second, no long pauses anywhere
function show(minutes = 3) {
  const r = rng(7)
  const words = []
  let t = 0
  TOPICS.forEach(vocab => {
    const end = t + minutes * 60
    while (t < end) {
      const pool = r() < 0.45 ? vocab : GLUE
      words.push({ text: pool[Math.floor(r() * pool.length)], start: Math.round(t * 1000) / 1000, end: Math.round((t + 0.3) * 1000) / 1000, speaker: 'badadib', speakerIndex: 0 })
      t += 0.4
    }
  })
  return { words, end: t }
}

describe('topic shifts', () => {
  it('finds where the talk moves to another subject', () => {
    const { words } = show()
    const shifts = topicShifts(words, { language: 'en' })
    expect(shifts.length).toBeGreaterThanOrEqual(2)
    for (const at of [180, 360]) expect(shifts.some(s => Math.abs(s.time - at) < 30)).toBe(true)
  })
  it('leaves stop words and fillers out; nothing for languages without spaces or too little talk', () => {
    expect(stopWords('en').has('the')).toBe(true)
    expect(stopWords('de').has('und')).toBe(true)
    expect(stopWords('en').has('um')).toBe(true)
    expect(contentTokens([{ text: 'The' }, { text: 'Witnesses,' }, { text: 'um' }], 'en').map(t => t.form)).toEqual(['witnesses'])
    expect(topicShifts(show().words, { language: 'ja' })).toEqual([])
    expect(topicShifts(show().words.slice(0, 50), { language: 'en' })).toEqual([])
  })
})

describe('suggestions', () => {
  it('from a transcript: an Intro at 0:00 and the topic changes, titled by their words', () => {
    const { words, end } = show()
    const s = suggestChapters({ words, end, language: 'en' })
    expect(s[0]).toMatchObject({ at: 0, title: 'Intro', reason: 'start' })
    const rest = s.slice(1)
    expect(rest.length).toBeGreaterThanOrEqual(2)
    const second = rest.find(x => Math.abs(x.at - 180) < 30)
    const third = rest.find(x => Math.abs(x.at - 360) < 30)
    expect(second.reason).toBe('topic')
    expect(second.title.toLowerCase()).toMatch(/pasta|tomato|garlic|sauce|kitchen|basil|cooking|oven/)
    expect(third.title.toLowerCase()).toMatch(/football|match|goal|team|players|season|coach|stadium/)
  })
  it('long pauses (measured from the sound when there are no words) and scene changes count too', () => {
    const p = suggestChapters({ end: 600, pauses: [{ start: 200, end: 204 }, { start: 400, end: 401 }], scenes: [{ t: 300, score: 35 }, { t: 450, score: 5 }] })
    expect(p.map(x => [Math.round(x.at), x.reason, x.title])).toEqual([[0, 'start', 'Intro'], [204, 'pause', 'Part 2'], [300, 'scene', 'Part 3']])
  })
  it('signals that agree rank first; suggestions keep their distance and keep away from existing chapters', () => {
    const s = suggestChapters({ end: 600, minGap: 100, pauses: [{ start: 250, end: 253 }, { start: 290, end: 293 }], scenes: [{ t: 292, score: 30 }] })
    // the pause at 293 has a scene change with it: it wins over the one at 253 (too close to keep both)
    const picked = s.filter(x => x.reason !== 'start')
    expect(picked.length).toBe(1)
    expect(Math.abs(picked[0].at - 292.5)).toBeLessThanOrEqual(0.5)
    expect(picked[0].reasons.sort()).toEqual(['pause', 'scene'])
    const taken = suggestChapters({ end: 600, existing: [{ at: 0 }, { at: 300 }], scenes: [{ t: 310, score: 40 }, { t: 450, score: 40 }] })
    expect(taken.map(x => x.at)).toEqual([450])
    expect(suggestChapters({ end: 20 })).toEqual([])
  })
  it('a chapter starts just before the words after the longest pause near the shift', () => {
    const words = [{ text: 'a', start: 10, end: 10.3 }, { text: 'b', start: 12, end: 12.3 }, { text: 'c', start: 12.5, end: 12.8 }]
    expect(snapToPause(words, 13, 5)).toBeCloseTo(11.6, 3)
    expect(snapToPause(words, 100, 5)).toBe(100)
    expect(partTitles(show().words, [0, 180, 360], 540, 'en')[0].toLowerCase()).toMatch(/witnesses|voting|hive|proposals|governance|stake|blocks/)
  })
})

describe('in the Chapters dialog', () => {
  it('shows a Suggest button under the chapters', () => {
    const node = createElement(ChapterSuggestions, { tracks: [], words: [], language: 'en', end: 600, resolved: [], sourceOf: () => null, player: null, onAccept: () => {}, onSeek: () => {} })
    const html = renderToStaticMarkup(createElement(ChaptersDialog, { resolved: [], spans: [], playheadPosition: 0, onAdd: () => {}, onRename: () => {}, onMove: () => {}, onRemove: () => {}, onSeek: () => {}, onClose: () => {}, suggestions: node }))
    expect(html).toContain('Suggest chapters')
    expect(html).toContain('With a transcript')
  })
})
