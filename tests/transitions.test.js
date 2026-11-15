import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  TRANSITION_TYPES, normalizeTransition, trackCuts, trackTransitions, transitionPlan, clipExtent, heldMediaTime,
  transitionState, transitionAudio, rampGain, ffmpegTransition, ffmpegRampVolume, splitPair, videoFades, nextClipOf
} from '../src/utils/transitions'
import { withTransitions, mediaTimeAt, holdTransitionFrame, transitionCss, withAudioCrossfades } from '../src/utils/previewTransitions'
import { renderExtras } from '../src/utils/renderExtras'
import { transitionUpdate, transitionTarget } from '../src/components/TransitionControls'

const v = (id, pos, len, extra = {}) => ({ id, type: 'video', name: id, startTime: 2, endTime: 2 + len, duration: 20, timelinePosition: pos, ...extra })
const tracksWith = (type, duration = 1, extra = {}) => [
  { id: 'v1', type: 'video', clips: [v('a', 0, 3, { groupId: 'ga', transition: { type, duration, to: 'b' }, ...extra }), v('b', 3, 3, { groupId: 'gb' })] },
  { id: 'a1', type: 'audio', clips: [
    { id: 'aa', type: 'audio', startTime: 2, endTime: 5, duration: 20, timelinePosition: 0, groupId: 'ga' },
    { id: 'ab', type: 'audio', startTime: 2, endTime: 5, duration: 20, timelinePosition: 3, groupId: 'gb' }
  ] }
]

describe('transitions: what applies where', () => {
  it('normalises type and length, and needs the next clip id', () => {
    expect(normalizeTransition({ type: 'crossfade', duration: 9, to: 'b' })).toEqual({ type: 'crossfade', duration: 1.5, to: 'b' })
    expect(normalizeTransition({ type: 'crossfade', duration: 0.01, to: 'b' }).duration).toBe(0.2)
    expect(normalizeTransition({ type: 'wobble', to: 'b' })).toBeNull()
    expect(normalizeTransition({ type: 'zoom' })).toBeNull()
    expect(TRANSITION_TYPES.map(t => t.id)).toEqual(['crossfade', 'dissolve', 'slideleft', 'slideright', 'slideup', 'zoom', 'whip'])
  })

  it('applies only between touching clips on one track, and only into the clip it names', () => {
    const [track] = tracksWith('crossfade')
    expect(trackTransitions(track)).toEqual([{ from: 'a', to: 'b', type: 'crossfade', half: 0.5, cut: 3 }])
    // a gap: no transition
    const gap = { ...track, clips: [track.clips[0], { ...track.clips[1], timelinePosition: 3.5 }] }
    expect(trackTransitions(gap)).toEqual([])
    expect(trackCuts(gap)).toEqual([])
    // another clip there now (e.g. b was deleted and c moved up): no transition
    const other = { ...track, clips: [track.clips[0], { ...track.clips[1], id: 'c' }] }
    expect(trackTransitions(other)).toEqual([])
    expect(trackCuts(other).length).toBe(1)
    // text clips take none
    const text = { ...track, clips: [track.clips[0], { ...track.clips[1], type: 'text' }] }
    expect(trackCuts(text)).toEqual([])
    expect(nextClipOf(track, 'a').id).toBe('b')
    expect(nextClipOf(track, 'b')).toBeNull()
  })

  it('never takes more than half of either clip; hidden tracks have none', () => {
    const t = tracksWith('slideleft', 1.5)
    t[0].clips[1] = { ...t[0].clips[1], endTime: 2.4 }
    expect(trackTransitions(t[0])[0].half).toBe(0.2)
    expect(transitionPlan([{ ...t[0], visible: false }]).size).toBe(0)
  })

  it('overlap: the incoming clip shows half the length early on its first frame, the outgoing one late on its last', () => {
    const plan = transitionPlan(tracksWith('crossfade'))
    const a = tracksWith('crossfade')[0].clips[0], b = tracksWith('crossfade')[0].clips[1]
    expect(clipExtent(plan.get('a'))).toEqual({ head: 0, tail: 0.5 })
    expect(clipExtent(plan.get('b'))).toEqual({ head: 0.5, tail: 0 })
    expect(heldMediaTime(b, plan.get('b'), 2.7)).toBe(2)
    expect(heldMediaTime(b, plan.get('b'), 3.1)).toBeNull()
    expect(heldMediaTime(a, plan.get('a'), 3.2)).toBeCloseTo(5 - 1 / 30)
    // a dip to black needs no overlap
    expect(clipExtent(transitionPlan(tracksWith('dissolve')).get('b'))).toEqual({ head: 0, tail: 0 })
  })
})

