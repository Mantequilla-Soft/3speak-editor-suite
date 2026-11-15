// Shortcuts for heavy users (src/utils/shortcuts.js; hooks/useShortcuts.js runs them)
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { nextShuttleSpeed, stepFrames, shortcutAction, neighbourClip, clipOrder, clipLabel, trackAriaLabel, shortcutList, shortcutsFor } from '../src/utils/shortcuts.js'

const key = (k, mods = {}) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods })

describe('J / K / L shuttle', () => {
  it('L plays, again 2x, 4x, 8x (and stays at 8x)', () => {
    const seq = []
    let s = 0
    for (let i = 0; i < 5; i++) { s = nextShuttleSpeed(s, 'l'); seq.push(s) }
    expect(seq).toEqual([1, 2, 4, 8, 8])
  })
  it('J goes backward the same way; switching direction starts at 1x; K stops', () => {
    expect(nextShuttleSpeed(0, 'j')).toBe(-1)
    expect(nextShuttleSpeed(-1, 'J')).toBe(-2)
    expect(nextShuttleSpeed(4, 'j')).toBe(-1)
    expect(nextShuttleSpeed(-8, 'l')).toBe(1)
    expect(nextShuttleSpeed(4, 'k')).toBe(0)
  })
})

describe('frame steps', () => {
  it('one frame at 30 fps, on frame boundaries, never below 0', () => {
    expect(stepFrames(1, 1)).toBeCloseTo(1 + 1 / 30)
    expect(stepFrames(1.01, -1)).toBeCloseTo(29 / 30)
    expect(stepFrames(0, -1)).toBe(0)
    expect(stepFrames(2, 10)).toBeCloseTo(2 + 10 / 30)
  })
})

describe('which key does what', () => {
  it('maps the new keys, and leaves Ctrl / Cmd combinations to the old ones', () => {
    expect(shortcutAction(key('?', { shiftKey: true }))).toBe('sheet')
    expect(['j', 'k', 'l', 'L'].map(k => shortcutAction(key(k)))).toEqual(['shuttle-j', 'shuttle-k', 'shuttle-l', 'shuttle-l'])
    expect(shortcutAction(key(','))).toBe('frame-back')
    expect(shortcutAction(key('>', { shiftKey: true }))).toBe('frame-forward')
    expect(shortcutAction(key('Tab'))).toBe('clip-next')
    expect(shortcutAction(key('Tab', { shiftKey: true }))).toBe('clip-prev')
    expect(shortcutAction(key('Enter'))).toBe('clip-open')
    expect(shortcutAction(key('ArrowLeft', { altKey: true }))).toBe('clip-left')
    expect(shortcutAction(key('ArrowDown', { altKey: true }))).toBe('clip-down')
    expect(shortcutAction(key('ArrowLeft'))).toBe(null) // the playhead (App.jsx)
    expect(shortcutAction(key('z', { ctrlKey: true }))).toBe(null)
    expect(shortcutAction(key('l', { metaKey: true }))).toBe(null)
    expect(shortcutAction(key('J', { shiftKey: true }))).toBe(null)
  })

  it('App.jsx leaves Alt+arrows to the clip moves (the playhead takes plain arrows)', () => {
    const app = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
    expect(app).toMatch(/e\.key === 'ArrowLeft' && !e\.altKey/)
    expect(app).toMatch(/e\.key === 'ArrowRight' && !e\.altKey/)
  })
})

