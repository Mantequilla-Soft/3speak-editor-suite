// Speed, freeze frames and keyframes in the editor (utils/clipSpeed.js,
// keyframes.js, motionEdits.js, keyframePreview.js). The render
// side of the same maths is tested in backend/test/motion.test.mjs.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { sourceAt, clipTimeAt, timeMap, speedLabel, maxEndTime, rampUpdates } from '../src/utils/clipSpeed'
import { propAt, keyframeBase, relativeAt, normalizeKeyframes, keyframesOf } from '../src/utils/keyframes'
import {
  setClipSpeed, setClipRamp, insertFreezeFrame, retimeMapper, toggleKeyframe, setKeyframe, setKeyframeEase,
  routeAnimatedEdits, clearKeyframes, kenBurns, motionFields, mediaView, mediaPartsToClip, allKeyframeTimes, clipTimeAtPlayhead
} from '../src/utils/motionEdits'
import { mediaTimeAt, prerollTime, syncPlayback, layerKeyframeStyle, valueAtTime, keyframeGainAt } from '../src/utils/keyframePreview'

const video = (extra = {}) => ({ id: 'v1', type: 'video', name: 'badadib take', duration: 20, startTime: 2, endTime: 8, timelinePosition: 0, groupId: 'g1', ...extra })
const sound = (extra = {}) => ({ ...video(), id: 'a1', type: 'audio', ...extra })
const tracksOf = (v = video(), a = sound(), more = []) => [
  { id: 'tv', type: 'video', clips: [v, { id: 'v2', type: 'video', startTime: 0, endTime: 3, timelinePosition: 6 }] },
  { id: 'ta', type: 'audio', clips: [a, { id: 'a2', type: 'audio', startTime: 0, endTime: 3, timelinePosition: 6 }] },
  { id: 'tm', type: 'audio', music: true, clips: [{ id: 'm1', type: 'audio', startTime: 0, endTime: 20, timelinePosition: 0 }] },
  ...more
]
const find = (tracks, id) => tracks.flatMap(t => t.clips).find(c => c.id === id)

describe('shared with the render', () => {
  it('the frontend and backend copies are identical', () => {
    for (const f of ['clipSpeed.js', 'keyframes.js']) {
      expect(fs.readFileSync(`backend/src/utils/${f}`, 'utf8')).toBe(fs.readFileSync(`src/utils/${f}`, 'utf8'))
    }
  })

  it('a clip without the new fields plays exactly as before', () => {
    const c = video()
    expect(timeMap(c).kind).toBe('none')
    expect(sourceAt(c, 3.5)).toBe(3.5)
    expect(keyframeBase(c)).toBe(c)
    expect(motionFields(c)).toEqual({})
    expect(mediaView(c)).toBe(c)
    expect(speedLabel(c)).toBe('')
  })
})

