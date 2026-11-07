import { describe, it, expect } from 'vitest'
import { applyAudioTemplate, removeAudioTemplate, slotFromClip, contentSpan, appliedRoles, hasSlots, slotLength, BED_DEFAULT_FADE_OUT } from '../src/utils/audioTemplate'

let n = 0
const newId = (p) => `${p}-${++n}`
const up = (name) => `https://editor.example/api/upload/files/${name}.mp3`
const slot = (name, len, extra = {}) => ({ url: up(name), name, duration: len + 5, startTime: 1, endTime: 1 + len, volume: 100, fadeIn: 0, fadeOut: 0, ...extra })
const clip = (id, pos, len, extra = {}) => ({ id, type: 'audio', name: id, url: `blob:${id}`, startTime: 0, endTime: len, timelinePosition: pos, volume: 100, ...extra })
const voice = (clips) => ({ id: 'voice', type: 'audio', name: 'Voice', clips })
const music = (clips = []) => ({ id: 'music', type: 'audio', name: 'Music', music: true, clips })
const template = (slots) => ({ slots })
const byRole = (tracks, role) => tracks.flatMap(t => t.clips.map(c => ({ ...c, track: t.id }))).filter(c => c.templateRole === role)
const content = (tracks) => tracks.flatMap(t => t.clips).filter(c => !c.templateRole)

describe('applyAudioTemplate', () => {
  const tracks = [voice([clip('rec1', 0, 60), clip('rec2', 60, 40)]), music()]

  it('puts the intro at 0:00 and moves the content right by its length', () => {
    const out = applyAudioTemplate(tracks, template({ intro: slot('intro', 8) }), { newId })
    const [intro] = byRole(out, 'intro')
    expect(intro).toMatchObject({ track: 'voice', timelinePosition: 0, startTime: 1, endTime: 9, url: up('intro'), serverUrl: up('intro') })
    expect(content(out).map(c => c.timelinePosition)).toEqual([8, 68])
  })

  it('puts the outro right after the content', () => {
    const out = applyAudioTemplate(tracks, template({ intro: slot('intro', 8), outro: slot('outro', 12) }), { newId })
    expect(byRole(out, 'outro')[0]).toMatchObject({ track: 'voice', timelinePosition: 108 })
  })

  it('lays the music bed under the content only, looped, faded out at the end', () => {
    const out = applyAudioTemplate(tracks, template({ intro: slot('intro', 8), bed: slot('bed', 30, { volume: 15, fadeIn: 1, loop: true }) }), { newId })
    const bed = byRole(out, 'bed')
    expect(bed.every(c => c.track === 'music')).toBe(true)
    expect(bed.map(c => c.timelinePosition)).toEqual([8, 38, 68, 98])
    expect(bed.map(c => +(c.endTime - c.startTime).toFixed(3))).toEqual([30, 30, 30, 10])
    expect(bed[0].fadeIn).toBe(1)
    expect(bed.slice(1).every(c => c.fadeIn === 0)).toBe(true)
    expect(bed.at(-1).fadeOut).toBe(BED_DEFAULT_FADE_OUT)
    expect(bed.every(c => c.volume === 15)).toBe(true)
  })

  it('a bed that does not loop plays once', () => {
    const out = applyAudioTemplate(tracks, template({ bed: slot('bed', 30, { loop: false, fadeOut: 4 }) }), { newId })
    const bed = byRole(out, 'bed')
    expect(bed).toHaveLength(1)
    expect(bed[0].fadeOut).toBe(4)
  })

  it('applying twice changes nothing (old template clips are replaced, not stacked)', () => {
    const t = template({ intro: slot('intro', 8), outro: slot('outro', 12), bed: slot('bed', 30) })
    const once = applyAudioTemplate(tracks, t, { newId })
    const twice = applyAudioTemplate(once, t, { newId })
    const shape = (ts) => ts.map(tr => tr.clips.map(c => [c.templateRole || c.id, c.timelinePosition, c.endTime - c.startTime]))
    expect(shape(twice)).toEqual(shape(once))
  })

  it('a shorter new intro moves the content back by the difference', () => {
    const once = applyAudioTemplate(tracks, template({ intro: slot('intro', 8) }), { newId })
    const again = applyAudioTemplate(once, template({ intro: slot('short', 3) }), { newId })
    expect(content(again).map(c => c.timelinePosition)).toEqual([3, 63])
    expect(byRole(again, 'intro')).toHaveLength(1)
  })

  it('removeAudioTemplate restores the content exactly', () => {
    const t = template({ intro: slot('intro', 8), outro: slot('outro', 12), bed: slot('bed', 30) })
    const back = removeAudioTemplate(applyAudioTemplate(tracks, t, { newId }))
    expect(back.map(tr => ({ id: tr.id, clips: tr.clips.map(c => [c.id, c.timelinePosition]) }))).toEqual([
      { id: 'voice', clips: [['rec1', 0], ['rec2', 60]] },
      { id: 'music', clips: [] }
    ])
  })

  it('uses a new music track when the music track is busy, and removes it again with the template', () => {
    const busy = [voice([clip('rec', 0, 50)]), music([clip('song', 10, 20)])]
    const out = applyAudioTemplate(busy, template({ bed: slot('bed', 30) }), { newId })
    const bedTrack = out.find(t => t.templateTrack)
    expect(bedTrack).toMatchObject({ music: true, name: 'Music bed' })
    expect(out.find(t => t.id === 'music').clips.map(c => c.id)).toEqual(['song'])
    expect(removeAudioTemplate(out).some(t => t.templateTrack)).toBe(false)
  })

  it('makes a voice track when there is none', () => {
    const out = applyAudioTemplate([music()], template({ intro: slot('intro', 5) }), { newId })
    expect(out[0]).toMatchObject({ type: 'audio', name: 'Voice' })
    expect(out[0].clips[0].templateRole).toBe('intro')
  })

  it('no content yet: intro and outro back to back, no bed', () => {
    const out = applyAudioTemplate([voice([]), music()], template({ intro: slot('i', 5), outro: slot('o', 4), bed: slot('b', 30) }), { newId })
    expect(byRole(out, 'outro')[0].timelinePosition).toBe(5)
    expect(byRole(out, 'bed')).toHaveLength(0)
  })

  it('clips on music tracks the creator placed move with the content', () => {
    const t = [voice([clip('rec', 0, 30)]), music([clip('sting', 29, 2)])]
    const out = applyAudioTemplate(t, template({ intro: slot('i', 5) }), { newId })
    expect(out.find(tr => tr.id === 'music').clips.find(c => c.id === 'sting').timelinePosition).toBe(34)
  })

  it('does not change the input', () => {
    const copy = JSON.parse(JSON.stringify(tracks))
    applyAudioTemplate(tracks, template({ intro: slot('i', 5), bed: slot('b', 10) }), { newId })
    expect(tracks).toEqual(copy)
  })

  it('appliedRoles lists what is on the timeline', () => {
    const out = applyAudioTemplate(tracks, template({ outro: slot('o', 4), bed: slot('b', 10) }), { newId })
    expect(appliedRoles(out)).toEqual(['outro', 'bed'])
    expect(appliedRoles(tracks)).toEqual([])
  })
})

