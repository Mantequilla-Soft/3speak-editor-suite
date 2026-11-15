import { describe, it, expect, afterEach } from 'vitest'
import { readProjectAspect, isShortAspect, cleanAspect, aspectValue, canvasCss, postFormat, MAX_VIDEO_SECONDS } from '../src/utils/projectFormat'
import * as limits from '../src/utils/limits'
import { exportSizes, nearestAspect, reframeForRender, EXPORT_ASPECTS } from '../src/utils/exportAs'
import { sampleTimes, pickFace, detectTiles, mergeDetections, MAX_SAMPLES } from '../src/utils/faceTrack'
import { reframeBox, smoothPath, centreAt } from '../src/utils/reframe'

describe('project shape', () => {
  it('comes from ?aspect= or ?format=, else a Short', () => {
    expect(readProjectAspect('?aspect=16:9')).toBe('16:9')
    expect(readProjectAspect('?aspect=1:1&mode=video')).toBe('1:1')
    expect(readProjectAspect('?format=landscape')).toBe('16:9')
    expect(readProjectAspect('?format=classic')).toBe('4:3')
    expect(readProjectAspect('?format=square')).toBe('1:1')
    expect(readProjectAspect('?aspect=21:9')).toBe('9:16')
    expect(readProjectAspect('')).toBe('9:16')
  })
  it('only 9:16 is a Short; unknown shapes are cleaned to one', () => {
    expect(isShortAspect('9:16')).toBe(true)
    expect(isShortAspect('16:9')).toBe(false)
    expect(cleanAspect('x')).toBe('9:16')
    expect(aspectValue('4:3')).toBeCloseTo(4 / 3)
  })
  it('the preview canvas is the largest box of the shape', () => {
    expect(canvasCss('9:16')).toEqual({ w: 'min(100cqw, 56.25cqh)', h: 'min(100cqh, 177.7778cqw)' })
    expect(canvasCss('16:9')).toEqual({ w: 'min(100cqw, 177.7778cqh)', h: 'min(100cqh, 56.25cqw)' })
  })
  it('tells 3Speak the shape and length', () => {
    expect(postFormat('16:9', 312.3456)).toEqual({ aspect: '16:9', short: false, durationSec: 312.346 })
    expect(postFormat('9:16')).toEqual({ aspect: '9:16', short: true })
  })
})

describe('the length limit follows the shape', () => {
  afterEach(() => limits.setProjectLimit('9:16'))
  it('Shorts 2 minutes, everything else 10 minutes', () => {
    expect(limits.maxSecondsFor('video', '9:16')).toBe(120)
    expect(limits.maxSecondsFor('video', '16:9')).toBe(MAX_VIDEO_SECONDS)
    expect(MAX_VIDEO_SECONDS).toBe(600)
    expect(limits.maxSecondsFor('audio', '16:9')).toBe(3 * 60 * 60)
  })
  it('the live limit, its text and the timeline check change with the project', () => {
    const clip = { timelinePosition: 0, startTime: 0, endTime: 300 }
    expect(limits.isOverTimelineLimit([{ clips: [clip] }])).toBe(true)
    limits.setProjectLimit('16:9')
    expect(limits.MAX_TIMELINE_SECONDS).toBe(600)
    expect(limits.MAX_TIMELINE_TEXT).toBe('10 minutes')
    expect(limits.RENDER_NOUN).toBe('A video')
    expect(limits.isOverTimelineLimit([{ clips: [clip] }])).toBe(false)
    expect(limits.isOverTimelineLimit([{ clips: [{ ...clip, endTime: 601 }] }])).toBe(true)
    limits.setProjectLimit('9:16')
    expect(limits.MAX_TIMELINE_SECONDS).toBe(120)
    expect(limits.RENDER_NOUN).toBe('A short')
  })
})

describe('Export as', () => {
  it('knows the shape the preview shows', () => {
    expect(nearestAspect(1080 / 1920)).toBe('9:16')
    expect(nearestAspect(640 / 360)).toBe('16:9')
    expect(nearestAspect(1)).toBe('1:1')
    expect(EXPORT_ASPECTS).toEqual(['9:16', '1:1', '16:9', '4:3'])
  })
  it('the shape on screen goes as measured; another keeps text the same size to the shorter side', () => {
    expect(exportSizes('16:9', 640, 360)).toEqual({ outputWidth: 1920, outputHeight: 1080, previewWidth: 640, previewHeight: 360 })
    // a 9:16 preview 360 wide renders 1080 wide: x3. As 16:9 the shorter side (1080) is the same: still x3
    const s = exportSizes('16:9', 360, 640)
    expect(s.outputWidth / s.previewWidth).toBeCloseTo(3, 1)
    expect(s).toMatchObject({ outputWidth: 1920, outputHeight: 1080 })
    // a 16:9 preview 640 wide renders 1920 wide (x3); as 9:16 its 1080 wide frame is the shorter side: x3 again
    const v = exportSizes('9:16', 640, 360)
    expect(v.outputWidth / v.previewWidth).toBeCloseTo(3, 1)
  })
  it('reframes only footage on video tracks, and only in another shape', () => {
    const clip = { type: 'video', reframe: { path: [[0, 0.3, 0.5]], aspect: 1.78 } }
    expect(reframeForRender(clip, 'video', false)).toBe(null)
    expect(reframeForRender(clip, 'video', true).path).toEqual([[0, 0.3, 0.5]])
    expect(reframeForRender({ type: 'video' }, 'video', true)).toEqual({ path: [], offsetX: 0, offsetY: 0, aspect: null })
    expect(reframeForRender({ type: 'video', zoom: 150 }, 'video', true)).toBe(null)
    expect(reframeForRender({ type: 'text' }, 'video', true)).toBe(null)
  })
})

