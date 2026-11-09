import { describe, it, expect } from 'vitest'
import {
  SIZES, clampBox, moveLayer, resizeLayer, rotateLayer, squareWave, restack, stackOrder, toggleLayer, withPicture, pieceOf, canBeShort, audiogramsToPost
} from '../src/utils/audiogramLayers'

const V = SIZES.vertical
const layers = () => ({
  logo: { x: 290, y: 236, w: 500, h: 80, z: 5, on: true },
  cover: { x: 230, y: 380, w: 620, h: 620, z: 1, on: false },
  title: { x: 80, y: 520, w: 920, h: 420, z: 3, on: true },
  line: { x: 80, y: 960, w: 920, h: 64, z: 4, on: true },
  wave: { x: 90, y: 1120, w: 900, h: 360, z: 2, on: true }
})

describe('audiogram parts: move and resize', () => {
  it('moves, and its middle snaps to the middle line when close', () => {
    const r = moveLayer(layers(), 'title', 8, 20, V)
    expect(r.guide).toBe('x')
    expect(r.layers.title).toMatchObject({ x: 80, y: 540 })
    const far = moveLayer(layers(), 'title', 100, 0, V)
    expect(far.guide).toBe(null)
    expect(far.layers.title.x).toBe(180)
    expect(moveLayer(layers(), 'title', 8, 0, V, false).layers.title.x).toBe(88)
  })

  it('keeps at least 16 px of a part in the frame', () => {
    const r = moveLayer(layers(), 'title', -5000, 9000, V, false)
    expect(r.layers.title).toMatchObject({ x: -904, y: 1904 })
    expect(clampBox({ x: 0, y: 0, w: 2, h: 99999 }, V)).toMatchObject({ w: 16, h: 1920 })
  })

  it('the logo stays whole in the frame and at least 240 x 40', () => {
    expect(moveLayer(layers(), 'logo', -5000, 9000, V, false).layers.logo).toMatchObject({ x: 0, y: 1840, w: 500, h: 80 })
    expect(resizeLayer(layers(), 'logo', 'se', -9000, -9000, V, true).logo).toMatchObject({ w: 240, h: 40 })
  })

  it('resizes from any corner; the opposite corner stays put', () => {
    const se = resizeLayer(layers(), 'wave', 'se', 50, -60, V)
    expect(se.wave).toMatchObject({ x: 90, y: 1120, w: 950, h: 300 })
    const nw = resizeLayer(layers(), 'wave', 'nw', 40, 40, V)
    expect(nw.wave).toMatchObject({ x: 130, y: 1160, w: 860, h: 320 })
    expect(nw.wave.x + nw.wave.w).toBe(990)
  })

  it('a turned part grows along its own sides; its opposite corner stays put', () => {
    const turned = { ...layers(), wave: { ...layers().wave, r: 90 } }
    // turned a quarter: pulling down on the screen makes it wider
    const r = resizeLayer(turned, 'wave', 'se', 0, 100, V)
    expect(r.wave).toMatchObject({ w: 1000, h: 360, r: 90 })
    const corner = (b) => { const a = (b.r * Math.PI) / 180; const dx = -b.w / 2; const dy = -b.h / 2; return [Math.round(b.x + b.w / 2 + dx * Math.cos(a) - dy * Math.sin(a)), Math.round(b.y + b.h / 2 + dx * Math.sin(a) + dy * Math.cos(a))] }
    expect(corner(r.wave)).toEqual(corner(turned.wave))
  })

  it('turns: snaps to a quarter turn when close, to 15 degrees with Shift, -180..180', () => {
    expect(rotateLayer(layers(), 'title', 12).title.r).toBe(12)
    expect(rotateLayer(layers(), 'title', 88).title.r).toBe(90)
    expect(rotateLayer(layers(), 'title', 37, 15).title.r).toBe(30)
    expect(rotateLayer(layers(), 'title', 200).title.r).toBe(-160)
    expect(rotateLayer(layers(), 'title', -180).title.r).toBe(180)
  })

  it('a round waveform gets a square box around the same middle', () => {
    const r = squareWave(layers(), V).wave
    expect(r.w).toBe(r.h)
    expect(r.x + r.w / 2).toBe(540)
    expect(r.y + r.h / 2).toBe(1300)
  })

  it('keeps the shape with keepAspect (the picture card, Shift)', () => {
    const r = resizeLayer({ ...layers(), cover: { x: 0, y: 0, w: 600, h: 600, z: 1 } }, 'cover', 'se', 120, 10, V, true)
    expect(r.cover.w).toBe(r.cover.h)
    expect(r.cover.w).toBe(720)
  })
})

