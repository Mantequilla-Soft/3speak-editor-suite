// Background removal without a green screen (person key): the shared matte
// module (same file as the backend's), the key settings, the segmenter's byte
// conversion, the render payload and drafts.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'

const PM = await import('../src/utils/personMask')
const { normalizeChromaKey, defaultChromaKey, getClipChromaKey } = await import('../src/utils/chromaKey')
const { confidenceToBytes, smoothInto } = await import('../src/utils/personSegmenter')
const { personKeyPayload, uploadPersonMasks } = await import('../src/utils/personRender')
const jobs = await import('../src/utils/personMaskJobs')
const { serializeProject } = await import('../src/hooks/useDrafts')

describe('person key settings', () => {
  it('is a chroma key mode with its own defaults and background', () => {
    const d = defaultChromaKey('person')
    expect(d).toEqual({ color: 'person', threshold: 0.5, softness: 0.3, background: { kind: 'none' } })
    const k = normalizeChromaKey(d)
    expect(k.mode).toBe('person')
    expect(k.background).toEqual({ kind: 'none', blur: 0.025, color: '#000000' })
    expect(normalizeChromaKey({ color: 'person', enabled: false })).toBe(null)
    expect(getClipChromaKey({ type: 'image', chromaKey: d })).toBe(null)
    expect(getClipChromaKey({ type: 'video', chromaKey: { ...d, maskUrl: 'blob:m' } }).maskUrl).toBe('blob:m')
    // old green screen clips are untouched
    expect(normalizeChromaKey({ color: 'green' }).mode).toBe('green')
  })

  it('alpha ramps between lo and hi exactly like the render lut', () => {
    const r = PM.personAlphaRange({ threshold: 0.5, softness: 0.3 })
    // the backend's lut: clip((val-lo)*255/(hi-lo),0,255)
    for (const m of [0, 89, 100, 128, 166, 200, 255]) {
      expect(PM.personAlpha(m, r)).toBe(Math.min(255, Math.max(0, Math.round((m - r.lo) * 255 / (r.hi - r.lo)))))
    }
  })

  it('the frontend and backend copies of the matte module are identical', () => {
    const a = readFileSync(new URL('../src/utils/personMask.js', import.meta.url), 'utf8')
    const b = readFileSync(new URL('../backend/src/utils/personMask.js', import.meta.url), 'utf8')
    expect(a).toBe(b)
  })
})

describe('matte payload and frames', () => {
  it('round-trips and picks the nearest frame', () => {
    const data = new Uint8Array(8 * 8 * 4).map((_, i) => Math.floor(i / 64) * 60)
    const p = PM.parseMaskPayload(PM.buildMaskPayload({ v: 1, w: 8, h: 8, fps: 15, start: 2, frames: 4 }, data))
    expect(p.header.start).toBe(2)
    expect(PM.maskFrame(p, PM.maskFrameIndex(p.header, 2.07))[0]).toBe(60)
    expect(PM.maskFrame(p, PM.maskFrameIndex(p.header, 100))[0]).toBe(180)
  })

  it('segmenter confidences become bytes; multi-class models use 1 - background', () => {
    const mask = (vals) => ({ getAsFloat32Array: () => Float32Array.from(vals) })
    const out = new Uint8Array(3)
    expect(confidenceToBytes([mask([0, 0.5, 1.2])], out)).toBe(true)
    expect([...out]).toEqual([0, 128, 255])
    confidenceToBytes([mask([1, 0.25, 0]), mask([0, 0.75, 1])], out)
    expect([...out]).toEqual([0, 191, 255])
    expect(confidenceToBytes([], out)).toBe(false)
    const cur = Uint8Array.from([100, 200])
    expect([...smoothInto(Uint8Array.from([0, 0]), cur)]).toEqual([75, 150])
  })
})

