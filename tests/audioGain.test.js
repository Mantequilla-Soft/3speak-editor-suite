import { describe, it, expect } from 'vitest'
import { clipGainAt, fadeFactor, clipVolume } from '../src/utils/audioGain'

const clip = (extra = {}) => ({ timelinePosition: 10, startTime: 0, endTime: 10, volume: 100, ...extra })

describe('audio gain in the preview', () => {
  it('volume 0..100 maps to 0..1; 0 is silent, unset is full, above 100 is capped', () => {
    expect(clipVolume({ volume: 0 })).toBe(0)
    expect(clipVolume({})).toBe(1)
    expect(clipVolume({ volume: 50 })).toBe(0.5)
    expect(clipVolume({ volume: 200 })).toBe(1)
  })
  it('linear fade in and fade out, like the render', () => {
    const c = clip({ fadeIn: 2, fadeOut: 4 })
    expect(fadeFactor(c, 10)).toBe(0)
    expect(fadeFactor(c, 11)).toBeCloseTo(0.5)
    expect(fadeFactor(c, 13)).toBe(1)
    expect(fadeFactor(c, 18)).toBeCloseTo(0.5)
    expect(fadeFactor(c, 20)).toBe(0)
  })
  it('works with the preview clip shape (timelineStart / timelineEnd) and outside the clip', () => {
    const c = { timelineStart: 0, timelineEnd: 4, fadeIn: 1, volume: 50 }
    expect(clipGainAt(c, 0.5)).toBeCloseTo(0.25)
    expect(clipGainAt(c, -1)).toBe(0)
    expect(clipGainAt(c, 9)).toBe(0.5)
  })
  it('fades longer than the clip are clamped to it', () => {
    expect(fadeFactor(clip({ fadeIn: 50 }), 15)).toBeCloseTo(0.5)
  })
  it('no fades: always the volume', () => {
    expect(clipGainAt(clip({ volume: 70 }), 12)).toBeCloseTo(0.7)
  })
})
