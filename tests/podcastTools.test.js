import { describe, it, expect } from 'vitest'
import { voiceSpans, duckPlan, duckGainAt, duckGain, DUCK_ATTACK, DUCK_RELEASE } from '../src/utils/duck'
import {
  anchorAt, anchorPosition, newChapter, moveChapter, resolveChapters, chapterSpans, chapterTime, chaptersText, cleanTitle
} from '../src/utils/chapters'
import { applyGroupCut } from '../src/utils/groupSilence'
import { applyAudioTemplate } from '../src/utils/audioTemplate'
import { serializeProject } from '../src/hooks/useDrafts'

const clip = (id, extra = {}) => ({ id, type: 'audio', name: id, url: `/api/upload/files/${id}.mp3`, serverUrl: `/api/upload/files/${id}.mp3`, libraryId: `lib_${id}`, startTime: 0, endTime: 10, timelinePosition: 0, ...extra })
const voice = (id, clips, extra = {}) => ({ id, type: 'audio', name: id, clips, ...extra })
const music = (id, clips, extra = {}) => ({ id, type: 'audio', name: id, music: true, clips, ...extra })

describe('auto-duck', () => {
  it('voiceSpans merges gaps shorter than a whole ramp, skips music, template parts, muted and silent clips', () => {
    const tracks = [
      voice('v', [clip('a', { endTime: 2 }), clip('b', { endTime: 2, timelinePosition: 2.5 }), clip('c', { endTime: 1, timelinePosition: 10 })]),
      voice('v2', [clip('off', { endTime: 30, audioEnabled: false }), clip('intro', { endTime: 5, timelinePosition: 40, templateRole: 'intro' })]),
      voice('muted', [clip('m', { endTime: 30 })], { muted: true }),
      music('bed', [clip('bed', { endTime: 60 })])
    ]
    expect(voiceSpans(tracks)).toEqual([[0, 4.5], [10, 11]])
  })

  it('duckPlan: off, no music or no voice gives null; otherwise the music tracks and spans', () => {
    const tracks = [voice('v', [clip('a', { endTime: 3, timelinePosition: 1 })]), music('m', [clip('bed', { endTime: 20 })])]
    expect(duckPlan(tracks, { duck: false })).toBeNull()
    expect(duckPlan([tracks[0]], { duck: true })).toBeNull()
    expect(duckPlan([tracks[1]], { duck: true })).toBeNull()
    expect(duckPlan([tracks[0], { ...tracks[1], muted: true }], { duck: true })).toBeNull()
    const plan = duckPlan(tracks, { duck: true, duckDb: -12 })
    expect(plan).toEqual({ gain: 0.2512, attack: DUCK_ATTACK, release: DUCK_RELEASE, spans: [[1, 4]], tracks: ['m'] })
    expect(duckPlan(tracks, { duck: true }).gain).toBe(0.2512) // default depth
    expect(duckGain(-6)).toBeCloseTo(0.501, 3)
  })

  it('duckGainAt ramps down before the voice, stays down, comes back up after', () => {
    const plan = { gain: 0.25, attack: 0.4, release: 0.8, spans: [[2, 5], [10, 12]], tracks: ['m'] }
    expect(duckGainAt(plan, 0)).toBe(1)
    expect(duckGainAt(plan, 1.6)).toBe(1)
    expect(duckGainAt(plan, 1.8)).toBeCloseTo(0.625, 6)
    expect(duckGainAt(plan, 2)).toBeCloseTo(0.25, 9)
    expect(duckGainAt(plan, 4.9)).toBeCloseTo(0.25, 9)
    expect(duckGainAt(plan, 5.4)).toBeCloseTo(0.625, 6)
    expect(duckGainAt(plan, 7)).toBe(1)
    expect(duckGainAt(plan, 11)).toBeCloseTo(0.25, 9)
    expect(duckGainAt(plan, 20)).toBe(1)
    expect(duckGainAt(null, 3)).toBe(1)
  })

  it('the backend expression (audioRender.js duckExpr) gives the same values', async () => {
    const { duckExpr } = await import('../backend/src/services/audioRender.js')
    const plan = { gain: 0.25, attack: 0.4, release: 0.8, spans: [[2, 5], [10, 12]], tracks: ['m'] }
    const f = new Function('t', 'clip', 'min', `return ${duckExpr(plan)}`)
    const clamp = (x, a, b) => Math.min(b, Math.max(a, x))
    for (let t = 0; t < 14; t += 0.137) expect(f(t, clamp, Math.min)).toBeCloseTo(duckGainAt(plan, t), 6)
  })
})

