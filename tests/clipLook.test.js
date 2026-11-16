import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  LOOK_PRESETS, LOOK_DEFAULTS, normalizeLook, applyPreset, matchPreset, gradeParams, ffmpegGradeFilter,
  fxParams, ffmpegFxFilter, svgFxPrimitives, svgFilterMarkup, vignetteFactor, vignetteImage
} from '../src/utils/clipLook'
import { colorParams, ffmpegColorFilter } from '../src/utils/clipColor'
import { renderExtras } from '../src/utils/renderExtras'
import { clipColorFilter } from '../src/components/ClipColorFilters'

describe('clip looks', () => {
  it('a look with nothing set is no look; values are clamped', () => {
    expect(normalizeLook(null)).toBeNull()
    expect(normalizeLook({ ...LOOK_DEFAULTS })).toBeNull()
    expect(normalizeLook({ blur: 250, split: -300, vignette: '12' })).toEqual({ split: -100, blur: 100, vignette: 12, sharpen: 0 })
  })

  it('has about ten presets, each recognised again after it is applied', () => {
    expect(LOOK_PRESETS.length).toBeGreaterThanOrEqual(9)
    expect(LOOK_PRESETS.length).toBeLessThanOrEqual(13)
    for (const p of LOOK_PRESETS) {
      const v = applyPreset(p.id)
      expect(matchPreset(v.color, v.look)).toBe(p.id)
    }
    expect(applyPreset('original')).toEqual({ color: null, look: null })
    expect(applyPreset('nope')).toBeNull()
  })

  it('a preset keeps the clip\'s own blur and sharpen, and an adjusted slider is no preset any more', () => {
    const v = applyPreset('noir', { blur: 20, sharpen: 30, vignette: 5 })
    expect(v.look).toMatchObject({ blur: 20, sharpen: 30, vignette: 45 })
    expect(v.color.saturation).toBe(-100)
    expect(matchPreset(v.color, v.look)).toBe('noir')
    expect(matchPreset({ ...v.color, contrast: v.color.contrast + 1 }, v.look)).toBeNull()
  })

  it('without a split tone the grade is exactly the colour sliders (old renders unchanged)', () => {
    const color = { warmth: 30, contrast: -10, saturation: 20 }
    expect(gradeParams(color, null)).toEqual(colorParams(color))
    expect(ffmpegGradeFilter(color, { blur: 40 })).toBe(ffmpegColorFilter(color))
    expect(ffmpegGradeFilter(null, null)).toBe('')
  })

  it('teal and orange: shadows lean blue, highlights lean red', () => {
    const p = gradeParams(null, { split: 100 })
    const at = (ch, v) => p.channels[ch].A * Math.pow(v, p.gamma) + p.channels[ch].O
    expect(at('b', 0)).toBeGreaterThan(at('r', 0))
    expect(at('r', 1)).toBeGreaterThan(at('b', 1))
    expect(ffmpegGradeFilter(null, { split: 100 })).toMatch(/^lutrgb=/)
  })

  it('effects become ffmpeg filters sized to the frame and the zoom', () => {
    expect(fxParams({ split: 50 })).toBeNull()
    expect(ffmpegFxFilter({ split: 50 }, { frameH: 1920 })).toBe('')
    const f = ffmpegFxFilter({ blur: 50, vignette: 100, sharpen: 100 }, { frameH: 1920, zoom: 2 })
    expect(f).toContain('convolution=')
    expect(f).toContain(`gblur=sigma=${0.01 * 1920 * 2}`)
    expect(f).toMatch(/format=rgb24,vignette=angle=1\.42/)
    // a layer with transparency keeps it around the vignette
    expect(ffmpegFxFilter({ vignette: 50 }, { frameH: 100, alpha: true, tag: 'z' })).toMatch(/alphaextract\[zm\].*\[zv\]\[zm\]alphamerge$/)
  })

  it('vignette: no change at the centre, darker towards the corners', () => {
    expect(vignetteFactor(1, 0)).toBe(1)
    expect(vignetteFactor(1, 1)).toBeLessThan(vignetteFactor(1, 0.5))
    expect(vignetteImage(1, 9 / 16)).toMatch(/^data:image\/svg\+xml/)
  })

  it('the preview filter chains the grade into blur, sharpen and the vignette mask', () => {
    const prims = svgFxPrimitives({ blur: 10, vignette: 40, sharpen: 20 }, 9 / 16)
    expect(prims.map(p => p.tag)).toEqual(['feOffset', 'feConvolveMatrix', 'feGaussianBlur', 'feComponentTransfer', 'feComposite', 'feImage', 'feComposite'])
    expect(prims[2].attrs.in).toBe('lk_sharp')
    expect(prims[6].attrs).toMatchObject({ in: 'lk_blur', in2: 'lk_vmask', operator: 'arithmetic', k1: '1' })
    const markup = svgFilterMarkup('f', { warmth: 20 }, { vignette: 40 }, 1)
    expect(markup).toMatch(/^<filter id="f"[^>]*primitiveUnits="objectBoundingBox"><feComponentTransfer>/)
  })

  it('a clip with only a look still gets the preview filter, and its look goes to the render', () => {
    const clip = { id: 'c1', type: 'video', look: { vignette: 30 } }
    expect(clipColorFilter(clip)).toBe('url(#clipfx-c1)')
    expect(clipColorFilter({ id: 'c2', type: 'video' })).toBeUndefined()
    expect(clipColorFilter({ id: 'c3', type: 'text', look: { blur: 10 } })).toBeUndefined()
    expect(renderExtras(clip).look).toEqual({ split: 0, blur: 0, vignette: 30, sharpen: 0 })
    expect(renderExtras({ type: 'video' })).toEqual({})
  })

  it('the preview and the render use the same file', () => {
    const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
    expect(read('backend/src/utils/clipLook.js')).toBe(read('src/utils/clipLook.js'))
  })
})
