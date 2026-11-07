import { describe, it, expect, vi } from 'vitest'
import { groupSpan, combineLoudness, applyGroupCut, overlappingVoices } from '../src/utils/groupSilence'
import { planCuts } from '../src/utils/silenceDetect'
import { GroupPlayer } from '../src/utils/groupPlayer'

const STEP = 0.02
// A loudness curve from [seconds, loud?] stretches (file time)
const curve = (...stretches) => {
  const total = stretches.reduce((s, [d]) => s + d, 0)
  const db = new Float32Array(Math.round(total / STEP))
  let w = 0
  for (const [d, loud] of stretches) for (let i = 0; i < Math.round(d / STEP); i++) db[w++] = loud ? -12 : -80
  return { db, step: STEP, duration: total }
}
const clip = (id, extra = {}) => ({ id, type: 'audio', name: id, url: `blob:${id}`, startTime: 0, endTime: 10, timelinePosition: 0, ...extra })
let n = 0
const ids = { newId: () => `new${++n}`, newGroupId: () => `g${++n}` }

// Host talks 0-2 and 6-8, guest talks 3-5; both quiet 2-3, 5-6 and 8-10
const host = clip('host', { groupId: 'pod' })
const guest = clip('guest', { groupId: 'pod' })
const hostL = curve([2, true], [4, false], [2, true], [2, false])
const guestL = curve([3, false], [2, true], [5, false])
const settings = { thresholdDb: -40, minSilence: 0.5, keepStartMs: 0, keepEndMs: 0, mode: 'remove' }

describe('combineLoudness', () => {
  it('is the loudest voice at every moment, in timeline time', () => {
    const c = combineLoudness([{ clip: host, loudness: hostL }, { clip: guest, loudness: guestL }])
    const at = (t) => c.db[Math.floor(t / STEP)]
    expect(at(1)).toBe(-12)   // host
    expect(at(4)).toBe(-12)   // guest
    expect(at(2.5)).toBe(-80) // both quiet
    expect(at(7)).toBe(-12)
    expect(at(9)).toBe(-80)
  })

  it("follows each clip's position and in-point (guest file starts 1 s later, trimmed by 0.5 s)", () => {
    const late = clip('late', { timelinePosition: 1, startTime: 0.5, endTime: 3 })
    const c = combineLoudness([{ clip: late, loudness: curve([1.5, false], [1, true], [1, false]) }])
    const at = (t) => c.db[Math.floor(t / STEP)]
    expect(at(1.5)).toBe(-80) // file 1.0 s
    expect(at(2.2)).toBe(-12) // file 1.7 s
    expect(at(0.5)).toBe(-90) // before the clip: nobody
  })

  it('a pause is only found where everyone is quiet', () => {
    const { from, to } = groupSpan([host, guest])
    const { silences } = planCuts(combineLoudness([{ clip: host, loudness: hostL }, { clip: guest, loudness: guestL }]), { from, to, ...settings })
    expect(silences.map(s => [+s.start.toFixed(2), +s.end.toFixed(2)])).toEqual([[2, 3], [5, 6], [8, 10]])
  })
})

