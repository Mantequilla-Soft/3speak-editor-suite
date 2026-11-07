// Browser recordings (MediaRecorder WebM) report Infinity as their duration.
// These helpers find the real one, or fall back to the recorder's clock, and
// pick a format the browser can record (Safari: audio/mp4 only).
import { describe, it, expect } from 'vitest'
import { isUsableDuration, pickDuration, pickRecorderType, recordingExtension, finiteDuration } from '../src/utils/mediaDuration.js'
import { rmsLevel, bucketLevels } from '../src/utils/voiceGraph.js'

// a stand-in media element: Infinity until seeked past the end
function fakeElement(realDuration) {
  const listeners = {}
  return {
    duration: Infinity,
    _t: 0,
    get currentTime() { return this._t },
    set currentTime(v) {
      this._t = v
      if (v > 1e100 && realDuration != null) {
        setTimeout(() => { this.duration = realDuration; (listeners.durationchange || []).forEach(f => f()) }, 5)
      }
    },
    addEventListener(e, f) { (listeners[e] ||= []).push(f) },
    removeEventListener(e, f) { listeners[e] = (listeners[e] || []).filter(x => x !== f) },
  }
}

describe('media duration', () => {
  it('only finite, positive durations count', () => {
    expect(isUsableDuration(3.2)).toBe(true)
    for (const d of [Infinity, NaN, 0, -1, null, undefined]) expect(isUsableDuration(d)).toBe(false)
  })

  it('falls back to the hint, never to Infinity', () => {
    expect(pickDuration(Infinity, 3.4)).toBe(3.4)
    expect(pickDuration(5, 3.4)).toBe(5)
    expect(pickDuration(NaN, undefined)).toBeNull()
  })

  it('finds the real length of a recording by seeking past its end, then goes back to the start', async () => {
    const el = fakeElement(7.25)
    expect(await finiteDuration(el)).toBe(7.25)
    expect(el.currentTime).toBe(0)
  })

  it('gives up (null) when the length never shows', async () => {
    expect(await finiteDuration(fakeElement(null), 30)).toBeNull()
  })
})

describe('recorder format', () => {
  it('prefers WebM/Opus, takes audio/mp4 where that is all there is (Safari)', () => {
    expect(pickRecorderType(() => true)).toBe('audio/webm;codecs=opus')
    expect(pickRecorderType(t => t === 'audio/mp4')).toBe('audio/mp4')
    expect(pickRecorderType(() => false)).toBe('')
    expect(pickRecorderType(() => { throw new Error('no') })).toBe('')
  })

  it('names the file after its format', () => {
    expect(recordingExtension('audio/webm;codecs=opus')).toBe('webm')
    expect(recordingExtension('audio/mp4;codecs=mp4a.40.2')).toBe('m4a')
    expect(recordingExtension('audio/ogg')).toBe('ogg')
    expect(recordingExtension('')).toBe('webm')
  })
})

describe('voice graph', () => {
  it('maps loudness to 0..1 (silence 0, full scale 1)', () => {
    expect(rmsLevel(new Float32Array(512))).toBe(0)
    expect(rmsLevel(new Float32Array(512).fill(1))).toBe(1)
    const quiet = rmsLevel(new Float32Array(512).fill(0.01)) // -40 dB
    expect(quiet).toBeCloseTo(1 / 3, 2)
  })

  it('squeezes a long take into the width, keeping the peaks', () => {
    const levels = Array.from({ length: 1000 }, (_, i) => (i === 503 ? 0.9 : 0.1))
    const b = bucketLevels(levels, 100)
    expect(b).toHaveLength(100)
    expect(b[50]).toBe(0.9)
    expect(Math.max(...b.filter((_, i) => i !== 50))).toBe(0.1)
  })
})
