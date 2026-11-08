// Audio added from a track's + menu: on that track, at the playhead.
import { describe, it, expect } from 'vitest'
import { fitAt, placeOnTrack, MIN_ROOM } from '../src/utils/placement.js'

const c = (id, at, len) => ({ id, timelinePosition: at, startTime: 0, endTime: len })

describe('fitAt', () => {
  const clips = [c('a', 0, 10), c('b', 60, 20)]
  it('an empty spot: right at the playhead, whole length when it fits', () => {
    expect(fitAt(clips, 20, 30)).toEqual({ position: 20, length: 30 })
    expect(fitAt([], 113, 180)).toEqual({ position: 113, length: 180 })
    expect(fitAt(clips, 100, 50)).toEqual({ position: 100, length: 50 }) // after the last clip
  })
  it('runs into the next clip: cut short where it starts', () => {
    expect(fitAt(clips, 50, 30)).toEqual({ position: 50, length: 10 })
  })
  it('a clip under the playhead (or no real room): null', () => {
    expect(fitAt(clips, 5, 3)).toBe(null)
    expect(fitAt(clips, 60, 3)).toBe(null) // the next clip starts right there
    expect(fitAt(clips, 60 - MIN_ROOM / 2, 3)).toBe(null)
    expect(fitAt(clips, 10, 3)).toEqual({ position: 10, length: 3 }) // just where a clip ends
  })
})

describe('placeOnTrack', () => {
  const tracks = [
    { id: 'v', type: 'audio', name: 'Voice', clips: [c('a', 0, 200)] },
    { id: 'm', type: 'audio', name: 'Music', music: true, clips: [c('intro', 0, 10)] },
    { id: 's', type: 'audio', name: 'SFX', sfx: true, clips: [] }
  ]
  const song = { id: 'new', startTime: 0, endTime: 180 }
  const make = (t) => ({ id: 'fresh', type: t.type, name: `${t.name} 2`, ...(t.music ? { music: true } : {}) })

  it('the screenshot case: Music track empty at 1:53, the song goes there on that track', () => {
    const out = placeOnTrack(tracks, 'm', song, 113, make)
    expect(out).toHaveLength(3)
    const placed = out[1].clips.find(x => x.id === 'new')
    expect(placed).toMatchObject({ timelinePosition: 113, startTime: 0, endTime: 180 })
  })

  it('taken at the playhead: a new track of the same kind right below, at the playhead', () => {
    const out = placeOnTrack(tracks, 'v', song, 113, make)
    expect(out.map(t => t.id)).toEqual(['v', 'fresh', 'm', 's'])
    expect(out[1].clips[0]).toMatchObject({ id: 'new', timelinePosition: 113, endTime: 180 })
    expect(out[0].clips).toHaveLength(1) // the voice track is untouched
  })

  it('a clip trimmed in its file keeps its in-point; the out-point follows the room', () => {
    const out = placeOnTrack([{ id: 't', type: 'audio', clips: [c('x', 20, 5)] }], 't', { id: 'n', startTime: 4, endTime: 30 }, 10, make)
    expect(out[0].clips[1]).toMatchObject({ timelinePosition: 10, startTime: 4, endTime: 14 })
  })

  it('an unknown track: null (the caller falls back)', () => {
    expect(placeOnTrack(tracks, 'gone', song, 0, make)).toBe(null)
  })
})
