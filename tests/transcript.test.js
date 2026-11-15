// Edit by text: the transcript pinned to the recordings (it follows every cut
// and comes back with undo), the parts still to listen to, paragraphs by
// speaker, and selected words -> the stretches to cut, which rippleCutRanges
// takes out of every track (speech split, links kept, music played on).
import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  addChunk, cleanTranscript, placeWords, neededRanges, neededSeconds, paragraphsOf, cutRangesForWords, wordAt,
  mergeRanges, subtractRanges, speechClips, transcriptText, emptyTranscript
} from '../src/utils/transcript'
import { rippleCutRanges, cutLength } from '../src/utils/ripple'
import { serializeProject } from '../src/hooks/useDrafts'
import TranscriptPanel from '../src/components/TranscriptPanel'
import { rowOffsets, visibleRows, rowAt, estimateHeight } from '../src/utils/virtualList'

const clip = (id, libraryId, at, from, to, extra = {}) => ({ id, libraryId, type: 'audio', url: `/api/upload/files/${libraryId}.mp3`, serverUrl: `/api/upload/files/${libraryId}.mp3`, timelinePosition: at, startTime: from, endTime: to, duration: 600, ...extra })
// host and guest on their own voice tracks, music under them
const show = () => [
  { id: 'v1', type: 'audio', name: 'badadib', clips: [clip('h1', 'lib_host', 0, 0, 20)] },
  { id: 'v2', type: 'audio', name: 'Guest', clips: [clip('g1', 'lib_guest', 0, 0, 20)] },
  { id: 'm', type: 'audio', name: 'Music', music: true, clips: [clip('bed', 'lib_bed', 0, 0, 30, { type: 'audio' })] }
]
const W = (text, start, end) => ({ text, start, end })
const withWords = () => {
  let t = addChunk(null, { source: 'lib_host', from: 0, to: 20, words: [W('Hello', 0.5, 0.9), W('everyone,', 1, 1.5), W('um,', 2, 2.3), W('welcome', 3, 3.5), W('back.', 3.6, 4)] }, 'en')
  t = addChunk(t, { source: 'lib_guest', from: 0, to: 20, words: [W('Thanks', 6, 6.4), W('for', 6.5, 6.7), W('having', 6.8, 7.1), W('me.', 7.2, 7.5)] })
  return t
}

