import { describe, it, expect } from 'vitest'
import { MAX_TIMELINE_SECONDS, getTimelineEnd, isOverTimelineLimit, formatLength, formatBytes } from '../src/utils/limits'

const clip = (pos, start, end) => ({ timelinePosition: pos, startTime: start, endTime: end })

describe('timeline limits', () => {
  it('measures the end of the last clip on any track', () => {
    expect(getTimelineEnd([{ clips: [clip(0, 0, 10)] }, { clips: [clip(5, 2, 20)] }])).toBe(23)
    expect(getTimelineEnd([])).toBe(0)
  })
  it('allows exactly the limit (float drift tolerated) and refuses more', () => {
    expect(isOverTimelineLimit([{ clips: [clip(0, 0, MAX_TIMELINE_SECONDS + 0.005)] }])).toBe(false)
    expect(isOverTimelineLimit([{ clips: [clip(0, 0, MAX_TIMELINE_SECONDS + 1)] }])).toBe(true)
  })
  it('formats lengths and sizes', () => {
    expect(typeof formatLength(125)).toBe('string')
    expect(formatLength(125)).toMatch(/2/)
    expect(typeof formatBytes(2 * 1024 ** 3)).toBe('string')
  })
})
