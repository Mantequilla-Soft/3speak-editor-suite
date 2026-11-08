// Box select on the timeline and settings for several clips at once.
import { describe, it, expect } from 'vitest'
import { boxesTouch, clipIdsInBox, boxFrom, toggleInSelection, clipIdsInRange } from '../src/utils/marquee.js'
import { commonValue, sourcesOf, soundTargets } from '../src/utils/multiSelect.js'

describe('box select', () => {
  const clips = [
    { id: 'a', x: 0, y: 0, w: 50, h: 40 },
    { id: 'b', x: 60, y: 0, w: 50, h: 40 },
    { id: 'm', x: 0, y: 50, w: 200, h: 40 } // music track below
  ]

  it('a box picks every clip it touches, dragged either way', () => {
    expect(clipIdsInBox(boxFrom({ x: 120, y: 45 }, { x: 10, y: 10 }), clips)).toEqual(['a', 'b'])
    expect(clipIdsInBox(boxFrom({ x: 55, y: 5 }, { x: 58, y: 30 }), clips)).toEqual([])
    expect(clipIdsInBox(boxFrom({ x: 5, y: 5 }, { x: 70, y: 60 }), clips)).toEqual(['a', 'b', 'm'])
  })

  it('touching an edge counts', () => {
    expect(boxesTouch({ x: 50, y: 0, w: 5, h: 5 }, clips[0])).toBe(true)
    expect(boxesTouch({ x: 51, y: 0, w: 5, h: 5 }, clips[0])).toBe(false)
  })

  it('Shift-click adds a clip or takes it out', () => {
    expect(toggleInSelection(['a'], 'b')).toEqual(['a', 'b'])
    expect(toggleInSelection(['a', 'b'], 'a')).toEqual(['b'])
  })
})

describe('settings for several clips', () => {
  it('shows a value only when all clips share it', () => {
    expect(commonValue([150, 150])).toBe(150)
    expect(commonValue([100, 150])).toBeNull()
    expect(commonValue([])).toBeNull()
  })

  it('cleans each recording once, however many pieces it was cut into', () => {
    const pieces = [{ src: 'r1' }, { src: 'r1' }, { src: 'r2' }, { src: null }]
    expect(sourcesOf(pieces, c => c.src)).toEqual(['r1', 'r2'])
  })

  it('changes the sound of audio clips, and of a video through its linked audio clip', () => {
    const audio = { id: 'a1', type: 'audio' }
    const linked = { id: 'a2', type: 'audio' }
    const video = { id: 'v1', type: 'video' }
    const text = { id: 't1', type: 'text' }
    const targets = soundTargets([audio, video, text, linked], c => (c.id === 'v1' ? linked : null))
    expect(targets.map(c => c.id)).toEqual(['a1', 'a2'])
  })
})

describe('Shift-click: from the selected clip to the clicked one', () => {
  const c = (id, at, len) => ({ id, timelinePosition: at, startTime: 0, endTime: len })
  const tracks = [
    { id: 'v1', clips: [c('a', 0, 2), c('b', 2, 2), c('c', 4, 2), c('d', 8, 1)] },
    { id: 'v2', clips: [c('x', 1, 2), c('y', 6, 1)] },
    { id: 'm', clips: [c('m1', 0, 10)] }
  ]

  it('on one track: everything between, either way round', () => {
    expect(clipIdsInRange(tracks.slice(0, 1), 'a', 'c')).toEqual(['a', 'b', 'c'])
    expect(clipIdsInRange(tracks.slice(0, 1), 'c', 'a')).toEqual(['a', 'b', 'c'])
    expect(clipIdsInRange(tracks.slice(0, 1), 'b', 'd')).toEqual(['b', 'c', 'd'])
  })

  it('across tracks: the tracks in between and the time in between', () => {
    // a (track 1, 0-2) to y (track 2, 6-7): 0-7 on tracks 1 and 2, not the music below
    expect(clipIdsInRange(tracks, 'a', 'y').sort()).toEqual(['a', 'b', 'c', 'x', 'y'])
    // b (2-4) to x (1-3): 1-4 on tracks 1 and 2; a (0-2) overlaps it, c (4-6) only touches it
    expect(clipIdsInRange(tracks, 'b', 'x').sort()).toEqual(['a', 'b', 'x'])
  })

  it('without an anchor it is just the clicked clip', () => {
    expect(clipIdsInRange(tracks, null, 'c')).toEqual(['c'])
    expect(clipIdsInRange(tracks, 'gone', 'c')).toEqual(['c'])
    expect(clipIdsInRange(tracks, 'c', 'c')).toEqual(['c'])
    expect(clipIdsInRange(tracks, 'a', 'gone')).toEqual([])
  })
})