describe('moving between clips', () => {
  const c = (id, at, len = 2, extra = {}) => ({ id, type: 'video', name: id, timelinePosition: at, startTime: 0, endTime: len, ...extra })
  const tracks = [
    { id: 'a1', type: 'audio', name: 'Voice', clips: [c('v1', 0, 4, { type: 'audio' }), c('v2', 5, 4, { type: 'audio' })] },
    { id: 't1', type: 'video', clips: [c('b', 3), c('a', 0), c('c', 6)] },
    { id: 't2', type: 'video', clips: [] },
    { id: 't3', type: 'video', clips: [c('x', 4, 3)] }
  ]

  it('Tab order: tracks top to bottom (video first), each in time order', () => {
    expect(clipOrder(tracks).map(x => x.id)).toEqual(['a', 'b', 'c', 'x', 'v1', 'v2'])
    expect(neighbourClip(tracks, 'c', 'next')).toBe('x')
    expect(neighbourClip(tracks, 'x', 'prev')).toBe('c')
    expect(neighbourClip(tracks, 'v2', 'next')).toBe(null)
    expect(neighbourClip(tracks, null, 'next')).toBe('a')
    expect(neighbourClip(tracks, null, 'prev')).toBe('v2')
  })

  it('Alt+left / right stay on the track, Alt+up / down go to the nearest clip on the next track with clips', () => {
    expect(neighbourClip(tracks, 'b', 'left')).toBe('a')
    expect(neighbourClip(tracks, 'b', 'right')).toBe('c')
    expect(neighbourClip(tracks, 'c', 'right')).toBe(null)
    expect(neighbourClip(tracks, 'b', 'down')).toBe('x') // the empty track is skipped
    expect(neighbourClip(tracks, 'x', 'up')).toBe('b') // overlaps 5.5: b is 3-5, c 6-8: nearest middle
    expect(neighbourClip(tracks, 'x', 'down')).toBe('v2')
    expect(neighbourClip(tracks, 'a', 'up')).toBe(null)
    expect(neighbourClip([], 'a', 'next')).toBe(null)
  })
})

describe('screen readers', () => {
  it('clips and tracks have names that say what and where', () => {
    expect(clipLabel({ type: 'video', name: 'intro.mp4', timelinePosition: 3, startTime: 1, endTime: 6 }, { name: 'Video 1' })).toBe('Video clip intro.mp4 on Video 1, 0:03.0 to 0:08.0')
    expect(clipLabel({ type: 'text', text: 'Hello', timelinePosition: 65, duration: 5, endTime: 5 })).toBe('Text Hello, 1:05.0 to 1:10.0')
    expect(trackAriaLabel({ type: 'audio', name: 'Voice' })).toBe('Voice (audio track)')
    expect(trackAriaLabel({ type: 'audio', music: true })).toBe('Music track 1')
    expect(trackAriaLabel({ type: 'video' }, 1)).toBe('Video track 2')
  })

  it('the timeline marks up clips, tracks, ruler and playhead', () => {
    const src = fs.readFileSync(new URL('../src/components/Timeline.jsx', import.meta.url), 'utf8')
    expect(src).toMatch(/aria-roledescription="clip"/)
    expect(src).toMatch(/role="slider"[\s\S]{0,80}aria-label="Playhead"/)
    expect(src).toMatch(/className="timeline-content"\s+role="region"\s+aria-label="Timeline"/)
    expect((src.match(/aria-label=\{trackAriaLabel\(track, trackIndex\)\}/g) || []).length).toBe(2)
  })
})

describe('the ? sheet', () => {
  it('lists the old shortcuts too, and each editor only its own', () => {
    const all = shortcutList('Ctrl').flatMap(g => g.items.map(i => i.label))
    for (const l of ['Undo', 'Redo', 'Play / pause', 'Split the selected clip at the playhead', 'Close the gap at the playhead', 'Add a flag at the playhead', 'Zoom the timeline in / out', 'Full screen on / off', 'Select every clip']) expect(all).toContain(l)
    const audio = shortcutsFor('audio', 'Ctrl').flatMap(g => g.items.map(i => i.label))
    const video = shortcutsFor('video', 'Ctrl').flatMap(g => g.items.map(i => i.label))
    expect(audio).toContain('Add a chapter at the playhead')
    expect(audio).not.toContain('Add text at the playhead')
    expect(video).toContain('Add text at the playhead')
    expect(video).not.toContain('Add a chapter at the playhead')
  })
})