describe('speed', () => {
  it('2x on a linked clip: video and sound both, half as long, the clips after it close up', () => {
    const next = setClipSpeed(tracksOf(), 'v1', 2)
    const v = find(next, 'v1'), a = find(next, 'a1')
    expect(v.speed).toBe(2)
    expect(a.speed).toBe(2)
    expect(v.endTime - v.startTime).toBe(3)
    expect([sourceAt(v, v.startTime), sourceAt(v, v.endTime)]).toEqual([2, 8]) // the same stretch of media
    expect(find(next, 'v2').timelinePosition).toBe(3)
    expect(find(next, 'a2').timelinePosition).toBe(3)
    expect(find(next, 'm1').timelinePosition).toBe(0) // another track stays
    expect(speedLabel(v)).toBe('2x')
  })

  it('slow motion pushes the next clips right, and back to 1x restores everything', () => {
    const slow = setClipSpeed(tracksOf(), 'v1', 0.5)
    expect(find(slow, 'v1').endTime - find(slow, 'v1').startTime).toBe(12)
    expect(find(slow, 'v2').timelinePosition).toBe(12)
    const back = setClipSpeed(slow, 'v1', 1)
    expect(find(back, 'v1')).toMatchObject({ startTime: 2, endTime: 8 })
    expect(find(back, 'v1').speed).toBeUndefined()
    expect(find(back, 'v2').timelinePosition).toBe(6)
  })

  it('a split clip keeps its speed in both halves (clip time is linear in timeline time)', () => {
    const v = { ...video(), ...setClipSpeed(tracksOf(), 'v1', 2).flatMap(t => t.clips).find(c => c.id === 'v1') }
    const mid = v.startTime + 1 // a split one second into the clip
    expect(sourceAt({ ...v, endTime: mid }, mid)).toBe(sourceAt({ ...v, startTime: mid }, mid))
    expect(sourceAt(v, mid)).toBe(4)
  })

  it('ramp presets keep the media and are remembered; Off goes back to normal speed', () => {
    const r = setClipRamp(tracksOf(), 'v1', 'hero')
    const v = find(r, 'v1')
    expect(timeMap(v)).toMatchObject({ kind: 'ramp', preset: 'hero' })
    expect(find(r, 'a1').speedRamp.preset).toBe('hero')
    expect(sourceAt(v, v.startTime)).toBeCloseTo(2, 6)
    expect(sourceAt(v, v.endTime)).toBeCloseTo(8, 6)
    expect(motionFields(v).speedRamp.preset).toBe('hero')
    const off = find(setClipRamp(r, 'v1', 'off'), 'v1')
    expect(timeMap(off).kind).toBe('none')
    expect(off.startTime).toBeCloseTo(2, 6)
    expect(off.endTime).toBeCloseTo(8, 6)
  })

  it('trims stop at the end of the media at any speed', () => {
    expect(maxEndTime({ ...video(), speed: 2 }, 20)).toBe(10)
    expect(maxEndTime({ ...video(), speed: 0.5 }, 20)).toBe(40)
    expect(maxEndTime({ ...video(), freezeAt: 3 }, 20)).toBe(600)
  })

  it('caption words follow a retimed clip', () => {
    const before = video({ timelinePosition: 1 })
    const after = { ...before, ...setClipSpeed(tracksOf(before), 'v1', 2).flatMap(t => t.clips).find(c => c.id === 'v1') }
    const map = retimeMapper(before, after)
    expect(map(0.5)).toBe(0.5) // before the clip
    expect(map(3)).toBe(2) // 2 s into it -> 1 s in at 2x
    expect(map(10)).toBe(7) // after it: 3 s earlier
  })

  it('Auto cut measures a sped-up clip in media seconds and its parts come back in clip time', () => {
    const v = { ...video(), speed: 2, startTime: 1, endTime: 4 }
    expect(mediaView(v)).toMatchObject({ startTime: 2, endTime: 8 })
    expect(mediaPartsToClip(v, [{ start: 2, end: 4 }])).toEqual([{ start: 1, end: 2 }])
  })
})

describe('freeze frames', () => {
  it('splits the clip and its sound, puts a still in between and makes room', () => {
    const r = insertFreezeFrame(tracksOf(), 'v1', 3, 2)
    const vids = r.tracks[0].clips
    const still = vids.find(c => c.freezeAt !== undefined)
    expect(still).toMatchObject({ type: 'video', startTime: 0, endTime: 2, timelinePosition: 3, freezeAt: 5, audioEnabled: false })
    expect(still.groupId).toBeUndefined()
    expect(find(r.tracks, 'v1')).toMatchObject({ endTime: 5 })
    const second = vids.find(c => c.id !== 'v1' && c.id !== still.id && c.id !== 'v2')
    expect(second).toMatchObject({ startTime: 5, endTime: 8, timelinePosition: 5 })
    const audioSecond = r.tracks[1].clips.find(c => c.groupId === second.groupId && c.type === 'audio')
    expect(audioSecond).toMatchObject({ startTime: 5, timelinePosition: 5 })
    expect(find(r.tracks, 'v2').timelinePosition).toBe(8)
    expect(find(r.tracks, 'a2').timelinePosition).toBe(8)
    expect(find(r.tracks, 'm1').timelinePosition).toBe(0)
    // New clips that need the File of the clip they came from
    expect(r.copies.map(([, from]) => from).sort()).toEqual(['a1', 'v1', 'v1'])
    expect(speedLabel(still)).toBe('Still')
    expect(timeMap(still)).toEqual({ kind: 'freeze', at: 5 })
  })

  it('a still of a sped-up, animated clip freezes the right frame and look', () => {
    const v = video({ speed: 2, startTime: 1, endTime: 4, keyframes: { scale: [{ t: 1, v: 100 }, { t: 3, v: 140 }] } })
    const r = insertFreezeFrame(tracksOf(v, sound({ speed: 2, startTime: 1, endTime: 4 })), 'v1', 1, 1)
    const still = r.tracks[0].clips.find(c => c.freezeAt !== undefined)
    expect(still.freezeAt).toBe(4) // clip time 2 at 2x
    expect(still.zoom).toBe(120)
    expect(still.keyframes).toBeUndefined()
  })

  it('nothing happens off the clip or on a still', () => {
    expect(insertFreezeFrame(tracksOf(), 'v1', 30, 1)).toBeNull()
    expect(insertFreezeFrame(tracksOf(video({ freezeAt: 1 })), 'v1', 1, 1)).toBeNull()
  })
})

