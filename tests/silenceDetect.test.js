import { describe, it, expect } from 'vitest'
import { planCuts } from '../src/utils/silenceDetect'

// 10 ms loudness windows: 1 s of talk, 1 s of silence, 1 s of talk
const loud = (sec, db) => Array(Math.round(sec * 100)).fill(db)
const loudness = { step: 0.01, db: [...loud(1, -10), ...loud(1, -60), ...loud(1, -10)] }
const opts = { from: 0, to: 3, thresholdDb: -40, minSilence: 0.4, minPart: 0.2, keepStartMs: 100, keepEndMs: 100 }
const parts = plan => (Array.isArray(plan) ? plan : plan.parts)

describe('silence cut planning', () => {
  it('"remove" cuts the pause out, keeping 100 ms on each side', () => {
    const p = parts(planCuts(loudness, { ...opts, mode: 'remove' }))
    expect(p).toHaveLength(2)
    expect(p[0].start).toBeCloseTo(0); expect(p[0].end).toBeCloseTo(1.1)
    expect(p[1].start).toBeCloseTo(1.9); expect(p[1].end).toBeCloseTo(3)
  })
  it('"split" keeps everything and splits in the pause', () => {
    const p = parts(planCuts(loudness, { ...opts, mode: 'split' }))
    expect(p).toHaveLength(2)
    expect(p[0].start).toBeCloseTo(0); expect(p[1].end).toBeCloseTo(3)
    expect(p[0].end).toBeGreaterThan(1); expect(p[1].start).toBeLessThan(2)
  })
  it('a pause shorter than minSilence is left alone', () => {
    const p = parts(planCuts(loudness, { ...opts, minSilence: 1.5, mode: 'remove' }))
    expect(p).toEqual([{ start: 0, end: 3 }])
  })
})