describe('face tracking', () => {
  it('looks at a few frames a second, fewer on long clips', () => {
    expect(sampleTimes(2, 4)).toEqual([2, 2.25, 2.5, 2.75, 3, 3.25, 3.5, 3.75])
    expect(sampleTimes(0, 3600).length).toBeLessThanOrEqual(MAX_SAMPLES)
    expect(sampleTimes(5, 5)).toEqual([])
  })
  it('follows the biggest face, but stays with the one it had when two are alike', () => {
    const box = (x, y, w, h, score = 0.9) => ({ boundingBox: { originX: x, originY: y, width: w, height: h }, categories: [{ score }] })
    const big = pickFace([box(10, 10, 20, 20), box(60, 10, 40, 40)], 100, 100)
    expect(big.cx).toBeCloseTo(0.8)
    const stay = pickFace([box(10, 10, 36, 36), box(60, 10, 40, 40)], 100, 100, { cx: 0.25, cy: 0.3 })
    expect(stay.cx).toBeCloseTo(0.28)
    expect(pickFace([box(0, 0, 10, 10, 0.2)], 100, 100)).toBe(null)
    expect(pickFace([], 100, 100)).toBe(null)
  })
  it('a wide frame is also looked at in overlapping squares, a face found twice counts once', () => {
    expect(detectTiles(480, 480)).toEqual([{ x: 0, y: 0, w: 480, h: 480 }])
    const t = detectTiles(480, 270)
    expect(t.length).toBe(4)
    expect(t[1]).toEqual({ x: 0, y: 0, w: 270, h: 270 })
    expect(t[3]).toEqual({ x: 210, y: 0, w: 270, h: 270 })
    expect(detectTiles(270, 480)[2]).toEqual({ x: 0, y: 105, w: 270, h: 270 })
    const d = (x, score) => ({ boundingBox: { originX: x, originY: 0, width: 50, height: 50 }, categories: [{ score }] })
    const m = mergeDetections([[d(100, 0.6)], [d(105, 0.9), d(300, 0.8)]])
    expect(m.map(x => x.boundingBox.originX)).toEqual([105, 300])
  })
  it('the preview box puts the face where the render does', () => {
    const path = smoothPath([{ t: 0, cx: 0.8, cy: 0.5 }, { t: 1, cx: 0.8, cy: 0.5 }])
    expect(centreAt({ path }, 0.5).cx).toBeCloseTo(0.8, 2)
    const box = reframeBox({ path, aspect: 16 / 9 }, 0.5, 9 / 16)
    // window 1/3.16 of the width, its middle on the face: (0.8 * 3.16 - 0.5) / 2.16
    expect(box.panX).toBeCloseTo((0.8 * 3.1605 - 0.5) / 2.1605, 2)
    expect(box).toMatchObject({ x: 0, y: 0, w: 1, h: 1, full: true })
  })
})

describe('drafts keep the shape', async () => {
  const { serializeProject } = await import('../src/hooks/useDrafts')
  const tracks = [{ id: 'v', type: 'video', clips: [{ id: 'c', type: 'video', url: 'https://x/a.mp4', startTime: 0, endTime: 5, reframe: { path: [[0, 0.3, 0.4]], aspect: 1.78, offsetX: 0.1 } }] }]
  it('a landscape project says so, a Short and the audio editor do not', () => {
    expect(serializeProject(tracks, [], new Map(), { aspect: '16:9' }).state.aspect).toBe('16:9')
    expect(serializeProject(tracks, [], new Map(), { aspect: '9:16' }).state.aspect).toBeUndefined()
    expect(serializeProject(tracks, [], new Map(), { mode: 'audio', aspect: '16:9' }).state.aspect).toBeUndefined()
  })
  it('a clip keeps its face path', () => {
    expect(serializeProject(tracks, [], new Map(), {}).state.tracks[0].clips[0].reframe).toEqual(tracks[0].clips[0].reframe)
  })
})