describe('keyframes', () => {
  const clip = video({ startTime: 0, endTime: 4, zoom: 100 })
  it('the diamond adds a keyframe at the current value and removes it again', () => {
    const a = { ...clip, ...toggleKeyframe(clip, 'scale', 1) }
    expect(keyframesOf(a, 'scale')).toEqual([{ t: 1, v: 100 }])
    const b = { ...a, ...setKeyframe(a, 'scale', 3, 150) }
    expect(propAt(b, 'scale', 2)).toBe(125)
    const c = { ...b, ...toggleKeyframe(b, 'scale', 3.01) } // within a frame of it
    expect(keyframesOf(c, 'scale')).toHaveLength(1)
    const d = { ...c, ...toggleKeyframe(c, 'scale', 1) }
    expect(d.keyframes).toBeUndefined()
    expect(d.zoom).toBe(100) // keeps the value it had there
  })

  it('ease changes how it moves to the next keyframe', () => {
    let c = { ...clip, keyframes: { x: [{ t: 0, v: 0 }, { t: 2, v: 100 }] } }
    expect(propAt(c, 'x', 0.5)).toBe(25)
    c = { ...c, ...setKeyframeEase(c, 'x', 0, 'ease') }
    expect(propAt(c, 'x', 0.5)).toBeCloseTo(6.25, 6)
    expect(propAt(c, 'x', 1)).toBeCloseTo(50, 6)
  })

  it('editing an animated value from a slider or the preview sets the keyframe at the playhead', () => {
    const c = { ...clip, timelinePosition: 10, keyframes: { x: [{ t: 0, v: 0 }, { t: 4, v: 40 }] } }
    const u = routeAnimatedEdits(c, { positionX: 99, positionY: 5 }, 12)
    expect(u.positionX).toBeUndefined()
    expect(u.positionY).toBe(5) // not animated: the clip's own value
    expect(keyframesOf({ ...c, ...u }, 'x').map(k => [k.t, k.v])).toEqual([[0, 0], [2, 99], [4, 40]])
    expect(routeAnimatedEdits(c, { positionX: 1 }, 30)).toEqual({ positionX: 1 }) // playhead off the clip
    expect(routeAnimatedEdits(video(), { zoom: 120 }, 1)).toEqual({ zoom: 120 })
  })

  it('reference layout and the preview transform agree with the shared maths', () => {
    const c = { ...clip, type: 'image', positionX: 10, keyframes: { scale: [{ t: 0, v: 100 }, { t: 2, v: 200 }], rotation: [{ t: 0, v: 0 }, { t: 2, v: 90 }] } }
    const base = keyframeBase(c)
    expect(base.zoom).toBe(100)
    expect(base.rotation).toBe(0)
    const st = layerKeyframeStyle({ ...base, timelineStart: 0 }, 1)
    const r = relativeAt(c, 1)
    expect(st.prefix).toBe(`translate(${10 + r.dx}px, 0px) rotate(45deg) scale(1.5) translate(-10px, 0px)`)
    expect(st.opacity).toBe(1)
    expect(layerKeyframeStyle({ ...base, timelineStart: 0, layout: { x: 0, y: 0, w: 1, h: 0.5 } }, 1)).toBeNull()
    expect(valueAtTime({ ...base, timelineStart: 0 }, 'scale', 1)).toBe(150)
  })

  it('animated volume replaces the clip\'s own in the preview', () => {
    const a = sound({ startTime: 0, endTime: 4, volume: 30, keyframes: { volume: [{ t: 0, v: 100 }, { t: 4, v: 0 }] } })
    expect(keyframeBase(a).volume).toBe(100)
    expect(keyframeGainAt({ ...a, timelineStart: 0 }, 1)).toBeCloseTo(0.75, 6)
  })

  it('Ken Burns: one click, tagged, and a second click replaces it', () => {
    const img = { ...clip, type: 'image' }
    const a = { ...img, ...kenBurns(img, 'in') }
    expect(keyframesOf(a, 'scale').map(k => k.v)).toEqual([100, 120])
    const b = { ...a, ...kenBurns(a, 'pan', 400) }
    expect(keyframesOf(b, 'x').map(k => k.v)).toEqual([16, -16])
    expect(keyframesOf(b, 'scale').every(k => k.tag === 'kenburns')).toBe(true)
    expect(clearKeyframes(b, 'kenburns').keyframes).toBeUndefined()
  })

  it('keyframes go to the render as they are; diamonds list each moment once', () => {
    const c = { ...clip, keyframes: { x: [{ t: 2, v: 1 }, { t: 1, v: 0 }], scale: [{ t: 1, v: 120 }], junk: [1] } }
    expect(motionFields(c).keyframes).toEqual(normalizeKeyframes(c.keyframes))
    expect(Object.keys(motionFields(c).keyframes)).toEqual(['x', 'scale'])
    expect(allKeyframeTimes(c)).toEqual([1, 2])
  })
})

