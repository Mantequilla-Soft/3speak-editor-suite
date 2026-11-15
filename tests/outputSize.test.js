import { describe, it, expect } from 'vitest'
import { outputSize, OUTPUT_SIZES } from '../src/utils/outputSize'

describe('render output size', () => {
  it('Shorts render at 1080x1920', () => {
    expect(outputSize('9:16')).toEqual({ width: 1080, height: 1920 })
  })
  it('the other ratios are full HD too, and unknown ones fall back to 16:9', () => {
    expect(outputSize('16:9')).toEqual({ width: 1920, height: 1080 })
    expect(outputSize('4:3')).toEqual({ width: 1440, height: 1080 })
    expect(outputSize('1:1')).toEqual({ width: 1080, height: 1080 })
    expect(outputSize('auto')).toEqual({ width: 1920, height: 1080 })
  })
  it('every size has even sides (H.264 4:2:0) and is a copy', () => {
    for (const s of Object.values(OUTPUT_SIZES)) expect(s.width % 2 + s.height % 2).toBe(0)
    const a = outputSize('9:16'); a.width = 1
    expect(outputSize('9:16').width).toBe(1080)
  })
})
