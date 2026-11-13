// The recorders used to say "Camera access denied" for every getUserMedia
// failure (a busy camera, no camera, settings the camera can't do). openCamera
// retries once with plain settings, and mediaErrorMessage names the real cause.
import { describe, it, expect } from 'vitest'
import { openCamera, mediaErrorMessage } from '../src/utils/mediaAccess.js'

const fail = (name) => Object.assign(new Error(name), { name })

describe('openCamera', () => {
  it('asks for the front camera and the microphone first', async () => {
    const asked = []
    const stream = await openCamera({ getUserMedia: async (c) => { asked.push(c); return 'stream' } })
    expect(stream).toBe('stream')
    expect(asked).toEqual([{ video: { facingMode: 'user' }, audio: true }])
  })

  for (const name of ['OverconstrainedError', 'NotReadableError', 'AbortError']) {
    it(`tries again with plain settings after ${name}`, async () => {
      const asked = []
      const stream = await openCamera({ getUserMedia: async (c) => { asked.push(c); if (asked.length === 1) throw fail(name); return 'plain' } })
      expect(stream).toBe('plain')
      expect(asked[1]).toEqual({ video: true, audio: true })
    })
  }

  it('does not ask again after a real "no"', async () => {
    let calls = 0
    await expect(openCamera({ getUserMedia: async () => { calls++; throw fail('NotAllowedError') } })).rejects.toMatchObject({ name: 'NotAllowedError' })
    expect(calls).toBe(1)
  })
})

describe('mediaErrorMessage', () => {
  it('tells a busy camera apart from a blocked one and from none at all', () => {
    expect(mediaErrorMessage(fail('NotReadableError'))).toMatch(/busy in another app or tab/)
    expect(mediaErrorMessage(fail('NotAllowedError'))).toMatch(/blocked for this site/)
    expect(mediaErrorMessage(fail('NotFoundError'))).toMatch(/No camera or microphone found/)
    expect(mediaErrorMessage(fail('NotFoundError'), 'microphone')).toMatch(/No microphone found/)
  })

  it('names an unknown error instead of guessing', () => {
    expect(mediaErrorMessage(fail('WeirdError'))).toMatch(/\(WeirdError\)/)
    expect(mediaErrorMessage(fail('NotReadableError'))).not.toMatch(/denied/)
  })
})