describe('audiogram parts: stacking', () => {
  it('lists front to back and steps a part forward or back', () => {
    expect(stackOrder(layers())).toEqual(['logo', 'line', 'title', 'wave', 'cover'])
    const fwd = restack(layers(), 'wave', 1)
    expect(stackOrder(fwd)).toEqual(['logo', 'line', 'wave', 'title', 'cover'])
    expect(new Set(Object.values(fwd).map(l => l.z)).size).toBe(5)
    expect(restack(layers(), 'logo', 1)).toEqual(layers())
    expect(restack(layers(), 'logo', -1)).toEqual(layers())
    expect(restack(layers(), 'line', 1)).toEqual(layers())
    // the logo in front, whatever its z was
    const low = { ...layers(), logo: { ...layers().logo, z: 0 } }
    expect(stackOrder(low)[0]).toBe('logo')
    expect(stackOrder(restack(low, 'cover', 1))[0]).toBe('logo')
  })

  it('hides and shows a part, never the logo', () => {
    expect(toggleLayer(layers(), 'logo').logo.on).toBe(true)
    expect(toggleLayer(layers(), 'line').line.on).toBe(false)
    expect(toggleLayer(toggleLayer(layers(), 'line'), 'line').line.on).toBe(true)
  })

  it('a picture: an untouched first arrangement becomes the picture one; a moved one keeps its boxes', () => {
    const plain = { vertical: layers() }
    const cover = { vertical: { ...layers(), cover: { x: 230, y: 380, w: 620, h: 620, z: 1, on: true }, title: { x: 80, y: 1050, w: 920, h: 280, z: 3, on: true } } }
    expect(withPicture(plain, { hasImage: true, plainDefaults: plain, coverDefaults: cover })).toEqual(cover)
    const moved = { vertical: { ...layers(), title: { ...layers().title, y: 700 } } }
    const out = withPicture(moved, { hasImage: true, plainDefaults: plain, coverDefaults: cover })
    expect(out.vertical.title.y).toBe(700)
    expect(out.vertical.cover.on).toBe(true)
    expect(withPicture(moved, { hasImage: false })).toBe(moved)
  })
})

describe('the piece and the Shorts', () => {
  it('the picked piece, kept inside the episode and to 2 minutes; else 30 s from the playhead', () => {
    expect(pieceOf({ start: 10, end: 50 }, 600, 0)).toEqual({ start: 10, end: 50 })
    expect(pieceOf({ start: 10, end: 400 }, 600, 0)).toEqual({ start: 10, end: 130 })
    expect(pieceOf({ start: 590, end: 700 }, 600, 0)).toEqual({ start: 590, end: 600 })
    expect(pieceOf(null, 600, 100)).toEqual({ start: 100, end: 130 })
    expect(pieceOf(null, 600, 590)).toEqual({ start: 570, end: 600 })
    expect(pieceOf(null, 20, 5)).toEqual({ start: 0, end: 20 })
    expect(pieceOf({ start: 40, end: null }, 600, 100)).toEqual({ start: 100, end: 130 })
  })

  it('only vertical ones up to 2 minutes, marked to post, go out as Shorts', () => {
    const list = [
      { id: 1, url: 'https://b/1.mp4', format: 'vertical', duration: 30, post: true, description: '  Hi  ', title: 'T' },
      { id: 2, url: 'https://b/2.mp4', format: 'square', duration: 30, post: true },
      { id: 3, url: 'https://b/3.mp4', format: 'vertical', duration: 30, post: false },
      { id: 4, url: 'https://b/4.mp4', format: 'vertical', duration: 121, post: true }
    ]
    expect(canBeShort(list[0])).toBe(true)
    expect(canBeShort(list[1])).toBe(false)
    expect(audiogramsToPost(list)).toEqual([{ url: 'https://b/1.mp4', description: 'Hi', title: 'T', duration: 30, width: 1080, height: 1920 }])
    expect(audiogramsToPost(null)).toEqual([])
  })
})
