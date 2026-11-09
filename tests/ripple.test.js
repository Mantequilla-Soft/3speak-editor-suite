// Ripple closes the gap at the playhead on one track only.
import { describe, it, expect } from 'vitest'
import { gapAt, rippleTrackId, rippleTrack } from '../src/utils/ripple.js'

const c = (id, at, len, extra = {}) => ({ id, timelinePosition: at, startTime: 0, endTime: len, ...extra })
const pos = (tracks, id) => tracks.flatMap(t => t.clips).find(x => x.id === id).timelinePosition

describe('ripple', () => {
  // the screenshot: voice pieces on track 1 with a gap 24.5-26.5, music on track 2 until 27, more music later
  const tracks = () => [
    { id: 't1', clips: [c('a', 0, 24.5), c('b', 26.5, 5), c('d', 40, 2)] },
    { id: 't2', clips: [c('m', 0, 27), c('m2', 30, 10)] }
  ]

  it('finds the gap the playhead sits in; none on a clip or with nothing after', () => {
    expect(gapAt(tracks()[0], 25.5)).toEqual({ start: 24.5, end: 26.5 })
    expect(gapAt(tracks()[0], 10)).toBe(null)
    expect(gapAt(tracks()[1], 25.5)).toBe(null) // the music is under the playhead
    expect(gapAt(tracks()[0], 45)).toBe(null)
    expect(gapAt({ clips: [c('x', 5, 1)] }, 2)).toEqual({ start: 0, end: 5 }) // a gap at the start
  })

  it('closes the gap on track 1 only: the music on track 2 does not move', () => {
    const out = rippleTrack(tracks(), 't1', 25.5)
    expect(pos(out, 'b')).toBe(24.5)
    expect(pos(out, 'd')).toBe(38)
    expect(pos(out, 'a')).toBe(0)
    expect(pos(out, 'm')).toBe(0)
    expect(pos(out, 'm2')).toBe(30)
    expect(out[1]).toBe(tracks().length && out[1]) // same object: untouched
  })

  it('the track is the selected clip\'s; nothing selected: the topmost with a gap', () => {
    expect(rippleTrackId(tracks(), 25.5, null)).toBe('t1')
    expect(rippleTrackId(tracks(), 25.5, 'a')).toBe('t1')
    expect(rippleTrackId(tracks(), 25.5, 'm')).toBe(null) // the selected clip's track has no gap there
    expect(rippleTrackId(tracks(), 28, 'm2')).toBe('t2') // gap 27-30 on the music track
  })

  it('clips grouped with the ones that move go along (voices recorded together stay in sync)', () => {
    const ts = [
      { id: 'host', clips: [c('h1', 0, 2), c('h2', 5, 2, { groupId: 'g' })] },
      { id: 'guest', clips: [c('g2', 5, 2, { groupId: 'g' }), c('other', 9, 1)] }
    ]
    const out = rippleTrack(ts, 'host', 3)
    expect(pos(out, 'h2')).toBe(2)
    expect(pos(out, 'g2')).toBe(2) // its group mate moves too
    expect(pos(out, 'other')).toBe(9) // the rest of the guest track stays
  })
})
