import { describe, it, expect } from 'vitest'
import { normalizeColor, ffmpegColorFilter, COLOR_DEFAULTS } from '../src/utils/clipColor'

describe('clip colour', () => {
  it('neutral settings mean no colour change at all', () => {
    expect(normalizeColor(null)).toBeNull()
    expect(normalizeColor({ ...COLOR_DEFAULTS })).toBeNull()
  })
  it('a real change survives normalising and becomes an ffmpeg filter', () => {
    const c = normalizeColor({ ...COLOR_DEFAULTS, brightness: (COLOR_DEFAULTS.brightness ?? 0) + 20 })
    expect(c).not.toBeNull()
    const f = ffmpegColorFilter(c)
    expect(typeof f).toBe('string')
    expect(f.length).toBeGreaterThan(0)
  })
})
