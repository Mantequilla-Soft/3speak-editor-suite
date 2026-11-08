// Space everywhere except while typing; the playhead kept in drafts.
import { describe, it, expect } from 'vitest'
import { isTypingTarget } from '../src/utils/keyboard.js'
import { serializeProject, savedPlayhead } from '../src/hooks/useDrafts.js'

const el = (tagName, type, extra = {}) => ({ tagName, type: type || '', getAttribute: (n) => (n === 'type' ? (type ?? null) : null), ...extra })

describe('Space plays / pauses unless you are typing', () => {
  it('text fields and text areas keep Space', () => {
    expect(isTypingTarget(el('INPUT', 'text'))).toBe(true)
    expect(isTypingTarget(el('INPUT', null))).toBe(true) // <input> without a type is text
    expect(isTypingTarget(el('INPUT', 'number'))).toBe(true)
    expect(isTypingTarget(el('TEXTAREA'))).toBe(true)
    expect(isTypingTarget(el('DIV', null, { isContentEditable: true }))).toBe(true)
  })

  it('a slider, checkbox, dropdown or button just used in the settings does not', () => {
    for (const t of ['range', 'checkbox', 'radio', 'color', 'button']) expect(isTypingTarget(el('INPUT', t)), t).toBe(false)
    expect(isTypingTarget(el('SELECT'))).toBe(false)
    expect(isTypingTarget(el('BUTTON'))).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
  })
})

describe('the playhead in a draft', () => {
  const tracks = [{ id: 'v', type: 'audio', clips: [{ id: 'a', type: 'audio', url: 'https://x/api/upload/files/a.wav', timelinePosition: 2, startTime: 0, endTime: 10 }] }]

  it('is saved (ms precision), and left out at 0', () => {
    expect(serializeProject(tracks, [], new Map(), { mode: 'audio', playhead: 7.12345 }).state.playhead).toBe(7.123)
    expect('playhead' in serializeProject(tracks, [], new Map(), { mode: 'audio', playhead: 0 }).state).toBe(false)
    expect('playhead' in serializeProject(tracks, [], new Map(), { mode: 'audio' }).state).toBe(false)
  })

  it('reopens where it was, never past the end; old drafts start at 0', () => {
    expect(savedPlayhead({ tracks, playhead: 7.5 })).toBe(7.5)
    expect(savedPlayhead({ tracks, playhead: 99 })).toBe(12)
    expect(savedPlayhead({ tracks })).toBe(0)
    expect(savedPlayhead({ tracks, playhead: 'x' })).toBe(0)
    expect(savedPlayhead(null)).toBe(0)
  })
})