describe('chapters', () => {
  const rec = clip('rec', { endTime: 100 })
  const tracks = [voice('v', [rec]), music('m', [clip('song', { endTime: 100 })])]

  it('pins a chapter to the recording under it, not over music or a gap', () => {
    expect(anchorAt(tracks, 42.5)).toEqual({ libraryId: 'lib_rec', t: 42.5 })
    expect(anchorAt(tracks, 150)).toBeNull()
    expect(anchorAt([music('m', [clip('song', { endTime: 100 })])], 10)).toBeNull()
    const intro = [voice('v', [clip('i', { endTime: 5, templateRole: 'intro' }), clip('rec', { timelinePosition: 5, endTime: 100 })])]
    expect(anchorAt(intro, 2)).toBeNull()
    expect(anchorAt(intro, 7)).toEqual({ libraryId: 'lib_rec', t: 2 })
  })

  it('follows the recording through Cut silences (and lands on the next piece when its moment was cut)', () => {
    const ch = newChapter(tracks, 40, 'Questions', 'c1')
    const cut = [voice('v', [
      clip('rec', { startTime: 0, endTime: 20, timelinePosition: 0 }),
      clip('p2', { libraryId: 'lib_rec', startTime: 30, endTime: 45, timelinePosition: 20 }),
      clip('p3', { libraryId: 'lib_rec', startTime: 50, endTime: 100, timelinePosition: 35 })
    ])]
    expect(anchorPosition(cut, ch.anchor)).toBe(30) // 40 in the file = 10 into the piece at 20
    expect(anchorPosition(cut, { libraryId: 'lib_rec', t: 47 })).toBe(35) // cut out: the next piece
    expect(anchorPosition(cut, { libraryId: 'lib_rec', t: 120 })).toBe(85) // past the end: where it ends
    expect(anchorPosition(cut, { libraryId: 'gone', t: 3 })).toBeNull()
  })

  it('follows a template intro being put in front', () => {
    const ch = newChapter(tracks, 40, 'Questions', 'c1')
    const tpl = { slots: { intro: { url: '/api/upload/files/intro.mp3', name: 'Intro', duration: 8, startTime: 0, endTime: 8 } } }
    const withIntro = applyAudioTemplate(tracks, tpl, { newId: (p) => `${p}_x` })
    expect(resolveChapters(withIntro, [ch])).toEqual([{ id: 'c1', title: 'Questions', at: 48 }])
  })

  it('follows a group cut of two voices', () => {
    const two = [voice('host', [clip('h', { endTime: 10, groupId: 'g' })]), voice('guest', [clip('g', { endTime: 10, groupId: 'g' })])]
    const ch = newChapter(two, 7, 'Guest answers', 'c2')
    let n = 0
    const { tracks: after } = applyGroupCut(two, ['h', 'g'], [{ start: 0, end: 2 }, { start: 5, end: 10 }], { newId: () => `n${++n}`, newGroupId: () => `gg${++n}` })
    expect(resolveChapters(after, [ch])[0].at).toBe(4)
  })

  it('resolves by time, clamps to the timeline, keeps unpinned ones where they were', () => {
    const list = [
      { id: 'b', title: '  Second   part ', at: 50, anchor: { libraryId: 'lib_rec', t: 50 } },
      { id: 'a', title: '', at: 0, anchor: null },
      { id: 'z', title: 'Late', at: 500, anchor: null }
    ]
    expect(resolveChapters(tracks, list, 100)).toEqual([
      { id: 'a', title: 'Chapter', at: 0 },
      { id: 'b', title: 'Second part', at: 50 },
      { id: 'z', title: 'Late', at: 100 }
    ])
  })

  it('moveChapter pins it again where it is moved to', () => {
    const ch = newChapter(tracks, 10, 'Intro', 'c1')
    expect(moveChapter(tracks, ch, 25)).toEqual({ id: 'c1', title: 'Intro', at: 25, anchor: { libraryId: 'lib_rec', t: 25 } })
  })

  it('chapterSpans: each to the next, the last to the end, too short or at the end dropped', () => {
    const spans = chapterSpans([
      { id: 'a', title: 'Intro', at: 0 },
      { id: 'b', title: 'Too close', at: 0.4 },
      { id: 'c', title: 'Talk', at: 30 },
      { id: 'd', title: 'At the end', at: 99.5 }
    ], 100)
    expect(spans).toEqual([{ start: 0, end: 30, title: 'Intro' }, { start: 30, end: 100, title: 'Talk' }])
    expect(chapterSpans([], 100)).toEqual([])
  })

  it('writes times the way chapter lists do', () => {
    expect(chapterTime(0)).toBe('0:00')
    expect(chapterTime(75.9)).toBe('1:15')
    expect(chapterTime(3723)).toBe('1:02:03')
    expect(chaptersText([{ start: 0, title: 'Intro' }, { start: 760, title: 'Questions' }])).toBe('0:00 Intro\n12:40 Questions')
    expect(cleanTitle(`a\n${'b'.repeat(200)}`).length).toBe(80)
  })

  it('drafts keep the chapters and the duck setting (audio editor only)', () => {
    const chapters = [newChapter(tracks, 40, 'Questions', 'c1')]
    const { state } = serializeProject(tracks, [], new Map(), { mode: 'audio', master: { loudness: true, duck: true, duckDb: -18 }, chapters })
    expect(state.master).toEqual({ loudness: true, duck: true, duckDb: -18 })
    expect(state.chapters).toEqual(chapters)
    const video = serializeProject(tracks, [], new Map(), { mode: 'video', chapters }).state
    expect(video.chapters).toBeUndefined()
  })
})
