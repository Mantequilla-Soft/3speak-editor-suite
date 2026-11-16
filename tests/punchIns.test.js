// Automatic punch-ins (utils/punchIns.js): moments from caption words or the
// loudness curve, turned into tagged Scale keyframes that come off in one go.
import { describe, it, expect } from 'vitest'
import { propAt, keyframesOf } from '../src/utils/keyframes'
import { sentenceStarts, planPunchIns, punchInUpdates, hasPunchIns, removePunchIns, loudnessMoments, pickMoments, PUNCH } from '../src/utils/punchIns'

const video = (extra = {}) => ({ id: 'v1', type: 'video', name: 'badadib take', duration: 20, startTime: 2, endTime: 8, timelinePosition: 0, groupId: 'g1', ...extra })

describe('punch-ins', () => {
  const words = [
    { text: 'Hi', start: 0.2, end: 0.4 }, { text: 'there.', start: 0.45, end: 0.8 },
    { text: 'Today', start: 1.0, end: 1.3 }, { text: 'we', start: 1.35, end: 1.5 }, { text: 'build', start: 1.55, end: 1.9 },
    { text: 'stuff', start: 3.6, end: 3.9 }, { text: 'and', start: 4.0, end: 4.1 }, { text: 'more.', start: 4.2, end: 4.5 },
    { text: 'Next', start: 6.5, end: 6.8 }, { text: 'part', start: 6.85, end: 7.2 }
  ]
  const clip = video({ startTime: 0, endTime: 10, timelinePosition: 0, zoom: 100 })

  it('sentence starts come from pauses and full stops', () => {
    expect(sentenceStarts(words, 0, 10)).toEqual([0.2, 1.0, 3.6, 6.5])
  })

  it('moments are spread out and keep clear of the clip\'s last second', () => {
    expect(pickMoments([0.2, 1.0, 3.6, 6.5, 9.5], [5.0, 8.7], 0, 10)).toEqual([0.2, 3.6, 6.5, 8.7])
  })

  it('from captions: zoom in, hold, out, as tagged scale keyframes on the clip', () => {
    const plan = planPunchIns(clip, { words })
    expect(plan.from).toBe('captions')
    expect(plan.moments).toEqual([0.2, 3.6, 6.5])
    const c = { ...clip, ...punchInUpdates(clip, plan.moments) }
    expect(hasPunchIns(c)).toBe(true)
    expect(propAt(c, 'scale', 0.2)).toBe(100)
    expect(propAt(c, 'scale', 0.2 + PUNCH.rampIn)).toBeCloseTo(115, 6)
    expect(propAt(c, 'scale', 1.5)).toBeCloseTo(115, 6)
    expect(propAt(c, 'scale', 3.5)).toBeCloseTo(100, 6) // out again before the next one
    expect(keyframesOf(c, 'scale')).toHaveLength(12)
    expect(keyframesOf(c, 'scale').every(k => k.tag === 'punch')).toBe(true)
    // Again: replaces, never doubles
    expect(keyframesOf({ ...c, ...punchInUpdates(c, plan.moments) }, 'scale')).toHaveLength(12)
    // Remove punch-ins: only those go, other keyframes stay
    const mixed = { ...c, keyframes: { ...c.keyframes, x: [{ t: 1, v: 5 }] } }
    expect(removePunchIns(mixed).keyframes).toEqual({ x: [{ t: 1, v: 5 }] })
  })

  it('a clip further along the timeline, and one at 2x, map words to the right clip time', () => {
    const later = { ...clip, timelinePosition: 5, startTime: 2, endTime: 12 }
    const shifted = words.map(w => ({ ...w, start: w.start + 5, end: w.end + 5 }))
    expect(planPunchIns(later, { words: shifted }).moments).toEqual([2.2, 5.6, 8.5])
    const fast = { ...clip, speed: 2, startTime: 0, endTime: 5 }
    expect(planPunchIns(fast, { words: words.filter(w => w.start < 5) }).moments).toEqual([0.2, 3.6])
  })

  it('without captions: phrase starts and loud jumps from the loudness curve', () => {
    const step = 0.02
    const db = new Float32Array(500).fill(-80) // 10 s
    const talk = (a, b, level) => { for (let i = Math.round(a / step); i < Math.round(b / step); i++) db[i] = level }
    talk(0.5, 2.5, -30)
    talk(4, 6, -30)
    talk(5, 5.1, -12) // a shout
    talk(7, 9, -30)
    const loudness = { db, step, duration: 10 }
    const found = loudnessMoments(loudness, 0, 10)
    expect(found.filter(f => f.strong).map(f => Math.round(f.at * 10) / 10)).toEqual([0.5, 4, 7])
    expect(found.some(f => !f.strong && Math.abs(f.at - 5) < 0.11)).toBe(true)
    const plan = planPunchIns({ ...clip, groupId: undefined }, { loudness })
    expect(plan.from).toBe('loudness')
    expect(plan.moments.map(m => Math.round(m * 10) / 10)).toEqual([0.5, 4, 7])
  })

  it('nothing to go on: no moments', () => {
    expect(planPunchIns(clip, {}).moments).toEqual([])
  })
})