describe('applyGroupCut', () => {
  const tracks = () => [
    { id: 'v1', type: 'audio', name: 'Host', clips: [{ ...host }] },
    { id: 'v2', type: 'audio', name: 'Guest', clips: [{ ...guest }] },
    { id: 'm', type: 'audio', name: 'Music', music: true, clips: [clip('after', { timelinePosition: 12, endTime: 3 }), clip('under', { timelinePosition: 0, endTime: 10 })] }
  ]
  const keep = [{ start: 0, end: 2 }, { start: 3, end: 5 }, { start: 6, end: 8 }]

  it('cuts the same stretches out of every voice and packs them, so the voices stay in sync', () => {
    const { tracks: out, copies } = applyGroupCut(tracks(), ['host', 'guest'], keep, ids)
    const shape = (t) => out.find(x => x.id === t).clips.map(c => [c.timelinePosition, c.startTime, c.endTime])
    expect(shape('v1')).toEqual([[0, 0, 2], [2, 3, 5], [4, 6, 8]])
    expect(shape('v2')).toEqual([[0, 0, 2], [2, 3, 5], [4, 6, 8]])
    expect(copies).toHaveLength(4)
  })

  it('the pieces of one stretch share a group (move one voice, the other follows); stretches differ', () => {
    const { tracks: out } = applyGroupCut(tracks(), ['host', 'guest'], keep, ids)
    const h = out[0].clips
    const g = out[1].clips
    h.forEach((c, i) => expect(c.groupId).toBe(g[i].groupId))
    expect(new Set(h.map(c => c.groupId)).size).toBe(3)
  })

  it('what comes after the group moves left by what was cut; what lies under it stays', () => {
    const { tracks: out } = applyGroupCut(tracks(), ['host', 'guest'], keep, ids)
    const music = out.find(x => x.id === 'm').clips
    expect(music.find(c => c.id === 'after').timelinePosition).toBe(8)
    expect(music.find(c => c.id === 'under').timelinePosition).toBe(0)
  })

  it('voices with their own offset in the file keep it', () => {
    const t = [{ id: 'a', type: 'audio', clips: [clip('x', { startTime: 5, endTime: 15, groupId: 'p' })] }, { id: 'b', type: 'audio', clips: [clip('y', { groupId: 'p' })] }]
    const { tracks: out } = applyGroupCut(t, ['x', 'y'], [{ start: 1, end: 3 }], ids)
    expect(out[0].clips[0]).toMatchObject({ startTime: 6, endTime: 8, timelinePosition: 0 })
    expect(out[1].clips[0]).toMatchObject({ startTime: 1, endTime: 3, timelinePosition: 0 })
  })

  it('without closing gaps every piece stays where it was', () => {
    const { tracks: out } = applyGroupCut(tracks(), ['host', 'guest'], keep, { ...ids, closeGaps: false })
    expect(out[0].clips.map(c => c.timelinePosition)).toEqual([0, 3, 6])
    expect(out.find(x => x.id === 'm').clips.find(c => c.id === 'after').timelinePosition).toBe(12)
  })

  it('fades stay at the outer ends only', () => {
    const t = [{ id: 'a', type: 'audio', clips: [clip('x', { fadeIn: 1, fadeOut: 2 })] }]
    const { tracks: out } = applyGroupCut(t, ['x'], keep, ids)
    expect(out[0].clips.map(c => [c.fadeIn, c.fadeOut])).toEqual([[1, 0], [0, 0], [0, 0]])
  })

  it('nothing to keep or no members: unchanged', () => {
    const t = tracks()
    expect(applyGroupCut(t, ['host'], [], ids).tracks).toBe(t)
    expect(applyGroupCut(t, ['nope'], keep, ids).tracks).toBe(t)
  })
})

describe('overlappingVoices', () => {
  const t = [
    { id: 'v1', type: 'audio', clips: [clip('a', { endTime: 10 }), clip('a2', { timelinePosition: 30, endTime: 5 })] },
    { id: 'v2', type: 'audio', clips: [clip('b', { timelinePosition: 4, endTime: 10 }), clip('c', { timelinePosition: 20, endTime: 5 })] },
    { id: 'm', type: 'audio', music: true, clips: [clip('song', { endTime: 60 })] },
    { id: 'v3', type: 'audio', clips: [{ ...clip('jingle'), templateRole: 'intro' }] }
  ]
  it('the clip and what overlaps it on the other voice tracks; never music or template parts', () => {
    expect(overlappingVoices(t, 'a').sort()).toEqual(['a', 'b'])
  })
  it('a clip on a music track is not a voice', () => {
    expect(overlappingVoices(t, 'song')).toEqual([])
  })
  it('its own group comes along', () => {
    const g = t.map(tr => ({ ...tr, clips: tr.clips.map(c => (c.id === 'a2' || c.id === 'a' ? { ...c, groupId: 'k' } : c)) }))
    expect(overlappingVoices(g, 'a').sort()).toEqual(['a', 'a2', 'b'])
  })
})

describe('GroupPlayer', () => {
  const el = () => ({ paused: true, currentTime: 0, volume: 1, play: vi.fn(function () { this.paused = false; return Promise.resolve() }), pause: vi.fn(function () { this.paused = true }) })
  it('plays each voice where its clip is, at the right point of its file, on one clock', () => {
    let now = 0
    const a = el(); const b = el()
    const states = []
    const p = new GroupPlayer([
      { el: a, position: 0, startTime: 0, endTime: 4, volume: 0.5 },
      { el: b, position: 2, startTime: 10, endTime: 14, volume: 1 }
    ], { onState: s => states.push(s), now: () => now })
    p.currentTime = 1
    p.play()
    expect(a.paused).toBe(false); expect(a.currentTime).toBe(1); expect(a.volume).toBe(0.5)
    expect(b.paused).toBe(true)
    now = 1500 // 1.5 s later: t = 2.5, guest has started at file 10.5
    expect(p.currentTime).toBeCloseTo(2.5)
    expect(b.paused).toBe(false); expect(b.currentTime).toBeCloseTo(10.5)
    now = 3500 // t = 4.5: host clip over
    p.currentTime
    expect(a.paused).toBe(true)
    p.pause()
    expect(p.paused).toBe(true)
    expect(b.paused).toBe(true)
    expect(states).toEqual([true, false])
    expect(p.currentTime).toBeCloseTo(4.5)
  })
  it('corrects a voice that drifts', () => {
    let now = 0
    const a = el()
    const p = new GroupPlayer([{ el: a, position: 0, startTime: 0, endTime: 10 }], { now: () => now })
    p.play()
    now = 2000
    a.currentTime = 1.5 // lagging 0.5 s
    p.currentTime
    expect(a.currentTime).toBeCloseTo(2)
  })
})
