import { describe, it, expect } from 'vitest'
import { clampLayout, hasLayout, REMIX_LAYOUTS } from '../src/utils/remixLayout'

describe('remix layout boxes', () => {
  it('keeps a box inside the canvas and at least 5% big', () => {
    expect(clampLayout({ x: 0.9, y: -1, w: 0.5, h: 0.001 })).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.05 })
    expect(clampLayout({ x: 0.2, y: 0.2, w: 3, h: 3 })).toMatchObject({ x: 0, y: 0, w: 1, h: 1 })
  })
  it('knows when a clip has a layout', () => {
    expect(hasLayout({ layout: { x: 0, y: 0, w: 1, h: 0.5 } })).toBe(true)
    expect(hasLayout({})).toBe(false)
  })
  it('every remix mode defines its boxes inside the canvas', () => {
    for (const [mode, l] of Object.entries(REMIX_LAYOUTS)) {
      for (const box of Object.values(l).filter(b => b && typeof b === 'object' && 'w' in b)) {
        expect(box.x + box.w, mode).toBeLessThanOrEqual(1.0001)
        expect(box.y + box.h, mode).toBeLessThanOrEqual(1.0001)
      }
    }
  })
})