describe('transitions: how a clip looks during one', () => {
  const at = (type, id, t) => {
    const tracks = tracksWith(type)
    const plan = transitionPlan(tracks)
    return transitionState(tracks[0].clips.find(c => c.id === id), plan.get(id), t)
  }
  it('crossfade: the incoming clip fades in over the outgoing one', () => {
    expect(at('crossfade', 'b', 2.5).opacity).toBe(0)
    expect(at('crossfade', 'b', 3).opacity).toBeCloseTo(0.5)
    expect(at('crossfade', 'b', 3.5).opacity).toBe(1)
    expect(at('crossfade', 'a', 3.2).opacity).toBe(1)
  })
  it('dip to black: down before the cut, up after it', () => {
    expect(at('dissolve', 'a', 2.75).brightness).toBeCloseTo(0.5)
    expect(at('dissolve', 'a', 3).brightness).toBe(0)
    expect(at('dissolve', 'b', 3).brightness).toBe(0)
    expect(at('dissolve', 'b', 3.5).brightness).toBe(1)
  })
  it('slides move both clips by a whole frame, the zoom grows, the whip blurs in the middle', () => {
    expect(at('slideleft', 'a', 3).dx).toBeCloseTo(-0.5)
    expect(at('slideleft', 'b', 3).dx).toBeCloseTo(0.5)
    expect(at('slideright', 'b', 2.5).dx).toBeCloseTo(-1)
    expect(at('slideup', 'b', 3.5).dy).toBeCloseTo(0)
    expect(at('zoom', 'a', 3.5).scale).toBeCloseTo(1.5)
    expect(at('zoom', 'b', 2.5).scale).toBeCloseTo(1.25)
    expect(at('whip', 'a', 3).blur).toBeGreaterThan(0)
    expect(at('whip', 'a', 2.52).blur).toBe(0)
  })
  it('fades in and out of a video clip are opacity ramps', () => {
    const c = v('f', 10, 4, { fadeIn: 1, fadeOut: 2 })
    expect(transitionState(c, null, 10).opacity).toBe(0)
    expect(transitionState(c, null, 10.5).opacity).toBeCloseTo(0.5)
    expect(transitionState(c, null, 12).opacity).toBe(1)
    expect(transitionState(c, null, 13).opacity).toBeCloseTo(0.5)
    expect(videoFades({ type: 'video', startTime: 0, endTime: 2, fadeIn: 9 }).fadeIn).toBe(2)
    expect(videoFades({ type: 'text', startTime: 0, endTime: 2, fadeIn: 1 }).fadeIn).toBe(0)
  })
})

describe('transitions: sound', () => {
  it('the linked sound crossfades, using the media past the cut', () => {
    const { ramps, pieces } = transitionAudio(tracksWith('slideleft'))
    expect(ramps.get('aa')).toEqual({ t0: 2.5, g0: 1, t1: 3.5, g1: 0 })
    expect(ramps.get('ab')).toEqual({ t0: 2.5, g0: 0, t1: 3.5, g1: 1 })
    expect(pieces).toEqual([
      { id: 'aa~xfade-tail', of: 'aa', startTime: 5, endTime: 5.5, timelinePosition: 3, ramp: ramps.get('aa') },
      { id: 'ab~xfade-head', of: 'ab', startTime: 1.5, endTime: 2, timelinePosition: 2.5, ramp: ramps.get('ab') }
    ])
    expect(rampGain(ramps.get('aa'), 3)).toBeCloseTo(0.5)
    expect(rampGain(null, 3)).toBe(1)
  })
  it('no media past the cut: no extra piece; a muted track does not take part', () => {
    const t = tracksWith('crossfade')
    t[1].clips[0] = { ...t[1].clips[0], duration: 5 }
    t[1].clips[1] = { ...t[1].clips[1], startTime: 0, endTime: 3 }
    expect(transitionAudio(t).pieces).toEqual([])
    expect(transitionAudio([t[0], { ...t[1], muted: true }]).ramps.size).toBe(0)
  })
  it('the render ramps the volume in the timeline\'s seconds', () => {
    expect(ffmpegRampVolume({ t0: 2.5, g0: 1, t1: 3.5, g1: 0 }, 3)).toBe("volume='max(0,min(1,1+-1*min(1,max(0,((t+3)-2.5)/1))))':eval=frame")
  })
})

