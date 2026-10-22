import { describe, it, expect, beforeAll } from 'vitest'

let E
beforeAll(async () => {
  globalThis.window = { location: { origin: 'https://editor.example', search: '' } }
  E = await import('../src/adwizard/engine.js')
})

describe('Ad Wizard state -> engine doc', () => {
  it('uses the format size, both fonts, absolute upload URLs and derived glows', () => {
    const s = E.defaultState()
    s.format = 'portrait'
    s.brand.font = 'Inter'; s.brand.headFont = 'Syne'
    s.brand.logo = '/api/upload/files/logo.png'
    s.scenes = [{ id: 'a', type: 'heroSplit', duration: 3, lines: ['x'], image: { url: '/api/upload/files/p.jpg', scale: 1.4 } }]
    const meta = { TYPES: { heroSplit: { fields: [{ k: 'image', kind: 'image' }, { k: 'lines', kind: 'lines' }] } } }
    const d = E.toDoc(s, meta)
    expect([d.width, d.height]).toEqual([1080, 1920])
    expect(d.brand.fonts).toEqual(['Inter:wght@400;500;600;700;800;900', 'Syne:wght@400;500;600;700;800;900'])
    expect(d.brand.logo).toBe('https://editor.example/api/upload/files/logo.png')
    expect(d.scenes[0].image).toEqual({ url: 'https://editor.example/api/upload/files/p.jpg', scale: 1.4 })
    expect(d.scenes[0].id).toBeUndefined()
    expect(d.brand.colors.glow1).toMatch(/^rgba\(/)
  })
  it('an uploaded font replaces the Google font of the same name', () => {
    const s = E.defaultState()
    s.brand.headFont = 'Acme'; s.brand.fontFaces = [{ family: 'Acme', url: '/api/upload/files/a.woff2', weight: 800 }]
    const d = E.toDoc(s, { TYPES: {} })
    expect(d.brand.fonts.some(f => f.startsWith('Acme'))).toBe(false)
    expect(d.brand.fontFaces[0].url).toBe('https://editor.example/api/upload/files/a.woff2')
  })
})

describe('automatic sound effects', () => {
  const cues = [{ t: 1, kind: 'trans', scene: 1 }, { t: 1.5, kind: 'click', scene: 1, gain: -1 }, { t: 2, kind: 'trans', scene: 2 }, { t: 3, kind: 'nope', scene: 2 }]
  it('maps cues to the scene sound files, started early by each sound\'s peak', () => {
    const out = E.autoSfx(cues, { auto: true, gain: 0, removed: [] })
    expect(out.map(s => s.key)).toEqual(['trans:1:0', 'click:1:0', 'trans:2:1'])
    expect(out[0].url).toBe('https://editor.example/scenes/sfx/trans-1.wav')
    expect(out[2].url).toBe('https://editor.example/scenes/sfx/trans-2.wav')
    expect(out[0].at).toBeCloseTo(1 - 0.21)
    expect(out.every(s => s.volume >= 0 && s.volume <= 100)).toBe(true)
  })
  it('respects removed sounds, the level and the off switch', () => {
    expect(E.autoSfx(cues, { auto: true, gain: 0, removed: ['click:1:0'] }).map(s => s.key)).not.toContain('click:1:0')
    const quiet = E.autoSfx(cues, { auto: true, gain: -12, removed: [] })[0].volume
    const loud = E.autoSfx(cues, { auto: true, gain: 6, removed: [] })[0].volume
    expect(loud).toBeGreaterThan(quiet)
    expect(E.autoSfx(cues, { auto: false, gain: 0, removed: [] })).toEqual([])
  })
})

describe('URLs', () => {
  it('backend paths and frontend paths resolve against the right origin', () => {
    expect(E.absUrl('https://x.example/a.png')).toBe('https://x.example/a.png')
    expect(E.absUrl('/scenes/sfx/tick.wav')).toBe('https://editor.example/scenes/sfx/tick.wav')
    expect(E.absUrl(null)).toBe(null)
  })
})