describe('the transcript, pinned to the recordings', () => {
  it('chunks merge in by file and stretch; a chunk listened to again replaces its words', () => {
    let t = withWords()
    expect(t.language).toBe('en')
    expect(t.sources.lib_host.w.map(w => w[0])).toEqual(['Hello', 'everyone,', 'um,', 'welcome', 'back.'])
    expect(t.sources.lib_host.covered).toEqual([[0, 20]])
    t = addChunk(t, { source: 'lib_host', from: 0, to: 2.5, words: [W('Hi', 0.5, 0.8)] })
    expect(t.sources.lib_host.w.map(w => w[0])).toEqual(['Hi', 'welcome', 'back.'])
    expect(t.sources.lib_host.covered).toEqual([[0, 20]])
  })

  it('words are placed by speaker (each voice track) in time; a draft keeps them compact', () => {
    const words = placeWords(show(), withWords())
    expect(words.map(w => w.text).join(' ')).toBe('Hello everyone, um, welcome back. Thanks for having me.')
    expect(words[0]).toMatchObject({ speaker: 'badadib', speakerIndex: 0, trackId: 'v1', clipId: 'h1', start: 0.5 })
    expect(words[5]).toMatchObject({ speaker: 'Guest', speakerIndex: 1 })
    // music is no speaker
    expect(speechClips(show()).map(s => s.clip.id)).toEqual(['h1', 'g1'])
    const { state } = serializeProject(show(), [], new Map(), { mode: 'audio', transcript: withWords() })
    expect(state.transcript.sources.lib_host.w[0]).toEqual(['Hello', 0.5, 0.9])
    expect(cleanTranscript(JSON.parse(JSON.stringify(state.transcript)))).toEqual(withWords())
    // a recording that left the timeline is not saved with it
    const { state: s2 } = serializeProject(show().slice(1), [], new Map(), { mode: 'audio', transcript: withWords() })
    expect(Object.keys(s2.transcript.sources)).toEqual(['lib_guest'])
    expect(serializeProject(show(), [], new Map(), {}).state.transcript).toBeUndefined()
  })

  it('a cut moves the words after it and hides the ones cut; the old tracks (undo) bring them back', () => {
    const before = show()
    const words = placeWords(before, withWords())
    // select "um," (index 2): the cut runs from its start to just before "welcome"
    const ranges = cutRangesForWords(words, [2])
    expect(ranges.length).toBe(1)
    expect(ranges[0][0]).toBeGreaterThanOrEqual(1.5)
    expect(ranges[0][0]).toBeLessThanOrEqual(2)
    expect(ranges[0][1]).toBeCloseTo(2.97, 2)
    const { tracks: after, copies } = rippleCutRanges(before, ranges)
    const placed = placeWords(after, withWords())
    expect(placed.map(w => w.text)).not.toContain('um,')
    const len = cutLength(ranges)
    expect(placed.find(w => w.text === 'welcome').start).toBeCloseTo(3 - len, 3)
    expect(placed.find(w => w.text === 'Thanks').start).toBeCloseTo(6 - len, 3) // the guest moved with the cut
    // both voices were split at the same place and the pieces after the cut are linked to their file
    expect(after[0].clips.length).toBe(2)
    expect(after[1].clips.length).toBe(2)
    expect(copies.map(c => c[1]).sort()).toEqual(['g1', 'h1'])
    // the music bed plays on, shorter by the cut
    expect(after[2].clips[0]).toMatchObject({ timelinePosition: 0, startTime: 0 })
    expect(after[2].clips[0].endTime).toBeCloseTo(30 - len, 3)
    // undo puts the old tracks back: the word is there again
    expect(placeWords(before, withWords()).map(w => w.text)).toContain('um,')
  })

  it('what is still to listen to: the used parts of each recording the transcript does not cover', () => {
    const tracks = show()
    expect(neededRanges(tracks, null).map(e => [e.libraryId, e.ranges])).toEqual([['lib_host', [[0, 21]]], ['lib_guest', [[0, 21]]]])
    const t = withWords()
    expect(neededRanges(tracks, t).map(e => e.ranges)).toEqual([[[20, 21]], [[20, 21]]])
    // a trim pulled out further: only the new part
    const longer = tracks.map(tr => (tr.id === 'v1' ? { ...tr, clips: [{ ...tr.clips[0], endTime: 80 }] } : tr))
    const need = neededRanges(longer, t)
    expect(need[0]).toMatchObject({ libraryId: 'lib_host', clipId: 'h1', ranges: [[20, 81]] })
    expect(Math.round(neededSeconds(need))).toBe(62)
    expect(subtractRanges([[0, 10]], [[2, 3], [5, 6]])).toEqual([[0, 2], [3, 5], [6, 10]])
    expect(mergeRanges([[5, 6], [0, 1], [1.02, 2]])).toEqual([[0, 2], [5, 6]])
  })

  it('a video and its own sound (same recording, same moment) give each word once', () => {
    const tracks = [
      { id: 'vt', type: 'video', clips: [{ ...clip('v', 'lib_v', 0, 0, 10), type: 'video', audioEnabled: true }] },
      { id: 'a1', type: 'audio', name: 'Voice', clips: [clip('va', 'lib_v', 0, 0, 10)] }
    ]
    const t = addChunk(null, { source: 'lib_v', from: 0, to: 10, words: [W('one', 1, 1.3), W('two', 2, 2.3)] })
    expect(placeWords(tracks, t).map(w => w.text)).toEqual(['one', 'two'])
  })

  it('paragraphs break at a new speaker and at long pauses; the playing word is found by time', () => {
    const words = placeWords(show(), withWords())
    const paras = paragraphsOf(words)
    expect(paras.map(p => [p.speaker, p.from, p.to])).toEqual([['badadib', 0, 4], ['Guest', 5, 8]])
    expect(wordAt(words, 0)).toBe(-1)
    expect(wordAt(words, 3.2)).toBe(3)
    expect(wordAt(words, 100)).toBe(8)
    expect(transcriptText(words, paras)).toMatch(/^badadib \(0:00\): Hello everyone/)
  })

  it('a run of selected words is one stretch; separate runs are separate stretches', () => {
    const words = placeWords(show(), withWords())
    const two = cutRangesForWords(words, [0, 1, 3])
    expect(two.length).toBe(2)
    // never into the word before or after
    expect(two[0][0]).toBeGreaterThanOrEqual(0.45)
    expect(two[0][1]).toBeLessThan(2)
    expect(two[1][0]).toBeGreaterThanOrEqual(2.3)
    expect(two[1][1]).toBeLessThan(3.6)
    expect(cutRangesForWords(words, [])).toEqual([])
  })

  it('a retimed clip maps its words through its time map (2x: twice as fast); a freeze frame has none', () => {
    const t = addChunk(null, { source: 'lib_v', from: 0, to: 40, words: [W('one', 2, 2.4), W('two', 10, 10.4), W('three', 30, 30.4)] })
    // 2x from media 0..20: clip time 0..10, on the timeline at 5
    const fast = [{ id: 'a1', type: 'audio', name: 'Voice', clips: [{ ...clip('c', 'lib_v', 5, 0, 10), speed: 2 }] }]
    const words = placeWords(fast, t)
    expect(words.map(w => [w.text, w.start, w.end])).toEqual([['one', 6, 6.2], ['two', 10, 10.2]])
    // what is still to listen to is in the file's seconds: 0..20 (plus the pad)
    expect(neededRanges(fast, null)[0].ranges).toEqual([[0, 21]])
    // a cut over "two" lands on the timeline where it shows, and the words after it move
    const ranges = cutRangesForWords(words, [1])
    expect(ranges[0][0]).toBeGreaterThan(9.9)
    const after = rippleCutRanges(fast, [[9.97, 10.3]]).tracks
    expect(placeWords(after, t).map(w => w.text)).toEqual(['one'])
    const frozen = [{ id: 'a1', type: 'audio', name: 'Voice', clips: [{ ...clip('c', 'lib_v', 0, 0, 10), freezeAt: 10 }] }]
    expect(placeWords(frozen, t)).toEqual([])
    expect(neededRanges(frozen, null)).toEqual([])
  })

  it('old drafts and broken data: no transcript', () => {
    expect(cleanTranscript(null)).toBe(null)
    expect(cleanTranscript({ sources: 'x' })).toBe(null)
    expect(cleanTranscript({ sources: { a: { w: [['', 1, 2], ['ok', 'x', 2], ['fine', 1, 0]] } } }).sources.a.w).toEqual([['fine', 1, 1.2]])
    expect(placeWords(show(), emptyTranscript())).toEqual([])
  })
})