describe('render payload', () => {
  beforeEach(() => jobs._resetPersonMasks())

  it('carries the key and the server copy of the matte', () => {
    const key = normalizeChromaKey({ color: 'person', background: { kind: 'blur', blur: 0.04 } })
    expect(personKeyPayload(key, 'https://b/api/upload/files/m.gz')).toEqual({
      color: 'person', threshold: 0.5, softness: 0.3, maskUrl: 'https://b/api/upload/files/m.gz', background: { kind: 'blur', blur: 0.04, color: '#000000' }
    })
    expect(personKeyPayload(key, null).maskUrl).toBe(null)
  })

  it('uploads each local matte once, server URLs pass through', async () => {
    const toServer = vi.fn(async (u) => (u.startsWith('blob:') ? `https://b/api/upload/files/${u.slice(5)}.gz` : u))
    const tracks = [{ id: 'v', type: 'video', clips: [
      { id: 'a', type: 'video', url: 'blob:x', chromaKey: { color: 'person', maskUrl: 'blob:m1' } },
      { id: 'b', type: 'video', url: 'blob:y', chromaKey: { color: 'person', maskUrl: 'https://b/api/upload/files/m2.gz' } },
      { id: 'c', type: 'video', url: 'blob:z', chromaKey: { color: 'green' } }
    ] }]
    const urls = await uploadPersonMasks(tracks, toServer)
    expect([...urls]).toEqual([['a', 'https://b/api/upload/files/m1.gz'], ['b', 'https://b/api/upload/files/m2.gz']])
  })
})

describe('jobs', () => {
  it('a clip needs a matte only with the person key on and none yet; pieces of a source share a job', () => {
    const c = { id: 'a', type: 'video', url: 'blob:x', duration: 30, startTime: 0, endTime: 10, chromaKey: { color: 'person' } }
    expect(jobs.needsPersonMask(c)).toBe(true)
    expect(jobs.needsPersonMask({ ...c, chromaKey: { color: 'person', maskUrl: 'blob:m' } })).toBe(false)
    expect(jobs.needsPersonMask({ ...c, chromaKey: { color: 'green' } })).toBe(false)
    expect(jobs.personJobKey(c)).toBe(jobs.personJobKey({ ...c, id: 'b', startTime: 10, endTime: 20 }))
  })
})

describe('drafts', () => {
  it('a person key keeps its uploaded matte; a local one that did not upload is dropped (made again on open)', () => {
    const tracks = [{ id: 'v', type: 'video', clips: [
      { id: 'a', type: 'video', url: 'https://b/api/upload/files/a.mp4', startTime: 0, endTime: 2, chromaKey: { color: 'person', maskUrl: 'blob:m1', background: { kind: 'color', color: '#112233' } } },
      { id: 'b', type: 'video', url: 'https://b/api/upload/files/b.mp4', startTime: 0, endTime: 2, chromaKey: { color: 'person', maskUrl: 'blob:m2' } }
    ] }]
    const { state } = serializeProject(tracks, [], new Map([['blob:m1', 'https://b/api/upload/files/m1.gz']]))
    expect(state.tracks[0].clips[0].chromaKey).toEqual({ color: 'person', maskUrl: 'https://b/api/upload/files/m1.gz', background: { kind: 'color', color: '#112233' } })
    expect(state.tracks[0].clips[1].chromaKey).toEqual({ color: 'person' })
    expect(jobs.needsPersonMask(state.tracks[0].clips[1])).toBe(true)
  })
})

describe('speed', () => {
  it('a clip at another speed, or a still, makes its matte over the media seconds it shows', () => {
    expect(jobs.mediaRange({ startTime: 1, endTime: 3, speed: 2 })).toEqual([2, 6])
    expect(jobs.mediaRange({ startTime: 0, endTime: 5, freezeAt: 4 })).toEqual([4, 4])
    expect(jobs.mediaRange({ startTime: 1, endTime: 3 })).toEqual([1, 3])
  })
})