describe('preview playback', () => {
  it('media time, pre-roll and stills follow the time map', () => {
    const v = { ...video({ speed: 2, startTime: 1, endTime: 4, timelinePosition: 10 }), timelineStart: 10 }
    expect(mediaTimeAt(v, 11)).toBe(4)
    expect(prerollTime(v, 0.4)).toBeCloseTo(1.2, 6)
    expect(prerollTime({ ...v, startTime: 0.1 }, 0.4)).toBeNull()
    expect(prerollTime({ ...v, freezeAt: 2 }, 0.4)).toBeNull()
  })

  it('a playing element gets the clip\'s speed; a still stays paused on its frame', () => {
    const el = { paused: false, playbackRate: 1, readyState: 4, currentTime: 0, seeking: false, dataset: {}, pause() { this.paused = true } }
    const v = { ...video({ speed: 0.5, startTime: 4, endTime: 10 }), timelineStart: 0 }
    expect(syncPlayback(el, v, 1)).toBe(false)
    expect(el.playbackRate).toBe(0.5)
    expect(syncPlayback(el, { ...v, speed: undefined }, 1)).toBe(false)
    expect(el.playbackRate).toBe(1)
    const still = { ...v, freezeAt: 3 }
    expect(syncPlayback(el, still, 1)).toBe(true)
    expect(el.paused).toBe(true)
    expect(el.currentTime).toBe(3)
  })

  it('a ramp nudges a drifting element back onto its media time', () => {
    const v = { ...video(rampUpdates(video({ startTime: 0, endTime: 6 }), 'montage')), timelineStart: 0 }
    const el = { paused: false, playbackRate: 1, readyState: 4, currentTime: 0, seeking: false, dataset: {} }
    syncPlayback(el, v, 1, 5000)
    expect(el.currentTime).toBeCloseTo(mediaTimeAt(v, 1), 6)
    expect(el.playbackRate).toBeGreaterThan(1)
  })
})

describe('clip time at the playhead', () => {
  it('is null off the clip', () => {
    const c = video({ timelinePosition: 5 })
    expect(clipTimeAtPlayhead(c, 4)).toBeNull()
    expect(clipTimeAtPlayhead(c, 6)).toBe(3)
  })
})