describe('rippleCutRanges', () => {
  const video = () => [
    { id: 'vt', type: 'video', clips: [
      { id: 'v', type: 'video', libraryId: 'L', timelinePosition: 0, startTime: 0, endTime: 10, groupId: 'g1' },
      { id: 'txt', type: 'text', timelinePosition: 2, startTime: 0, endTime: 6 },
      { id: 'v2', type: 'video', libraryId: 'M', timelinePosition: 10, startTime: 0, endTime: 5 }
    ] },
    { id: 'at', type: 'audio', clips: [{ id: 'a', type: 'audio', libraryId: 'L', timelinePosition: 0, startTime: 0, endTime: 10, groupId: 'g1', fadeIn: 0.5, fadeOut: 0.5 }] },
    { id: 'sfx', type: 'audio', sfx: true, clips: [{ id: 's', type: 'audio', timelinePosition: 12, startTime: 0, endTime: 1 }] }
  ]
  const find = (tracks, id) => tracks.flatMap(t => t.clips).find(c => c.id === id)

  it('splits the video and its sound at the same place, keeps the two linked piece by piece', () => {
    let n = 0
    const { tracks, copies } = rippleCutRanges(video(), [[3, 5]], { newId: () => `new${++n}`, newGroupId: () => 'g2' })
    const v = tracks[0].clips.filter(c => c.type === 'video')
    expect(v.map(c => [c.id, c.timelinePosition, c.startTime, c.endTime, c.groupId])).toEqual([['v', 0, 0, 3, 'g1'], ['new1', 3, 5, 10, 'g2'], ['v2', 8, 0, 5, undefined]])
    const a = tracks[1].clips
    expect(a.map(c => [c.timelinePosition, c.startTime, c.endTime, c.groupId, c.fadeIn, c.fadeOut])).toEqual([[0, 0, 3, 'g1', 0.5, 0], [3, 5, 10, 'g2', 0, 0.5]])
    expect(copies).toEqual([['new1', 'v'], ['new2', 'a']])
    // the title keeps its start and plays on, 2 s shorter; the sound effect after the cut moves left
    expect(find(tracks, 'txt')).toMatchObject({ timelinePosition: 2, endTime: 4 })
    expect(find(tracks, 's').timelinePosition).toBe(10)
  })

  it('several stretches at once (overlapping ones joined); a clip wholly inside one goes', () => {
    const { tracks } = rippleCutRanges(video(), [[11, 12], [10, 11.5], [0.5, 1]])
    expect(find(tracks, 'v2')).toMatchObject({ startTime: 2, endTime: 5, timelinePosition: 9.5 })
    const out = rippleCutRanges([{ id: 't', type: 'audio', clips: [{ id: 'x', type: 'audio', timelinePosition: 2, startTime: 0, endTime: 1 }] }], [[1, 4]])
    expect(out.tracks[0].clips).toEqual([])
    expect(rippleCutRanges(video(), []).tracks).toEqual(video())
    expect(cutLength([[0, 2], [1, 3], [5, 6]])).toBe(4)
  })
})