describe('transitions: the render filters', () => {
  const tx = (type, id) => {
    const tracks = tracksWith(type)
    const plan = transitionPlan(tracks)
    return ffmpegTransition(tracks[0].clips.find(c => c.id === id), plan.get(id), { frameH: 1920, fps: 30, start: id === 'b' ? 2.5 : 0 })
  }
  it('nothing for a clip without transition or fades', () => {
    expect(ffmpegTransition(v('x', 0, 2), null, { frameH: 1920 })).toEqual({ filters: [], x: null, y: null })
  })
  it('alpha fades, dips, slides, zoom and whip', () => {
    expect(tx('crossfade', 'b').filters).toEqual(['format=yuva420p', 'fade=t=in:st=2.5:d=1:alpha=1'])
    expect(tx('crossfade', 'a').filters).toEqual([])
    expect(tx('dissolve', 'a').filters).toEqual(['fade=t=out:st=2.5:d=0.5'])
    expect(tx('dissolve', 'b').filters).toEqual(['fade=t=in:st=3:d=0.5'])
    expect(tx('slideleft', 'b').x).toMatch(/^W\*\(1-/)
    expect(tx('slideup', 'a').y).toMatch(/^-H\*/)
    expect(tx('zoom', 'a').filters[0]).toMatch(/^perspective=.*sense=destination:eval=frame.*enable='between\(t,2\.5,3\.5\)'$/)
    expect(tx('whip', 'a').filters.filter(f => f.startsWith('gblur=')).length).toBe(3)
  })
  it('fades of a video clip go into the render payload with its transition', () => {
    const c = v('a', 0, 3, { fadeIn: 0.5, transition: { type: 'zoom', duration: 0.7, to: 'b' } })
    expect(renderExtras(c)).toEqual({ fadeIn: 0.5, transition: { type: 'zoom', duration: 0.7, to: 'b' } })
    expect(renderExtras({ type: 'text', fadeIn: 1, startTime: 0, endTime: 2 })).toEqual({})
  })
})

describe('transitions: editing', () => {
  it('a split keeps the fades at the outer ends and hands the transition to the second half', () => {
    const [a, b] = splitPair({ id: 'a', fadeIn: 1, fadeOut: 1, transition: { type: 'zoom', to: 'n' } }, { id: 'b', fadeIn: 1, fadeOut: 1, transition: { type: 'zoom', to: 'n' } })
    expect(a).toEqual({ id: 'a', fadeIn: 1, fadeOut: 0 })
    expect(b).toEqual({ id: 'b', fadeIn: 0, fadeOut: 1, transition: { type: 'zoom', to: 'n' } })
  })
  it('the picker writes the transition on the outgoing clip, None takes it off', () => {
    const tracks = tracksWith('crossfade')
    const next = transitionTarget(tracks, tracks[0].clips[0])
    expect(next.id).toBe('b')
    expect(transitionTarget(tracks, tracks[0].clips[1])).toBeNull()
    expect(transitionUpdate(next, 'whip', 0.8)).toEqual({ transition: { type: 'whip', duration: 0.8, to: 'b' } })
    expect(transitionUpdate(next, null)).toEqual({ transition: null })
  })
})

describe('transitions: preview', () => {
  const list = (tracks) => tracks[0].clips.map(c => ({ ...c, timelineStart: c.timelinePosition, timelineEnd: c.timelinePosition + c.endTime - c.startTime }))
  it('the clip lists overlap at the cut and media time holds there', () => {
    const tracks = tracksWith('crossfade')
    const [a, b] = withTransitions(list(tracks), tracks)
    expect([a.timelineStart, a.timelineEnd, b.timelineStart, b.timelineEnd]).toEqual([0, 3.5, 2.5, 6])
    expect(mediaTimeAt(b, 2.7)).toBe(2)
    expect(mediaTimeAt(b, 4)).toBe(3)
    expect(mediaTimeAt(a, 1)).toBe(3)
    expect(mediaTimeAt({ startTime: 1, timelineStart: 4 }, 5)).toBe(2)
    const el = { paused: false, readyState: 4, seeking: false, currentTime: 2.4, pause() { this.paused = true } }
    expect(holdTransitionFrame(b, el, 2.7)).toBe(true)
    expect(el).toMatchObject({ paused: true, currentTime: 2 })
    expect(holdTransitionFrame(b, el, 3.2)).toBe(false)
    // no transitions: the same list back
    const plain = list([{ ...tracks[0], clips: tracks[0].clips.map(c => ({ ...c, transition: null })) }])
    expect(withTransitions(plain, [{ id: 'v1', type: 'video', clips: plain }])).toBe(plain)
  })
  it('the layer CSS moves, scales, darkens and blurs on top of the clip\'s own', () => {
    const tracks = tracksWith('slideleft')
    const [, b] = withTransitions(list(tracks), tracks)
    const css = transitionCss(b, 3, 640, { transform: 'scale(1.2)', filter: 'url(#f)', opacity: 0.8 }, { w: 'W', h: 'H' })
    expect(css.transform).toBe('translate(calc(W * 0.5000), calc(H * 0.0000)) scale(1.2)')
    expect(css.filter).toBe('url(#f)')
    expect(css.opacity).toBeCloseTo(0.8)
    const wt = tracksWith('whip')
    const [wa] = withTransitions(list(wt), wt)
    expect(transitionCss(wa, 3, 1000, {}, { w: 'W', h: 'H' }).filter).toMatch(/^blur\(12\.00px\)$/)
  })
  it('the linked sound gets its ramp and the pieces past the cut', () => {
    const tracks = tracksWith('crossfade')
    const audio = tracks[1].clips.map(c => ({ ...c, timelineStart: c.timelinePosition, timelineEnd: c.timelinePosition + 3 }))
    const out = withAudioCrossfades(audio, tracks)
    expect(out.length).toBe(4)
    expect(out.find(c => c.id === 'aa~xfade-tail')).toMatchObject({ startTime: 5, endTime: 5.5, timelineStart: 3, timelineEnd: 3.5, fadeIn: 0, fadeOut: 0 })
  })
})

it('the preview and the render use the same transitions file', () => {
  const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
  expect(read('backend/src/utils/transitions.js')).toBe(read('src/utils/transitions.js'))
})
