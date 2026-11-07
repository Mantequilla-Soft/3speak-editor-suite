import { describe, it, expect } from 'vitest'
import { readEditorMode } from '../src/utils/editorMode'
import { maxSecondsFor, MAX_SHORT_SECONDS, MAX_AUDIO_SECONDS, limitText, limitAdjective, formatLength, MAX_TIMELINE_SECONDS } from '../src/utils/limits'

describe('editor mode', () => {
  it('audio only for ?mode=audio, video otherwise', () => {
    expect(readEditorMode('?compact=true&mode=audio')).toBe('audio')
    expect(readEditorMode('?mode=video')).toBe('video')
    expect(readEditorMode('?mode=AUDIO')).toBe('video')
    expect(readEditorMode('')).toBe('video')
  })
  it('the page limit follows the mode (tests run as the video editor)', () => {
    expect(maxSecondsFor('audio')).toBe(MAX_AUDIO_SECONDS)
    expect(maxSecondsFor('video')).toBe(MAX_SHORT_SECONDS)
    expect(MAX_TIMELINE_SECONDS).toBe(MAX_SHORT_SECONDS)
    expect(MAX_AUDIO_SECONDS).toBe(10800)
  })
  it('limit texts', () => {
    expect(limitText(120)).toBe('2 minutes')
    expect(limitText(60)).toBe('1 minute')
    expect(limitText(10800)).toBe('3 hours')
    expect(limitText(3600)).toBe('1 hour')
    expect(limitText(90)).toBe('90 seconds')
    expect(limitAdjective(10800)).toBe('3-hour')
    expect(limitAdjective(120)).toBe('2-minute')
  })
  it('lengths over an hour show hours', () => {
    expect(formatLength(65)).toBe('1:05')
    expect(formatLength(3725)).toBe('1:02:05')
    expect(formatLength(10800)).toBe('3:00:00')
  })
})