describe('slotFromClip', () => {
  it('keeps an uploaded clip with its range, volume and fades', () => {
    const c = clip('Part 2 · My intro', 0, 10, { serverUrl: up('x'), startTime: 2, endTime: 9, duration: 20, volume: 80, fadeIn: 0.5 })
    expect(slotFromClip(c, 'intro')).toEqual({ url: up('x'), name: 'My intro', duration: 20, startTime: 2, endTime: 9, volume: 80, fadeIn: 0.5, fadeOut: 0 })
    expect(slotFromClip(c, 'bed').loop).toBe(true)
  })
  it('refuses a clip that is not uploaded yet, or not audio', () => {
    expect(slotFromClip(clip('a', 0, 5), 'intro')).toBeNull()
    expect(slotFromClip({ ...clip('v', 0, 5), type: 'video', serverUrl: up('v') }, 'intro')).toBeNull()
    expect(slotFromClip({ ...clip('h', 0, 5), serverUrl: 'https://evil.example/a.mp3' }, 'intro')).toBeNull()
  })
})

describe('helpers', () => {
  it('contentSpan ignores template clips and music tracks', () => {
    expect(contentSpan([voice([clip('a', 4, 10), { ...clip('i', 0, 4), templateRole: 'intro' }]), music([clip('m', 0, 99)])])).toEqual({ start: 4, end: 14 })
    expect(contentSpan([voice([]), music()])).toBeNull()
  })
  it('hasSlots / slotLength', () => {
    expect(hasSlots({ slots: {} })).toBe(false)
    expect(hasSlots({ slots: { outro: slot('o', 1) } })).toBe(true)
    expect(hasSlots(null)).toBe(false)
    expect(slotLength(slot('x', 7))).toBe(7)
    expect(slotLength(null)).toBe(0)
  })
})