describe('the transcript panel', () => {
  const tr = (extra) => ({ words: [], paragraphs: [], job: null, status: { available: true, languages: ['auto', 'en'] }, missingSeconds: 1260, count: 0, language: null, transcribe: () => {}, cancel: () => {}, ...extra })
  it('offers to transcribe with the length of what it will listen to', () => {
    const html = renderToStaticMarkup(createElement(TranscriptPanel, { tr: tr(), onSeek: () => {}, onCut: () => {} }))
    expect(html).toContain('Transcribe (21 min of recording)')
  })
  it('shows the words by speaker, the playing one marked', () => {
    const words = placeWords(show(), withWords())
    const html = renderToStaticMarkup(createElement(TranscriptPanel, { tr: tr({ words, paragraphs: paragraphsOf(words), missingSeconds: 0, count: 9 }), playheadPosition: 3.2, onSeek: () => {}, onCut: () => {} }))
    expect(html).toContain('badadib')
    expect(html).toContain('Guest')
    expect(html).toMatch(/class="transcript-word active"[^>]*>welcome</)
    expect(html).toContain('9 words')
  })
  it('says when the server has no speech to text', () => {
    const html = renderToStaticMarkup(createElement(TranscriptPanel, { tr: tr({ status: { available: false } }), onSeek: () => {}, onCut: () => {} }))
    expect(html).toContain('not available')
  })
})

describe('the window of a long list', () => {
  it('draws only the rows in sight, and a few around them', () => {
    const offsets = rowOffsets(10000, () => 50)
    expect(offsets[10000]).toBe(500000)
    expect(rowAt(offsets, 0)).toBe(0)
    expect(rowAt(offsets, 125)).toBe(2)
    const { from, to } = visibleRows(offsets, 100000, 600, 200)
    expect(from).toBe(1996)
    expect(to).toBe(2016)
    expect(visibleRows(rowOffsets(0, () => 1), 0, 600)).toEqual({ from: 0, to: -1 })
    expect(estimateHeight(100)).toBeGreaterThan(estimateHeight(10))
  })
})
